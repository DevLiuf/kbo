const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { parseArgs } = require("./ml-utils");
const { MODEL_TYPE, validateModel } = require("../lib/score-model");
const { rejectObsoleteOptions } = require("./score-training-utils");
const { FEATURE_SCHEMA_VERSION } = require("../lib/prediction-contract");
const {
  acquireLock, assertDateRange, copyIfPresent, promoteArtifacts, readNdjson,
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
  if (!validateModel(model) || model.validationIndependent !== true) throw new Error("Invalid independently validated count model");
  if (!Number.isInteger(model.trainSamples) || model.trainSamples < 1 || !Number.isInteger(model.validSamples)
    || model.validSamples < 1 || model.samples !== model.trainSamples + model.validSamples) throw new Error("Invalid independent model sample counts");
  const training = model.trainingRange;
  const validation = model.validationRange;
  assertDateRange(training?.from, training?.to);
  assertDateRange(validation?.from, validation?.to);
  if (training.to >= validation.from) throw new Error("Model training/validation dates overlap");
  if (!Number.isFinite(Date.parse(model.trainedAt))) throw new Error("Invalid model training timestamp");
  for (const [name, samples] of [["train", model.trainSamples], ["validation", model.validSamples]]) {
    const metric = model.metrics?.[name];
    if (!metric || metric.samples !== samples || !Number.isFinite(metric.poissonNll) || metric.poissonNll < 0
      || !Number.isFinite(metric.mae) || metric.mae < 0 || !Number.isFinite(metric.logLoss) || metric.logLoss < 0
      || !Number.isFinite(metric.brier) || metric.brier < 0 || metric.brier > 1
      || !Number.isFinite(metric.accuracy) || metric.accuracy < 0 || metric.accuracy > 1
      || metric.decisiveGames + metric.drawGames !== samples
      || metric.range?.from !== (name === "train" ? training.from : validation.from)
      || metric.range?.to !== (name === "train" ? training.to : validation.to)) throw new Error(`Invalid independent ${name} metrics`);
  }
  const baseline = model.baseline;
  if (!baseline || !(baseline.leagueRate > 0) || !Number.isFinite(baseline.leagueRate)
    || !(baseline.homeWinShare > 0 && baseline.homeWinShare < 1)
    || baseline.trainingRange?.from !== training.from || baseline.trainingRange?.to !== training.to
    || baseline.validation?.samples !== model.validSamples
    || baseline.validation.range?.from !== validation.from || baseline.validation.range?.to !== validation.to) {
    throw new Error("Invalid training-only league baseline");
  }
  for (const name of ["poissonNll", "mae", "logLoss", "brier"]) {
    if (!Number.isFinite(baseline.validation[name]) || baseline.validation[name] < 0
      || model.metrics.validation[name] > baseline.validation[name] + 1e-12) {
      throw new Error(`Independent model validation ${name} is worse than training-only league baseline`);
    }
  }
  return model;
}

async function resolveOpeningDate(args, today = seoulToday()) {
  const explicit = args.from || process.env.KBO_OPENING_DAY;
  if (explicit) return String(explicit);
  const response = await fetch("https://www.koreabaseball.com/ws/Main.asmx/GetKboGameDate", {
    method: "POST", signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Referer: "https://www.koreabaseball.com/Schedule/GameCenter/Main.aspx" },
    body: new URLSearchParams({ leId: "1", srId: "0", date: `${today.slice(0, 4)}0101` }).toString(),
  });
  if (!response.ok) throw new Error(`Official season opening lookup failed: HTTP ${response.status}; provide --from`);
  const payload = await response.json();
  if (payload.code !== "100" || String(payload.NOW_G_DT || "").slice(0, 4) !== today.slice(0, 4)) throw new Error("Invalid official season opening; provide --from");
  assertDateRange(payload.NOW_G_DT, payload.NOW_G_DT);
  return payload.NOW_G_DT;
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
  let from = args.from ? String(args.from) : null;
  const to = String(args.to || today);
  const paths = {
    results: path.resolve(String(args.results || "data/game_results.kbo.ndjson")),
    snapshots: path.resolve(String(args.snapshots || "data/prediction_snapshots.ndjson")),
    examples: path.resolve(String(args.examples || "data/run_training_examples.kbo.ndjson")),
    model: path.resolve(String(args.model || "data/run_model.kbo.json")),
    status: path.resolve(String(args.status || "data/daily_retrain_status.kbo.json")),
  };
  const status = { ok: false, skipped: false, league: "kbo", startedAt: new Date().toISOString(), from, to, stage: "configuration" };
  let staging;
  let release;
  try {
    rejectObsoleteOptions(args);
    from = await resolveOpeningDate(args, today);
    status.from = from;
    release = await acquireLock(`${paths.model}.retrain.lock`);
    assertDateRange(from, to);
    const holdoutDays = integerFlag(args.holdoutDays, 3, 1);
    const correctionDays = integerFlag(args.correctionDays, 3, 0);
    const retryCount = integerFlag(args.retryCount, 3, 1);
    const retryDelayMs = integerFlag(args.retryDelayMs, 7000, 0);
    const minExamples = integerFlag(args.minExamples, 30, 1);
    const timeoutMs = integerFlag(args.stageTimeoutMs, 25 * 60 * 1000, 1);
    Object.assign(status, { holdoutDays, correctionDays, minExamples });
    await fs.mkdir(path.dirname(paths.model), { recursive: true });
    staging = await fs.mkdtemp(path.join(path.dirname(paths.model), ".retrain-"));
    const stagedResults = path.join(staging, "game_results.kbo.ndjson");
    const stagedExamples = path.join(staging, "run_training_examples.kbo.ndjson");
    const stagedModel = path.join(staging, "run_model.kbo.json");
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
      `--holdoutDays=${holdoutDays}`, `--minExamples=${minExamples}`,
      `--version=trained-score-kbo-${new Date().toISOString()}`,
    ];
    if (args.epochs !== undefined) trainArgs.push(`--epochs=${integerFlag(args.epochs, 1, 1)}`);
    for (const name of ["lr", "l2"]) if (args[name] !== undefined) trainArgs.push(`--${name}=${args[name]}`);
    await runNodeScript("train-score-model.js", trainArgs, { cwd: staging, timeoutMs });
    status.stage = "validate-model";
    const modelBytes = await fs.readFile(stagedModel);
    const model = validateTrainedModel(JSON.parse(modelBytes));
    await runNodeScript("eval-score-model.js", [`--input=${stagedExamples}`, `--model=${stagedModel}`], { cwd: staging, timeoutMs });
    Object.assign(status, {
      ok: true, skipped: false, stage: "completed", finishedAt: new Date().toISOString(),
      modelVersion: model.version, modelHash: sha256(modelBytes), featureSchemaVersion: FEATURE_SCHEMA_VERSION, modelType: MODEL_TYPE,
      trainingFromGameDate: model.trainingFromGameDate, trainingToGameDate: model.trainingToGameDate,
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
    if (release) await release();
  }
}

module.exports = { booleanFlag, integerFlag, runNodeScript, incrementalFrom, fetchIncrementalResults, validateTrainedModel, resolveOpeningDate };

if (require.main === module) {
  main().catch((error) => {
    console.error(`[daily-retrain] ${error.message}`);
    process.exitCode = 1;
  });
}
