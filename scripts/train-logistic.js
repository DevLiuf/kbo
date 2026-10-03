const fs = require("fs/promises");
const path = require("path");
const { parseArgs } = require("./ml-utils");
const { FEATURE_SCHEMA_VERSION } = require("../lib/prediction-contract");
const { FEATURE_NAMES, linearScore, calibratedProbability, sigmoid, readRows,
  eligibleExamples, rowRange, evaluateRows, validateModel } = require("../lib/logistic");

function splitByDate(rows, holdoutDays = 1, calibrationDays = 1) {
  if (!Number.isInteger(holdoutDays) || holdoutDays < 1
      || !Number.isInteger(calibrationDays) || calibrationDays < 1) {
    throw new Error("holdoutDays and calibrationDays must be positive integers");
  }
  const dates = [...new Set(rows.map((row) => row.gameDate))].sort();
  if (dates.length <= holdoutDays + calibrationDays) {
    throw new Error("Insufficient dates for independent chronological train/calibration/test windows");
  }
  const testFrom = dates[dates.length - holdoutDays];
  const calibrationFrom = dates[dates.length - holdoutDays - calibrationDays];
  const trainRows = rows.filter((row) => row.gameDate < calibrationFrom);
  const calibrationRows = rows.filter((row) => row.gameDate >= calibrationFrom && row.gameDate < testFrom);
  const testRows = rows.filter((row) => row.gameDate >= testFrom);
  if (!trainRows.length || !testRows.length || calibrationRows.length < 3
      || new Set(calibrationRows.map((row) => row.labelHomeWin)).size !== 2) {
    throw new Error("Need nonempty train/test and at least 3 independent calibration examples with both labels");
  }
  return { trainRows, calibrationRows, testRows };
}

function fitCalibration(model, rows, epochs) {
  const logits = rows.map((row) => linearScore(model, row));
  let a = 1;
  let b = 0;
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    let gradA = 0;
    let gradB = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const error = sigmoid(a * logits[i] + b) - rows[i].labelHomeWin;
      gradA += error * logits[i];
      gradB += error;
    }
    // A positive slope calibrates confidence without reversing the learned feature direction.
    a = Math.max(0.01, a - 0.01 * (gradA / rows.length + 0.0001 * a));
    b -= 0.01 * (gradB / rows.length + 0.0001 * b);
  }
  model.plattA = a;
  model.plattB = b;
  let bestLoss = Infinity;
  let bestTemperature = 1;
  for (let step = 0; step <= 30; step += 1) {
    model.temperature = 1 + step * 0.05;
    let loss = 0;
    for (const row of rows) {
      const p = calibratedProbability(model, row);
      loss -= row.labelHomeWin * Math.log(p) + (1 - row.labelHomeWin) * Math.log(1 - p);
    }
    if (loss < bestLoss) { bestLoss = loss; bestTemperature = model.temperature; }
  }
  model.temperature = bestTemperature;
}

function trainModel(inputRows, options = {}) {
  const rows = eligibleExamples(inputRows, options.from, options.to);
  const epochs = Number(options.epochs ?? 2000);
  const learningRate = Number(options.lr ?? 0.02);
  const l2 = Number(options.l2 ?? 0.0005);
  const holdoutDays = Number(options.holdoutDays ?? 1);
  const calibrationDays = Number(options.calibrationDays ?? 1);
  if (!Number.isInteger(epochs) || epochs < 1 || !Number.isFinite(learningRate) || learningRate <= 0
      || !Number.isFinite(l2) || l2 < 0) throw new Error("Invalid training hyperparameters");
  const { trainRows, calibrationRows, testRows } = splitByDate(rows, holdoutDays, calibrationDays);
  const model = { featureSchemaVersion: FEATURE_SCHEMA_VERSION, intercept: 0, plattA: 1, plattB: 0, temperature: 1 };
  for (const name of FEATURE_NAMES) model[name] = 0;
  const gradients = Object.fromEntries(FEATURE_NAMES.map((name) => [name, 0]));
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    let interceptGradient = 0;
    for (const name of FEATURE_NAMES) gradients[name] = 0;
    for (const row of trainRows) {
      const error = sigmoid(linearScore(model, row)) - row.labelHomeWin;
      interceptGradient += error;
      for (const name of FEATURE_NAMES) gradients[name] += error * row[name];
    }
    model.intercept -= learningRate * (interceptGradient / trainRows.length + l2 * model.intercept);
    for (const name of FEATURE_NAMES) {
      model[name] -= learningRate * (gradients[name] / trainRows.length + l2 * model[name]);
    }
  }
  fitCalibration(model, calibrationRows, epochs);
  if (!validateModel(model)) throw new Error("Training produced nonfinite model coefficients");
  const trainingRange = rowRange(trainRows);
  const calibrationRange = rowRange(calibrationRows);
  const validationRange = rowRange(testRows);
  Object.assign(model, {
    version: options.version || `trained-logistic-${new Date().toISOString()}`,
    trainedAt: new Date().toISOString(), samples: rows.length, trainSamples: trainRows.length,
    calibrationSamples: calibrationRows.length, validSamples: testRows.length,
    holdoutDays, calibrationDays, trainingRange, calibrationRange, validationRange,
    trainingFromGameDate: trainingRange.from, trainingToGameDate: trainingRange.to,
    calibrationFromGameDate: calibrationRange.from, calibrationToGameDate: calibrationRange.to,
    validationFromGameDate: validationRange.from, validationToGameDate: validationRange.to,
    preLineupShrink: 0.75,
    metrics: { train: evaluateRows(model, trainRows), calibration: evaluateRows(model, calibrationRows),
      validation: evaluateRows(model, testRows) },
  });
  for (const metric of Object.values(model.metrics)) {
    metric.n = metric.samples;
    if (![metric.logLoss, metric.brier, metric.accuracy].every(Number.isFinite)) {
      throw new Error("Training produced invalid metrics");
    }
  }
  return model;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input || path.join(process.cwd(), "data", "training_examples.kbo.ndjson");
  const output = args.output || path.join(process.cwd(), "data", "model_coefficients.kbo.json");
  const model = trainModel(await readRows(input), args);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(model, null, 2)}\n`, "utf8");
    await fs.rename(temporary, output);
  } finally { await fs.rm(temporary, { force: true }); }
  console.log(JSON.stringify({ output, version: model.version, metrics: model.metrics }));
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { splitByDate, trainModel, main };
