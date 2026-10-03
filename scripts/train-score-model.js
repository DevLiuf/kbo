const path = require("path");
const { parseArgs } = require("./ml-utils");
const { FEATURE_SCHEMA_VERSION } = require("../lib/prediction-contract");
const { MODEL_TYPE, INPUT_NAMES, sideVector, evaluateRows, validateModel } = require("../lib/score-model");
const { readNdjson, writeJson } = require("../lib/artifacts");
const { eligibleExamples, rowRange, rejectObsoleteOptions } = require("./score-training-utils");

function splitByDate(rows, holdoutDays = 3) {
  if (!Number.isInteger(holdoutDays) || holdoutDays < 1) throw new Error("holdoutDays must be a positive integer");
  const dates = [...new Set(rows.map((row) => row.gameDate))].sort();
  if (dates.length <= holdoutDays) throw new Error("Insufficient dates for independent chronological training/validation");
  const validationFrom = dates[dates.length - holdoutDays];
  return { trainRows: rows.filter((row) => row.gameDate < validationFrom), testRows: rows.filter((row) => row.gameDate >= validationFrom) };
}

function fitCounts(rows, { epochs, learningRate, l2 }) {
  const observations = rows.flatMap((row) => ["away", "home"].map((side) => {
    const vector = sideVector(row.modelInputs[side]);
    return { x: [1, ...INPUT_NAMES.map((name) => vector[name])], offset: Math.log(row.modelInputs.leagueRunsPerGame), y: row[`${side}Score`] };
  }));
  const totalRuns = observations.reduce((sum, row) => sum + row.y, 0);
  if (totalRuns === 0) throw new Error("Insufficient positive run counts for finite Poisson fitting");
  let parameters = [Math.log(totalRuns / observations.reduce((sum, row) => sum + Math.exp(row.offset), 0)), ...INPUT_NAMES.map(() => 0)];
  function objective(values) {
    let loss = 0;
    for (const row of observations) {
      const eta = row.offset + values.reduce((sum, value, i) => sum + value * row.x[i], 0);
      loss += Math.exp(eta) - row.y * eta;
    }
    return loss / observations.length + l2 * values.slice(1).reduce((sum, value) => sum + value * value, 0) / 2;
  }
  let loss = objective(parameters);
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradients = parameters.map(() => 0);
    for (const row of observations) {
      const eta = row.offset + parameters.reduce((sum, value, i) => sum + value * row.x[i], 0);
      const error = Math.exp(eta) - row.y;
      for (let i = 0; i < gradients.length; i += 1) gradients[i] += error * row.x[i] / observations.length;
    }
    for (let i = 1; i < gradients.length; i += 1) gradients[i] += l2 * parameters[i];
    let step = learningRate;
    let candidate;
    let nextLoss;
    do {
      candidate = parameters.map((value, i) => {
        const next = value - step * gradients[i];
        return i === 0 ? next : INPUT_NAMES[i - 1] === "home" ? Math.max(-0.3, Math.min(0.3, next)) : Math.max(0, next);
      });
      nextLoss = objective(candidate);
      if (Number.isFinite(nextLoss) && nextLoss <= loss) break;
      step /= 2;
    } while (step > 1e-12);
    if (!Number.isFinite(nextLoss) || nextLoss > loss) break;
    const improvement = loss - nextLoss;
    parameters = candidate;
    loss = nextLoss;
    if (improvement < 1e-12) break;
  }
  return { intercept: parameters[0], coefficients: Object.fromEntries(INPUT_NAMES.map((name, i) => [name, parameters[i + 1]])) };
}

