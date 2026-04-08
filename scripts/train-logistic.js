const fs = require("fs/promises");
const path = require("path");

const { parseArgs, readNdjson, sigmoid } = require("./ml-utils");

function dot(weights, x) {
  let sum = weights.intercept;
  sum += weights.offenseDiff * x.offenseDiff;
  sum += weights.defenseDiff * x.defenseDiff;
  sum += weights.starterEraDiff * x.starterEraDiff;
  sum += weights.runCreationResidualDiff * x.runCreationResidualDiff;
  sum += weights.powerContactMixDiff * x.powerContactMixDiff;
  sum += weights.starterHitsPer9Diff * x.starterHitsPer9Diff;
  sum += weights.starterHrPer9Diff * x.starterHrPer9Diff;
  sum += weights.starterFreePassPer9Diff * x.starterFreePassPer9Diff;
  sum += weights.starterSoPer9Diff * x.starterSoPer9Diff;
  sum += weights.starterRunsPer9Diff * x.starterRunsPer9Diff;
  sum += weights.whipDiff * x.whipDiff;
  sum += weights.bullpenDiff * x.bullpenDiff;
  sum += weights.homeAdvantage * x.homeAdvantage;
  sum += weights.lineupSignal * x.lineupSignal;
  return sum;
}

function normalizeRow(row) {
  return {
    ...row,
    runCreationResidualDiff: Number(row.runCreationResidualDiff) || 0,
    powerContactMixDiff: Number(row.powerContactMixDiff) || 0,
    starterHitsPer9Diff: Number(row.starterHitsPer9Diff) || 0,
    starterHrPer9Diff: Number(row.starterHrPer9Diff) || 0,
    starterFreePassPer9Diff: Number(row.starterFreePassPer9Diff) || 0,
    starterSoPer9Diff: Number(row.starterSoPer9Diff) || 0,
    starterRunsPer9Diff: Number(row.starterRunsPer9Diff) || 0,
  };
}

function boundedProb(prob) {
  return Math.max(1e-9, Math.min(1 - 1e-9, prob));
}

function splitByDate(rows, holdoutDays) {
  const uniqueDates = [...new Set(rows.map((row) => String(row.gameDate)))].sort();
  if (uniqueDates.length <= 1) {
    const splitIndex = Math.max(1, Math.floor(rows.length * 0.8));
    return {
      trainRows: rows.slice(0, splitIndex),
      validRows: rows.slice(splitIndex),
    };
  }

  const holdoutCount = Math.max(1, Math.min(holdoutDays, uniqueDates.length - 1));
  const validSet = new Set(uniqueDates.slice(-holdoutCount));
  const trainRows = rows.filter((row) => !validSet.has(String(row.gameDate)));
  const validRows = rows.filter((row) => validSet.has(String(row.gameDate)));
  return { trainRows, validRows };
}

function fitPlatt(logits, labels, epochs = 1200, lr = 0.01, l2 = 0.0001) {
  if (logits.length === 0 || labels.length !== logits.length) {
    return { plattA: 1, plattB: 0 };
  }

  let a = 1;
  let b = 0;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    let gradA = 0;
    let gradB = 0;

    for (let i = 0; i < logits.length; i += 1) {
      const z = a * logits[i] + b;
      const p = sigmoid(z);
      const e = p - labels[i];
      gradA += e * logits[i];
      gradB += e;
    }

    const n = logits.length;
    a -= lr * (gradA / n + l2 * a);
    b -= lr * (gradB / n + l2 * b);
  }

  return { plattA: a, plattB: b };
}

