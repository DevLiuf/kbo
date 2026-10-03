const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { iterDates, parseArgs } = require("./ml-utils");
const { readRows, eligibleExamples, calibratedProbability, evaluateRows, validateRange, inRange } = require("../lib/logistic");
const { trainModel } = require("./train-logistic");
const { buildExamples } = require("./build-training-examples");

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[,\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function calibrationSummary(rows) {
  const groups = new Map();
  for (const row of rows) {
    const lower = Math.min(9, Math.floor(row.maxWinProbability * 10)) / 10;
    const bin = `${lower.toFixed(1)}-${(lower + 0.1).toFixed(1)}`;
    if (!groups.has(bin)) groups.set(bin, []);
    groups.get(bin).push(row);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([bin, games]) => {
    const avgConfidence = mean(games.map((row) => row.maxWinProbability));
    const hitRate = mean(games.map((row) => Number(row.predictionHit)));
    return { bin, games: games.length, avgConfidence, hitRate, calibrationGap: avgConfidence - hitRate };
  });
}

async function walkForward(inputRows, options, temporaryDirectory) {
  const from = options.from;
  const to = options.to || from;
  if (!from) throw new Error("Usage: walk-forward-eval.js --from=YYYYMMDD [--to=YYYYMMDD] [--input=path]");
  validateRange(from, to);
  for (const name of ["baseUrl", "retryCount", "retryDelayMs"]) {
    if (options[name] !== undefined) throw new Error(`--${name} was removed: walk-forward evaluates local archives without network requests`);
  }
  if (options.keepFinalModel === true || options.keepFinalModel === "true") {
    throw new Error("keepFinalModel is unsupported: offline walk-forward never replaces the production model");
  }
  const rows = eligibleExamples(inputRows);
  const trainFrom = options.trainFrom || rows[0]?.gameDate;
  validateRange(trainFrom, from);
  const minExamples = Number(options.minExamples ?? 30);
  if (!Number.isInteger(minExamples) || minExamples < 1) throw new Error("minExamples must be a positive integer");
  const perGame = [];
  const perDay = [];
  const skippedEvalDays = [];
  for (const evalDate of iterDates(from, to)) {
    const evalRows = rows.filter((row) => row.gameDate === evalDate);
    if (!evalRows.length) { skippedEvalDays.push({ evalDate, reason: "No stored eligible decisive examples" }); continue; }
    const priorRows = rows.filter((row) => inRange(row, trainFrom) && row.gameDate < evalDate);
    if (priorRows.length < minExamples) { skippedEvalDays.push({ evalDate, reason: "Insufficient prior examples", samples: priorRows.length }); continue; }
    let model;
    try {
      model = trainModel(priorRows, { epochs: options.epochs, lr: options.lr, l2: options.l2,
        holdoutDays: options.holdoutDays, calibrationDays: options.calibrationDays,
        version: `walk-forward-${evalDate}` });
    } catch (error) { skippedEvalDays.push({ evalDate, reason: error.message }); continue; }
    const temporaryModelPath = path.join(temporaryDirectory, `${evalDate}.json`);
    await fs.writeFile(temporaryModelPath, JSON.stringify(model), "utf8");
    const trainTo = priorRows[priorRows.length - 1].gameDate;
    const dayMetrics = evaluateRows(model, evalRows);
    perDay.push({ evalDate, trainFrom, trainTo, ...dayMetrics, trainingRange: model.trainingRange,
      calibrationRange: model.calibrationRange, validationRange: model.validationRange });
    for (const row of evalRows) {
      const homeWinProbability = calibratedProbability(model, row);
      const awayWinProbability = 1 - homeWinProbability;
      const predictionHit = (homeWinProbability >= 0.5 ? 1 : 0) === row.labelHomeWin;
      perGame.push({
        evalDate, trainFrom, trainTo, gameId: row.gameId, gameKey: row.gameKey,
        homeTeam: row.homeTeam, awayTeam: row.awayTeam, homeWinProbability, awayWinProbability,
        maxWinProbability: Math.max(homeWinProbability, awayWinProbability),
        predictedWinner: homeWinProbability >= 0.5 ? row.homeTeam : row.awayTeam,
        actualWinner: row.labelHomeWin === 1 ? row.homeTeam : row.awayTeam,
        predictionHit, actualHomeScore: row.homeScore, actualAwayScore: row.awayScore,
        logLoss: -(row.labelHomeWin * Math.log(homeWinProbability) + (1 - row.labelHomeWin) * Math.log(awayWinProbability)),
        brier: (homeWinProbability - row.labelHomeWin) ** 2,
        over90: Math.max(homeWinProbability, awayWinProbability) >= 0.9, modelVersion: model.version,
        featureSchemaVersion: model.featureSchemaVersion,
      });
    }
  }
  const over90 = perGame.filter((row) => row.over90);
  return { perGame, summary: {
    scope: "offline-logistic-only", range: { evalFrom: from, evalTo: to, trainFrom },
    config: { holdoutDays: Number(options.holdoutDays ?? 1), calibrationDays: Number(options.calibrationDays ?? 1), minExamples },
    overall: { games: perGame.length, accuracy: mean(perGame.map((row) => Number(row.predictionHit))),
      logLoss: mean(perGame.map((row) => row.logLoss)), brier: mean(perGame.map((row) => row.brier)) },
    overconfidence90: { games: over90.length, share: perGame.length ? over90.length / perGame.length : null,
      hitRate: mean(over90.map((row) => Number(row.predictionHit))), avgConfidence: mean(over90.map((row) => row.maxWinProbability)),
      logLoss: mean(over90.map((row) => row.logLoss)), brier: mean(over90.map((row) => row.brier)) },
    calibrationByConfidenceBin: calibrationSummary(perGame), perDay, skippedEvalDays,
  } };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input || path.join(process.cwd(), "data", "training_examples.kbo.ndjson");
  let rows;
  let sourceSummary;
  if (args.snapshots || args.results) {
    const snapshots = args.snapshots || path.join(process.cwd(), "data", "prediction_snapshots.ndjson");
    const results = args.results || path.join(process.cwd(), "data", "game_results.kbo.ndjson");
    const built = buildExamples(await readRows(snapshots), await readRows(results));
    rows = built.examples;
    sourceSummary = built.summary;
  } else { rows = await readRows(input); }
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "kbo-walk-forward-"));
  let result;
  try { result = await walkForward(rows, args, temporaryDirectory); }
  finally { await fs.rm(temporaryDirectory, { recursive: true, force: true }); }
  if (sourceSummary) result.summary.source = sourceSummary;
  const outDir = args.outDir || path.join(process.cwd(), "data", "backtests");
  const prefix = args.outPrefix || `walk_forward_${args.from}_${args.to || args.from}`;
  const headers = ["evalDate", "trainFrom", "trainTo", "gameId", "gameKey", "awayTeam", "homeTeam",
    "predictedWinner", "actualWinner", "predictionHit", "awayWinProbability", "homeWinProbability",
    "maxWinProbability", "actualAwayScore", "actualHomeScore", "logLoss", "brier", "over90", "modelVersion", "featureSchemaVersion"];
  const csv = [headers.join(","), ...result.perGame.map((row) => headers.map((name) => csvEscape(row[name])).join(","))].join("\n") + "\n";
  await fs.mkdir(outDir, { recursive: true });
  const csvPath = path.join(outDir, `${prefix}.csv`);
  const summaryPath = path.join(outDir, `${prefix}.summary.json`);
  await fs.writeFile(csvPath, csv, "utf8");
  await fs.writeFile(summaryPath, `${JSON.stringify(result.summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ csvPath, summaryPath, ...result.summary }, null, 2));
  if (!result.perGame.length) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { walkForward, main };