function baselineMetrics(trainRows, testRows) {
  const leagueRate = trainRows.reduce((sum, row) => sum + row.homeScore + row.awayScore, 0) / (2 * trainRows.length);
  const decisive = trainRows.filter((row) => row.homeScore !== row.awayScore);
  if (!decisive.length) throw new Error("Insufficient decisive training games for independent baseline");
  const homeWinShare = Math.max(1e-9, Math.min(1 - 1e-9, decisive.filter((row) => row.homeScore > row.awayScore).length / decisive.length));
  const constant = { modelType: MODEL_TYPE, featureSchemaVersion: FEATURE_SCHEMA_VERSION, version: "training-only-constant", intercept: 0,
    coefficients: Object.fromEntries(INPUT_NAMES.map((name) => [name, 0])) };
  const metrics = evaluateRows(constant, testRows.map((row) => ({ ...row, modelInputs: { ...row.modelInputs, leagueRunsPerGame: leagueRate } })));
  const validationDecisive = testRows.filter((row) => row.homeScore !== row.awayScore);
  metrics.logLoss = validationDecisive.length ? validationDecisive.reduce((sum, row) => sum - Math.log(row.homeScore > row.awayScore ? homeWinShare : 1 - homeWinShare), 0) / validationDecisive.length : null;
  metrics.brier = validationDecisive.length ? validationDecisive.reduce((sum, row) => sum + (homeWinShare - Number(row.homeScore > row.awayScore)) ** 2, 0) / validationDecisive.length : null;
  metrics.accuracy = validationDecisive.length ? validationDecisive.filter((row) => (homeWinShare >= 0.5) === (row.homeScore > row.awayScore)).length / validationDecisive.length : null;
  return { leagueRate, homeWinShare, trainingRange: rowRange(trainRows), validation: metrics };
}

function trainModel(inputRows, options = {}) {
  rejectObsoleteOptions(options);
  const rows = eligibleExamples(inputRows, options.from, options.to);
  const minExamples = Number(options.minExamples ?? 30);
  const epochs = Number(options.epochs ?? 2000);
  const learningRate = Number(options.lr ?? 0.02);
  const l2 = Number(options.l2 ?? 0.0005);
  const holdoutDays = Number(options.holdoutDays ?? 3);
  if (!Number.isInteger(minExamples) || minExamples < 1 || !Number.isInteger(epochs) || epochs < 1
    || !Number.isFinite(learningRate) || learningRate <= 0 || !Number.isFinite(l2) || l2 < 0) throw new Error("Invalid training hyperparameters");
  if (rows.length < minExamples) throw new Error(`Insufficient training examples (${rows.length} < ${minExamples})`);
  const { trainRows, testRows } = splitByDate(rows, holdoutDays);
  const trainedAt = new Date().toISOString();
  const trainingSources = { livePregame: 0, historicalReconstruction: 0 };
  for (const row of rows) trainingSources[row.mode === "historical_reconstruction" ? "historicalReconstruction" : "livePregame"] += 1;
  const model = { modelType: MODEL_TYPE, featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    version: options.version || `trained-score-kbo-${trainedAt}`, trainedAt, ...fitCounts(trainRows, { epochs, learningRate, l2 }),
    samples: rows.length, trainSamples: trainRows.length, validSamples: testRows.length, holdoutDays, trainingSources,
    trainingRange: rowRange(trainRows), validationRange: rowRange(testRows), validationIndependent: true };
  if (!validateModel(model)) throw new Error("Training produced invalid count coefficients");
  Object.assign(model, { trainingFromGameDate: model.trainingRange.from, trainingToGameDate: model.trainingRange.to,
    validationFromGameDate: model.validationRange.from, validationToGameDate: model.validationRange.to,
    metrics: { train: evaluateRows(model, trainRows), validation: evaluateRows(model, testRows) }, baseline: baselineMetrics(trainRows, testRows) });
  return model;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  rejectObsoleteOptions(args);
  const input = args.input || path.join(process.cwd(), "data", "run_training_examples.kbo.ndjson");
  const output = args.output || args.model || path.join(process.cwd(), "data", "run_model.kbo.json");
  const model = trainModel(await readNdjson(input), args);
  require("./retrain-daily").validateTrainedModel(model);
  await writeJson(output, model);
  console.log(JSON.stringify({ output, version: model.version, metrics: model.metrics, baseline: model.baseline }));
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { splitByDate, trainModel, main };