function metrics(rows, weights, platt) {
  if (rows.length === 0) {
    return { logLoss: null, accuracy: null, brier: null };
  }

  let loss = 0;
  let brier = 0;
  let correct = 0;
  for (const row of rows) {
    const raw = dot(weights, row);
    const calibrated = sigmoid(platt.plattA * raw + platt.plattB);
    const p = boundedProb(calibrated);
    loss += -(row.labelHomeWin * Math.log(p) + (1 - row.labelHomeWin) * Math.log(1 - p));
    brier += (p - row.labelHomeWin) ** 2;
    const pred = p >= 0.5 ? 1 : 0;
    if (pred === row.labelHomeWin) {
      correct += 1;
    }
  }

  return {
    logLoss: loss / rows.length,
    brier: brier / rows.length,
    accuracy: correct / rows.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input || path.join(process.cwd(), "data", "training_examples.ndjson");
  const output = args.output || path.join(process.cwd(), "data", "model_coefficients.json");
  const version = args.version || `trained-logistic-${new Date().toISOString().slice(0, 10)}`;
  const epochs = Number(args.epochs || 2000);
  const learningRate = Number(args.lr || 0.02);
  const l2 = Number(args.l2 || 0.0005);
  const holdoutDays = Number(args.holdoutDays || 1);

  const rows = (await readNdjson(input)).map(normalizeRow);
  if (rows.length < 5) {
    throw new Error("Need at least 5 labeled examples in training_examples.ndjson");
  }

  rows.sort((a, b) => String(a.gameDate).localeCompare(String(b.gameDate)));
  const gameDates = rows
    .map((row) => String(row.gameDate || "").trim())
    .filter((gameDate) => /^\d{8}$/.test(gameDate))
    .sort();
  const trainingFromGameDate = gameDates[0] || null;
  const trainingToGameDate = gameDates.length > 0 ? gameDates[gameDates.length - 1] : null;
  const { trainRows, validRows } = splitByDate(rows, holdoutDays);

  const w = {
    intercept: -0.18,
    offenseDiff: 0.42,
    defenseDiff: 0.29,
    starterEraDiff: 0.11,
    runCreationResidualDiff: 0.28,
    powerContactMixDiff: 0.22,
    starterHitsPer9Diff: 0.08,
    starterHrPer9Diff: 0.12,
    starterFreePassPer9Diff: 0.1,
    starterSoPer9Diff: 0.06,
    starterRunsPer9Diff: 0.14,
    whipDiff: 0.24,
    bullpenDiff: 0.18,
    homeAdvantage: 1.4,
    lineupSignal: 0.12,
  };

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const g = {
      intercept: 0,
      offenseDiff: 0,
      defenseDiff: 0,
      starterEraDiff: 0,
      runCreationResidualDiff: 0,
      powerContactMixDiff: 0,
      starterHitsPer9Diff: 0,
      starterHrPer9Diff: 0,
      starterFreePassPer9Diff: 0,
      starterSoPer9Diff: 0,
      starterRunsPer9Diff: 0,
      whipDiff: 0,
      bullpenDiff: 0,
      homeAdvantage: 0,
      lineupSignal: 0,
    };

    for (const row of trainRows) {
      const p = sigmoid(dot(w, row));
      const e = p - row.labelHomeWin;
      g.intercept += e;
      g.offenseDiff += e * row.offenseDiff;
      g.defenseDiff += e * row.defenseDiff;
      g.starterEraDiff += e * row.starterEraDiff;
      g.runCreationResidualDiff += e * row.runCreationResidualDiff;
      g.powerContactMixDiff += e * row.powerContactMixDiff;
      g.starterHitsPer9Diff += e * row.starterHitsPer9Diff;
      g.starterHrPer9Diff += e * row.starterHrPer9Diff;
      g.starterFreePassPer9Diff += e * row.starterFreePassPer9Diff;
      g.starterSoPer9Diff += e * row.starterSoPer9Diff;
      g.starterRunsPer9Diff += e * row.starterRunsPer9Diff;
      g.whipDiff += e * row.whipDiff;
      g.bullpenDiff += e * row.bullpenDiff;
      g.homeAdvantage += e * row.homeAdvantage;
      g.lineupSignal += e * row.lineupSignal;
    }

    const n = Math.max(1, trainRows.length);
    w.intercept -= learningRate * (g.intercept / n + l2 * w.intercept);
    w.offenseDiff -= learningRate * (g.offenseDiff / n + l2 * w.offenseDiff);
    w.defenseDiff -= learningRate * (g.defenseDiff / n + l2 * w.defenseDiff);
    w.starterEraDiff -= learningRate * (g.starterEraDiff / n + l2 * w.starterEraDiff);
    w.runCreationResidualDiff -= learningRate * (g.runCreationResidualDiff / n + l2 * w.runCreationResidualDiff);
    w.powerContactMixDiff -= learningRate * (g.powerContactMixDiff / n + l2 * w.powerContactMixDiff);
    w.starterHitsPer9Diff -= learningRate * (g.starterHitsPer9Diff / n + l2 * w.starterHitsPer9Diff);
    w.starterHrPer9Diff -= learningRate * (g.starterHrPer9Diff / n + l2 * w.starterHrPer9Diff);
    w.starterFreePassPer9Diff -= learningRate * (g.starterFreePassPer9Diff / n + l2 * w.starterFreePassPer9Diff);
    w.starterSoPer9Diff -= learningRate * (g.starterSoPer9Diff / n + l2 * w.starterSoPer9Diff);
    w.starterRunsPer9Diff -= learningRate * (g.starterRunsPer9Diff / n + l2 * w.starterRunsPer9Diff);
    w.whipDiff -= learningRate * (g.whipDiff / n + l2 * w.whipDiff);
    w.bullpenDiff -= learningRate * (g.bullpenDiff / n + l2 * w.bullpenDiff);
    w.homeAdvantage -= learningRate * (g.homeAdvantage / n + l2 * w.homeAdvantage);
    w.lineupSignal -= learningRate * (g.lineupSignal / n + l2 * w.lineupSignal);
  }

  const logits = validRows.map((row) => dot(w, row));
  const labels = validRows.map((row) => row.labelHomeWin);
  const platt = validRows.length >= 3 ? fitPlatt(logits, labels) : { plattA: 1, plattB: 0 };

  const trainMetric = metrics(trainRows, w, platt);
  const validMetric = metrics(validRows, w, platt);

  const model = {
    version,
    trainedAt: new Date().toISOString(),
    samples: rows.length,
    trainSamples: trainRows.length,
    validSamples: validRows.length,
    trainingFromGameDate,
    trainingToGameDate,
    holdoutDays,
    intercept: Number(w.intercept.toFixed(6)),
    offenseDiff: Number(w.offenseDiff.toFixed(6)),
    defenseDiff: Number(Math.abs(w.defenseDiff).toFixed(6)),
    starterEraDiff: Number(w.starterEraDiff.toFixed(6)),
    runCreationResidualDiff: Number(w.runCreationResidualDiff.toFixed(6)),
    powerContactMixDiff: Number(w.powerContactMixDiff.toFixed(6)),
    starterHitsPer9Diff: Number(w.starterHitsPer9Diff.toFixed(6)),
    starterHrPer9Diff: Number(w.starterHrPer9Diff.toFixed(6)),
    starterFreePassPer9Diff: Number(w.starterFreePassPer9Diff.toFixed(6)),
    starterSoPer9Diff: Number(w.starterSoPer9Diff.toFixed(6)),
    starterRunsPer9Diff: Number(w.starterRunsPer9Diff.toFixed(6)),
    whipDiff: Number(w.whipDiff.toFixed(6)),
    bullpenDiff: Number(w.bullpenDiff.toFixed(6)),
    homeAdvantage: Number(w.homeAdvantage.toFixed(6)),
    lineupSignal: Number(w.lineupSignal.toFixed(6)),
    preLineupShrink: 0.75,
    blendWeightPost: 0.65,
    blendWeightPre: 0.45,
    plattA: Number(platt.plattA.toFixed(6)),
    plattB: Number(platt.plattB.toFixed(6)),
    metrics: {
      train: trainMetric,
      validation: validMetric,
    },
  };

  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(model, null, 2)}\n`, "utf8");

  console.log("saved model:", output);
  console.log("validation:", model.metrics.validation);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
