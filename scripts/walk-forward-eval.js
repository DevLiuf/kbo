const path = require("path");
const { iterDates, parseArgs } = require("./ml-utils");
const { predictGame, evaluateRows, MODEL_TYPE } = require("../lib/score-model");
const { readNdjson, atomicWrite, writeJson } = require("../lib/artifacts");
const { eligibleExamples, validateRange, inRange, rejectObsoleteOptions } = require("./score-training-utils");
const { trainModel } = require("./train-score-model");
const { validateTrainedModel } = require("./retrain-daily");
const { buildExamples } = require("./build-training-examples");
const mean = (values) => { const valid = values.filter(Number.isFinite); return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null; };
function csvEscape(value) { const text = String(value ?? ""); return /[,\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
async function walkForward(inputRows, options = {}) {
  rejectObsoleteOptions(options);
  for (const name of ["baseUrl", "retryCount", "retryDelayMs", "keepFinalModel"]) {
    if (options[name] !== undefined) throw new Error(`--${name} is unsupported: offline walk-forward never fetches or replaces active artifacts`);
  }
  const from = options.from;
  const to = options.to || from;
  if (!from) throw new Error("Use --from=YYYYMMDD [--to=YYYYMMDD] for offline evaluation");
  validateRange(from, to);
  const rows = eligibleExamples(inputRows);
  const trainFrom = options.trainFrom || rows[0]?.gameDate;
  if (!trainFrom) throw new Error("No archived count examples");
  validateRange(trainFrom, from);
  const minExamples = Number(options.minExamples ?? 30);
  if (!Number.isInteger(minExamples) || minExamples < 1) throw new Error("minExamples must be a positive integer");
  const perGame = [];
  const perDay = [];
  const skippedEvalDays = [];
  for (const evalDate of iterDates(from, to)) {
    const evalRows = rows.filter((row) => row.gameDate === evalDate);
    if (!evalRows.length) { skippedEvalDays.push({ evalDate, reason: "No stored count examples" }); continue; }
    const priorRows = rows.filter((row) => inRange(row, trainFrom) && row.gameDate < evalDate);
    let model;
    try {
      model = validateTrainedModel(trainModel(priorRows, { epochs: options.epochs, lr: options.lr, l2: options.l2,
        holdoutDays: options.holdoutDays, minExamples, version: `walk-forward-score-${evalDate}` }));
    } catch (error) { skippedEvalDays.push({ evalDate, reason: error.message, samples: priorRows.length }); continue; }
    const trainTo = priorRows[priorRows.length - 1].gameDate;
    perDay.push({ evalDate, trainFrom, trainTo, ...evaluateRows(model, evalRows), trainingRange: model.trainingRange, validationRange: model.validationRange });
    for (const row of evalRows) {
      const prediction = predictGame(model, row.modelInputs);
      const isDraw = row.homeScore === row.awayScore;
      const label = Number(row.homeScore > row.awayScore);
      const p = Math.max(1e-9, Math.min(1 - 1e-9, prediction.homeWinProbability));
      perGame.push({ evalDate, trainFrom, trainTo, gameId: row.gameId, gameKey: row.gameKey, awayTeam: row.awayTeam, homeTeam: row.homeTeam,
        ...prediction, predictedWinner: p >= 0.5 ? row.homeTeam : row.awayTeam,
        actualWinner: isDraw ? null : label ? row.homeTeam : row.awayTeam, isDraw,
        predictionHit: isDraw ? null : Number(p >= 0.5) === label, actualHomeScore: row.homeScore, actualAwayScore: row.awayScore,
        mae: (Math.abs(prediction.expectedHomeRuns - row.homeScore) + Math.abs(prediction.expectedAwayRuns - row.awayScore)) / 2,
        logLoss: isDraw ? null : -(label * Math.log(p) + (1 - label) * Math.log(1 - p)), brier: isDraw ? null : (p - label) ** 2,
        modelVersion: model.version, featureSchemaVersion: model.featureSchemaVersion });
    }
  }
  const decisive = perGame.filter((row) => !row.isDraw);
  return { perGame, summary: { modelType: MODEL_TYPE, range: { evalFrom: from, evalTo: to, trainFrom },
    probabilitySemantics: "Conditional decisive nine-inning win probabilities; separate tie-after-nine probability is not final-game draw probability.",
    config: { holdoutDays: Number(options.holdoutDays ?? 3), minExamples },
    overall: { games: perGame.length, decisiveGames: decisive.length, drawGames: perGame.length - decisive.length,
      mae: mean(perGame.map((row) => row.mae)), accuracy: mean(decisive.map((row) => Number(row.predictionHit))),
      logLoss: mean(decisive.map((row) => row.logLoss)), brier: mean(decisive.map((row) => row.brier)) }, perDay, skippedEvalDays } };
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  rejectObsoleteOptions(args);
  let rows;
  let source;
  if (args.snapshots || args.results) {
    const built = buildExamples(await readNdjson(args.snapshots || "data/prediction_snapshots.ndjson"), await readNdjson(args.results || "data/game_results.kbo.ndjson"));
    rows = built.examples; source = built.summary;
  } else rows = await readNdjson(args.input || "data/run_training_examples.kbo.ndjson");
  const result = await walkForward(rows, args);
  if (source) result.summary.source = source;
  const outDir = args.outDir || path.join(process.cwd(), "data", "backtests");
  const prefix = args.outPrefix || `walk_forward_${args.from}_${args.to || args.from}`;
  const headers = ["evalDate", "trainFrom", "trainTo", "gameId", "gameKey", "awayTeam", "homeTeam", "predictedWinner", "actualWinner", "isDraw", "predictionHit",
    "expectedAwayRuns", "expectedHomeRuns", "predictedAwayScore", "predictedHomeScore", "awayWinProbability", "homeWinProbability", "tieAfterNineProbability",
    "actualAwayScore", "actualHomeScore", "mae", "logLoss", "brier", "modelVersion", "featureSchemaVersion"];
  const csvPath = path.join(outDir, `${prefix}.csv`);
  const summaryPath = path.join(outDir, `${prefix}.summary.json`);
  await atomicWrite(csvPath, [headers.join(","), ...result.perGame.map((row) => headers.map((name) => csvEscape(row[name])).join(","))].join("\n") + "\n");
  await writeJson(summaryPath, result.summary);
  console.log(JSON.stringify({ csvPath, summaryPath, ...result.summary }, null, 2));
  if (!result.perGame.length) process.exitCode = 1;
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { walkForward, main };
