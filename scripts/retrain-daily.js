const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { parseArgs } = require("./ml-utils");
const { FEATURE_NAMES } = require("../lib/logistic");
const { FEATURE_SCHEMA_VERSION } = require("../lib/prediction-contract");
const {
  assertDateRange, copyIfPresent, promoteArtifacts, readNdjson,
  seoulToday, sha256, shiftDate, writeJson,
} = require("../lib/artifacts");
const { assertSupportedRuntime } = require("../lib/runtime");

function booleanFlag(value, fallback) {
  if (value === undefined) return fallback;
  if (["true", "1", "yes", "on"].includes(String(value).toLowerCase())) return true;
  if (["false", "0", "no", "off"].includes(String(value).toLowerCase())) return false;
  throw new Error(`Invalid boolean flag: ${value}`);
}

function integerFlag(value, fallback, minimum) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum) throw new Error(`Invalid integer flag: ${value}`);
  return number;
}

function runNodeScript(scriptName, args, { cwd, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, scriptName), ...args], {
      cwd: cwd || process.cwd(), stdio: "inherit", timeout: timeoutMs || 25 * 60 * 1000,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new Error(`${scriptName} failed (${signal || `exit ${code}`})`));
    });
  });
}

function incrementalFrom(results, from, to, correctionDays) {
  const completedDates = results.filter((row) => row.completed === true
    && Number.isFinite(row.homeScore) && Number.isFinite(row.awayScore)
    && /^\d{8}$/.test(String(row.gameDate)) && String(row.gameDate) <= to)
    .map((row) => String(row.gameDate)).sort();
  if (!completedDates.length) return from;
  const corrected = shiftDate(completedDates[completedDates.length - 1], -correctionDays);
  return corrected > from ? corrected : from;
}

function validateTrainedModel(model) {
  if (!model || model.featureSchemaVersion !== FEATURE_SCHEMA_VERSION || !String(model.version || "").trim()) {
    throw new Error("Invalid model schema/version");
  }
  for (const key of ["intercept", ...FEATURE_NAMES, "plattA", "plattB", "temperature"]) {
    if (!Number.isFinite(model[key])) throw new Error(`Nonfinite model coefficient: ${key}`);
  }
  if (!(model.temperature > 0) || !(model.plattA > 0) || !Number.isInteger(model.trainSamples) || model.trainSamples < 1
    || !Number.isInteger(model.calibrationSamples) || model.calibrationSamples < 3
    || !Number.isInteger(model.validSamples) || model.validSamples < 1
    || model.samples !== model.trainSamples + model.calibrationSamples + model.validSamples) {
    throw new Error("Invalid independent model sample counts");
  }
  const ranges = ["training", "calibration", "validation"].map((name) => {
    const from = model[`${name}FromGameDate`];
    const to = model[`${name}ToGameDate`];
    assertDateRange(from, to);
    return { from, to };
  });
  if (ranges[0].to >= ranges[1].from || ranges[1].to >= ranges[2].from) {
    throw new Error("Model train/calibration/validation dates overlap");
  }
  for (const name of ["train", "calibration", "validation"]) {
    const metric = model.metrics?.[name];
    if (!metric || !Number.isInteger(metric.n ?? metric.samples) || (metric.n ?? metric.samples) < 1
      || !Number.isFinite(metric.logLoss) || metric.logLoss < 0
      || !Number.isFinite(metric.brier) || metric.brier < 0 || metric.brier > 1
      || !Number.isFinite(metric.accuracy) || metric.accuracy < 0 || metric.accuracy > 1) {
      throw new Error(`Invalid independent ${name} metrics`);
    }
  }
  if ((model.metrics.train.n ?? model.metrics.train.samples) !== model.trainSamples
    || (model.metrics.calibration.n ?? model.metrics.calibration.samples) !== model.calibrationSamples
    || (model.metrics.validation.n ?? model.metrics.validation.samples) !== model.validSamples) {
    throw new Error("Model metric/sample counts mismatch");
  }
  if (model.metrics.validation.logLoss > Math.log(2) + 1e-12 || model.metrics.validation.brier > 0.25 + 1e-12) {
    throw new Error("Independent model validation is worse than the coinflip baseline");
  }
  return model;
}

