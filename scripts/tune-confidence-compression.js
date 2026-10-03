const fs = require("fs/promises");
const path = require("path");

const { parseArgs } = require("./ml-utils");
const { finiteNumber: safeNumber, loadBacktestRows } = require("../lib/backtest");


function boundedProb(p) {
  const n = safeNumber(p) ?? 0.5;
  return Math.max(1e-9, Math.min(1 - 1e-9, n));
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  if (valid.length === 0) {
    return null;
  }
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}


function compressProbability(probability, threshold, ratio) {
  const p = boundedProb(probability);
  const maxSide = Math.max(p, 1 - p);
  if (maxSide <= threshold) {
    return p;
  }

  const excess = maxSide - threshold;
  const adjustedMax = threshold + (excess * ratio);
  return p >= 0.5 ? adjustedMax : 1 - adjustedMax;
}

function evaluateParams(rows, threshold, ratio) {
  let correct = 0;
  let logLoss = 0;
  let brier = 0;
  let over90 = 0;
  let total = 0;

  for (const row of rows) {
    if (row.isDraw || safeNumber(row.homeWinProbability) === null
      || safeNumber(row.actualAwayScore) === null || safeNumber(row.actualHomeScore) === null
      || row.actualAwayScore === row.actualHomeScore) continue;
    const home = boundedProb(row.homeWinProbability);
    const actualHome = row.actualHomeScore > row.actualAwayScore ? 1 : 0;
    const compressedHome = compressProbability(home, threshold, ratio);
    total += 1;
    const compressedAway = 1 - compressedHome;
    const predHome = compressedHome >= 0.5 ? 1 : 0;

    if (predHome === actualHome) {
      correct += 1;
    }

    logLoss += -(actualHome * Math.log(compressedHome) + (1 - actualHome) * Math.log(1 - compressedHome));
    brier += (compressedHome - actualHome) ** 2;

    if (Math.max(compressedHome, compressedAway) >= 0.9) {
      over90 += 1;
    }
  }

  const accuracy = total > 0 ? correct / total : null;
  const avgLogLoss = total > 0 ? logLoss / total : null;
  const avgBrier = total > 0 ? brier / total : null;
  const over90Share = total > 0 ? over90 / total : null;

  return {
    threshold,
    ratio,
    games: total,
    accuracy,
    logLoss: avgLogLoss,
    brier: avgBrier,
    over90Games: over90,
    over90Share,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outPath = String(args.output || path.join(process.cwd(), "data", "backtests", "confidence_compression_tuning.json")).trim();

  if (Object.hasOwn(args, "input")) throw new Error("--input CSV is no longer supported: use --from/--to/--snapshots/--results for immutable pregame archives.");
  const { rows: joined, source } = await loadBacktestRows(args);
  const rows = joined.filter((row) => !row.isDraw && safeNumber(row.homeWinProbability) !== null);
  if (!rows.length) throw new Error("No eligible decisive archived predictions in the requested range");
  const dates = [...new Set(rows.map((row) => row.gameDate))].sort();
  const explicitSplit = args.tuningTo !== undefined || args.validationFrom !== undefined;
  if (explicitSplit && (!/^\d{8}$/.test(String(args.tuningTo || "")) || !/^\d{8}$/.test(String(args.validationFrom || "")) || args.tuningTo >= args.validationFrom)) {
    throw new Error("--tuningTo and --validationFrom must be YYYYMMDD dates with tuningTo < validationFrom");
  }
  const validationFrom = explicitSplit ? args.validationFrom : dates.length > 1 ? dates[Math.max(1, Math.floor(dates.length * 0.8))] : null;
  const tuningRows = rows.filter((row) => explicitSplit ? row.gameDate <= args.tuningTo : !validationFrom || row.gameDate < validationFrom);
  const validationRows = validationFrom ? rows.filter((row) => row.gameDate >= validationFrom) : [];
  if (!tuningRows.length || (explicitSplit && !validationRows.length)) throw new Error("Requested split has no eligible tuning or validation games");

  const evaluated = [];
  for (let threshold = 0.82; threshold <= 0.9; threshold += 0.01) {
    for (let ratio = 0.2; ratio <= 0.6; ratio += 0.05) {
      evaluated.push(evaluateParams(tuningRows, Number(threshold.toFixed(2)), Number(ratio.toFixed(2))));
    }
  }

  const baseline = evaluateParams(tuningRows, 0.9, 1);

  const best = [...evaluated].sort((a, b) => {
    const scoreA = a.logLoss + a.brier + (a.over90Share * 0.25) - (a.accuracy * 0.15);
    const scoreB = b.logLoss + b.brier + (b.over90Share * 0.25) - (b.accuracy * 0.15);
    return scoreA - scoreB;
  })[0];

  const payload = {
    createdAt: new Date().toISOString(),
    source,
    split: {
      tuningFrom: tuningRows[0].gameDate,
      tuningTo: tuningRows[tuningRows.length - 1].gameDate,
      validationFrom: validationRows[0]?.gameDate || null,
      validationTo: validationRows[validationRows.length - 1]?.gameDate || null,
      note: validationRows.length ? "Chronological date-disjoint holdout; parameters selected only on tuning dates." : "No independent validation: only one eligible date; all reported selection metrics are in-sample.",
    },
    validation: validationRows.length ? {
      baseline: evaluateParams(validationRows, 0.9, 1),
      best: evaluateParams(validationRows, best.threshold, best.ratio),
    } : null,
    baseline: {
      ...baseline,
      accuracy: round(baseline.accuracy),
      logLoss: round(baseline.logLoss),
      brier: round(baseline.brier),
      over90Share: round(baseline.over90Share),
    },
    best: {
      ...best,
      accuracy: round(best.accuracy),
      logLoss: round(best.logLoss),
      brier: round(best.brier),
      over90Share: round(best.over90Share),
    },
    top10: evaluated
      .sort((a, b) => (a.logLoss + a.brier + (a.over90Share * 0.25) - (a.accuracy * 0.15))
        - (b.logLoss + b.brier + (b.over90Share * 0.25) - (b.accuracy * 0.15)))
      .slice(0, 10)
      .map((row) => ({
        ...row,
        accuracy: round(row.accuracy),
        logLoss: round(row.logLoss),
        brier: round(row.brier),
        over90Share: round(row.over90Share),
      })),
    avgAccuracy: round(mean(evaluated.map((row) => row.accuracy))),
    avgLogLoss: round(mean(evaluated.map((row) => row.logLoss))),
    avgBrier: round(mean(evaluated.map((row) => row.brier))),
  };

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    outPath,
    baseline: payload.baseline,
    best: payload.best,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