async function fetchIncrementalResults({ from, to, results, correctionDays, retryCount, retryDelayMs, cwd, timeoutMs }) {
  const fetchFrom = incrementalFrom(await readNdjson(results, { allowMissing: true }), from, to, correctionDays);
  for (let attempt = 1; attempt <= retryCount; attempt += 1) {
    try {
      await runNodeScript("fetch-results.js", [`--from=${fetchFrom}`, `--to=${to}`, `--output=${results}`], { cwd, timeoutMs });
      return fetchFrom;
    } catch (error) {
      if (attempt === retryCount) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

async function main() {
  assertSupportedRuntime();
  const args = parseArgs(process.argv.slice(2));
  const today = seoulToday();
  const from = String(args.from || process.env.KBO_OPENING_DAY || `${today.slice(0, 4)}0331`);
  const to = String(args.to || today);
  const paths = {
    results: path.resolve(String(args.results || "data/game_results.kbo.ndjson")),
    snapshots: path.resolve(String(args.snapshots || "data/prediction_snapshots.ndjson")),
    examples: path.resolve(String(args.examples || "data/training_examples.kbo.ndjson")),
    model: path.resolve(String(args.model || "data/model_coefficients.kbo.json")),
    status: path.resolve(String(args.status || "data/daily_retrain_status.kbo.json")),
  };
  const status = { ok: false, skipped: false, league: "kbo", startedAt: new Date().toISOString(), from, to, stage: "configuration" };
  let staging;
  try {
    assertDateRange(from, to);
    const holdoutDays = integerFlag(args.holdoutDays, 3, 1);
    const calibrationDays = integerFlag(args.calibrationDays, 1, 1);
    const correctionDays = integerFlag(args.correctionDays, 3, 0);
    const retryCount = integerFlag(args.retryCount, 3, 1);
    const retryDelayMs = integerFlag(args.retryDelayMs, 7000, 0);
    const minExamples = integerFlag(args.minExamples, 30, 1);
    const timeoutMs = integerFlag(args.stageTimeoutMs, 25 * 60 * 1000, 1);
    Object.assign(status, { holdoutDays, calibrationDays, correctionDays, minExamples });
    await fs.mkdir(path.dirname(paths.model), { recursive: true });
    staging = await fs.mkdtemp(path.join(path.dirname(paths.model), ".retrain-"));
    const stagedResults = path.join(staging, "game_results.kbo.ndjson");
    const stagedExamples = path.join(staging, "training_examples.kbo.ndjson");
    const stagedModel = path.join(staging, "model_coefficients.kbo.json");
    const stagedStatus = path.join(staging, "daily_retrain_status.kbo.json");
    await copyIfPresent(paths.results, stagedResults);
    status.stage = "fetch-results";
    if (booleanFlag(args.fetchResults, true)) {
      status.fetchFrom = await fetchIncrementalResults({
        from, to, results: stagedResults, correctionDays, retryCount, retryDelayMs, cwd: staging, timeoutMs,
      });
      await promoteArtifacts([{ source: stagedResults, target: paths.results }]);
    } else {
      await readNdjson(stagedResults);
      status.fetchFrom = null;
    }
    status.stage = "build-examples";
    await runNodeScript("build-training-examples.js", [
      `--results=${stagedResults}`, `--snapshots=${paths.snapshots}`, `--output=${stagedExamples}`,
      `--from=${from}`, `--to=${to}`,
    ], { cwd: staging, timeoutMs });
    const examples = await readNdjson(stagedExamples);
    status.trainingExamples = examples.length;
    if (examples.length < minExamples) {
      status.skipped = true;
      status.skipReason = "insufficient_examples";
      throw new Error(`Insufficient training examples (${examples.length} < ${minExamples})`);
    }
    status.stage = "train-model";
    const trainArgs = [
      `--input=${stagedExamples}`, `--output=${stagedModel}`, `--from=${from}`, `--to=${to}`,
      `--holdoutDays=${holdoutDays}`, `--calibrationDays=${calibrationDays}`,
      `--version=trained-logistic-kbo-${new Date().toISOString()}`,
    ];
    if (args.epochs !== undefined) trainArgs.push(`--epochs=${integerFlag(args.epochs, 1, 1)}`);
    await runNodeScript("train-logistic.js", trainArgs, { cwd: staging, timeoutMs });
    status.stage = "validate-model";
    const modelBytes = await fs.readFile(stagedModel);
    const model = validateTrainedModel(JSON.parse(modelBytes));
    await runNodeScript("eval-logistic.js", [`--input=${stagedExamples}`, `--model=${stagedModel}`], { cwd: staging, timeoutMs });
    Object.assign(status, {
      ok: true, skipped: false, stage: "completed", finishedAt: new Date().toISOString(),
      modelVersion: model.version, modelHash: sha256(modelBytes), featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      trainingFromGameDate: model.trainingFromGameDate, trainingToGameDate: model.trainingToGameDate,
      calibrationFromGameDate: model.calibrationFromGameDate, calibrationToGameDate: model.calibrationToGameDate,
      validationFromGameDate: model.validationFromGameDate, validationToGameDate: model.validationToGameDate,
      validation: model.metrics.validation,
    });
    await writeJson(stagedStatus, status);
    await promoteArtifacts([
      { source: stagedExamples, target: paths.examples },
      { source: stagedModel, target: paths.model },
      { source: stagedStatus, target: paths.status },
    ]);
    console.log(JSON.stringify(status, null, 2));
  } catch (error) {
    status.ok = false;
    status.error = error.message;
    status.finishedAt = new Date().toISOString();
    await writeJson(paths.status, status);
    throw error;
  } finally {
    if (staging) await fs.rm(staging, { recursive: true, force: true });
  }
}

module.exports = { booleanFlag, integerFlag, runNodeScript, incrementalFrom, fetchIncrementalResults, validateTrainedModel };

if (require.main === module) {
  main().catch((error) => {
    console.error(`[daily-retrain] ${error.message}`);
    process.exitCode = 1;
  });
}
