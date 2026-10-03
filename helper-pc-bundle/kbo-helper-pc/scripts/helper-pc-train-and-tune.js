const fs = require("fs/promises");
const path = require("path");
const { spawnSync } = require("child_process");
const { parseArgs } = require("./ml-utils");
const {
  booleanFlag, integerFlag, runNodeScript, fetchIncrementalResults, validateTrainedModel, resolveOpeningDate,
} = require("./retrain-daily");
const { FEATURE_SCHEMA_VERSION } = require("../lib/prediction-contract");
const { MODEL_TYPE, validateModel } = require("../lib/score-model");
const { rejectObsoleteOptions } = require("./score-training-utils");
const {
  acquireLock, assertDateRange, atomicWrite, copyIfPresent, ndjson, promoteArtifacts, readNdjson, seoulToday, sha256, shiftDate, writeJson,
} = require("../lib/artifacts");
const { assertSupportedRuntime } = require("../lib/runtime");

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function codeRevision() {
  if (process.env.HELPER_PC_CODE_REVISION) return process.env.HELPER_PC_CODE_REVISION;
  const root = path.resolve(__dirname, "..");
  try {
    let gitDir = path.join(root, ".git");
    if (!(await fs.stat(gitDir)).isDirectory()) {
      const pointer = (await fs.readFile(gitDir, "utf8")).trim();
      if (!pointer.startsWith("gitdir: ")) return null;
      gitDir = path.resolve(root, pointer.slice(8));
    }
    const head = (await fs.readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
    if (!head.startsWith("ref: ")) return head;
    const ref = head.slice(5);
    try {
      return (await fs.readFile(path.join(gitDir, ref), "utf8")).trim();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const packed = await fs.readFile(path.join(gitDir, "packed-refs"), "utf8");
      const match = packed.split("\n").find((line) => line.endsWith(` ${ref}`));
      return match ? match.split(" ")[0] : null;
    }
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5 * 60 * 1000 });
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) {
    throw new Error(`autoPush failed: git ${args.join(" ")}: ${String(result.stderr || result.signal || result.status).trim()}`);
  }
  return String(result.stdout || "").trim();
}

function deploymentPreflight(files, cwd) {
  if (git(["rev-parse", "--is-inside-work-tree"], cwd) !== "true") throw new Error("autoPush requires a git repository");
  const root = git(["rev-parse", "--show-toplevel"], cwd);
  const targetFiles = files.map((file) => path.relative(root, file));
  if (targetFiles.some((file) => file === ".." || file.startsWith(`..${path.sep}`) || path.isAbsolute(file))) {
    throw new Error("autoPush artifact paths must be inside the repository");
  }
  const allowed = new Set(targetFiles);
  const assertStagedTargets = () => {
    const staged = git(["diff", "--cached", "--name-only", "-z"], root).split("\0").filter(Boolean);
    const unrelated = staged.filter((file) => !allowed.has(file));
    if (unrelated.length) throw new Error(`autoPush refuses unrelated staged changes: ${unrelated.join(", ")}`);
  };
  assertStagedTargets();
  const branch = git(["branch", "--show-current"], root);
  if (!branch) throw new Error("autoPush refuses detached HEAD");
  return { root, targetFiles, branch, assertStagedTargets };
}

function autoCommitAndPush(preflight, commitMessage) {
  const { root, targetFiles, branch, assertStagedTargets } = preflight;
  assertStagedTargets();
  git(["add", "--", ...targetFiles], root);
  assertStagedTargets();
  const changed = git(["diff", "--cached", "--name-only", "--", ...targetFiles], root);
  if (changed) git(["commit", "--only", "-m", commitMessage, "--", ...targetFiles], root);
  git(["push"], root);
  return { state: "pushed", committed: Boolean(changed), branch };
}

async function verifyDeployment(baseUrl, expected, { attempts, delayMs, timeoutMs }) {
  let failure;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/model/status`, {
        signal: AbortSignal.timeout(timeoutMs), headers: { "Cache-Control": "no-cache" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const remote = await response.json();
      if (remote.status !== "ready" || remote.modelType !== MODEL_TYPE || remote.modelValidationIndependent !== true
        || remote.modelVersion !== expected.modelVersion || remote.modelHash !== expected.modelHash
        || remote.featureSchemaVersion !== FEATURE_SCHEMA_VERSION) {
        throw new Error("Remote count model type/schema/hash do not match promoted artifacts");
      }
      return { state: "verified", verifiedAt: new Date().toISOString(), attempts: attempt, remote };
    } catch (error) {
      failure = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`Deployment verification failed after ${attempts} attempts: ${failure.message}`);
}

async function main() {
  assertSupportedRuntime();
  const args = parseArgs(process.argv.slice(2));
  const today = seoulToday();
  let from = args.from ? String(args.from) : null;
  const to = String(args.to || today);
  const paths = {
    snapshots: path.resolve(String(args.snapshots || "data/prediction_snapshots.ndjson")),
    historical: path.resolve(String(args.historical || "data/historical_inputs.kbo.ndjson")),
    results: path.resolve(String(args.results || "data/game_results.kbo.ndjson")),
    examples: path.resolve(String(args.examples || "data/run_training_examples.kbo.ndjson")),
    model: path.resolve(String(args.model || "data/run_model.kbo.json")),
    retrainStatus: path.resolve(String(args.retrainStatus || "data/daily_retrain_status.kbo.json")),
    status: path.resolve(String(args.status || "data/helper_status.kbo.json")),
  };
  const release = await acquireLock(path.resolve(String(args.lock || `${paths.model}.helper.lock`)));
  const status = {
    ok: false, startedAt: new Date().toISOString(), stage: "configuration", failure: null,
    from, to, featureSchemaVersion: FEATURE_SCHEMA_VERSION, modelType: MODEL_TYPE,
    modelVersion: null, modelHash: null, codeRevision: null, deployment: { state: "not_deployed" },
  };
  let staging;
  let promoted = false;
  let autoPush = false;
  try {
    rejectObsoleteOptions(args);
    from = await resolveOpeningDate(args, today);
    status.from = from;
    assertDateRange(from, to);
    autoPush = booleanFlag(args.autoPush ?? process.env.HELPER_PC_AUTO_PUSH, false);
    const collectOnly = booleanFlag(args.collectOnly, false);
    const fetchResults = booleanFlag(args.fetchResults, true);
    const bootstrapHistorical = booleanFlag(args.bootstrapHistorical, false);
    if (bootstrapHistorical && collectOnly) throw new Error("--bootstrapHistorical cannot be combined with --collectOnly");
    const shouldVerify = booleanFlag(args.verifyDeployment, autoPush);
    const timeoutMs = integerFlag(args.stageTimeoutMs ?? process.env.HELPER_PC_STAGE_TIMEOUT_MS, 25 * 60 * 1000, 1);
    const httpTimeoutMs = integerFlag(args.timeoutMs, 15000, 1);
    const verifyAttempts = integerFlag(args.verifyAttempts, 8, 1);
    const verifyDelayMs = integerFlag(args.verifyDelayMs, 15000, 0);
    const correctionDays = integerFlag(args.correctionDays, 3, 0);
    const retryCount = integerFlag(args.retryCount, 3, 1);
    const retryDelayMs = integerFlag(args.retryDelayMs, 7000, 0);
    const baseUrl = String(args.baseUrl || process.env.PREDICT_BASE_URL || "https://kbo-predictor.vercel.app").replace(/\/$/, "");
    status.codeRevision = await codeRevision();
    status.collectOnly = collectOnly;
    try {
      const previousBytes = await fs.readFile(paths.model);
      const previous = JSON.parse(previousBytes);
      if (validateModel(previous) && previous.validationIndependent === true) {
        status.modelVersion = previous.version;
        status.modelHash = sha256(previousBytes);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fs.mkdir(path.dirname(paths.model), { recursive: true });
    staging = await fs.mkdtemp(path.join(path.dirname(paths.model), ".helper-"));
    const staged = Object.fromEntries(Object.keys(paths).map((key) => [key, path.join(staging, `${key}-${path.basename(paths[key])}`)]));
    await atomicWrite(staged.snapshots, ndjson(await readNdjson(paths.snapshots, { allowMissing: true })));
    await copyIfPresent(paths.results, staged.results);
    if (!collectOnly) await atomicWrite(staged.historical, ndjson(await readNdjson(paths.historical, { allowMissing: bootstrapHistorical || args.historical === undefined })));
    const setStage = async (stage) => {
      status.stage = stage;
      await writeJson(paths.status, status);
    };
    await setStage("collect-snapshots");
    if (to >= today) {
      const previousSnapshots = new Set((await readNdjson(staged.snapshots, { allowMissing: true })).map((row) => JSON.stringify(row)));
      await runNodeScript("backfill-snapshots.js", [
        `--from=${today}`, `--to=${to}`, `--baseUrl=${baseUrl}`,
        `--output=${staged.snapshots}`, `--timeoutMs=${httpTimeoutMs}`,
        ...(args.pregameWindowMinutes === undefined ? [] : [`--pregameWindowMinutes=${args.pregameWindowMinutes}`]),
      ], { cwd: staging, timeoutMs });
      const collectedArchive = await readNdjson(staged.snapshots, { allowMissing: true });
      status.snapshotRowsCollected = collectedArchive.filter((row) => !previousSnapshots.has(JSON.stringify(row))).length;
      if (status.snapshotRowsCollected > 0) {
        await promoteArtifacts([{ source: staged.snapshots, target: paths.snapshots }]);
        status.snapshotCollection = "collected";
      } else status.snapshotCollection = "no_pregame_rows";
    } else {
      status.snapshotCollection = "skipped_historical";
    }
    if (bootstrapHistorical) {
      await setStage("bootstrap-historical");
      const historicalTo = to < today ? to : shiftDate(today, -1);
      await runNodeScript("bootstrap-historical.js", [
        `--from=${from}`, `--to=${historicalTo}`, `--output=${staged.historical}`,
        `--results=${staged.results}`, `--cacheDir=${path.join(path.dirname(paths.historical), "historical-cache")}`,
        `--timeoutMs=${httpTimeoutMs}`,
      ], { cwd: staging, timeoutMs });
      await promoteArtifacts([
        { source: staged.historical, target: paths.historical },
        { source: staged.results, target: paths.results },
      ]);
    }
    await setStage("collect-results");
    if (fetchResults) {
      status.fetchFrom = await fetchIncrementalResults({
        from, to, results: staged.results, correctionDays, retryCount, retryDelayMs, cwd: staging, timeoutMs,
      });
      await promoteArtifacts([{ source: staged.results, target: paths.results }]);
    } else {
      if (!collectOnly) await readNdjson(staged.results);
      status.fetchFrom = null;
    }
    if (collectOnly) {
      Object.assign(status, { ok: true, stage: "collected", finishedAt: new Date().toISOString() });
      await writeJson(paths.status, status);
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    status.historicalInputRows = (await readNdjson(staged.historical)).length;
    status.historicalBootstrap = bootstrapHistorical;
    await setStage("retrain");
    const retrainArgs = [
      `--from=${from}`, `--to=${to}`, `--results=${staged.results}`, `--snapshots=${staged.snapshots}`,
      `--historical=${staged.historical}`,
      `--examples=${staged.examples}`, `--model=${staged.model}`, `--status=${staged.retrainStatus}`,
      "--fetchResults=false", `--stageTimeoutMs=${timeoutMs}`,
    ];
    for (const key of ["epochs", "holdoutDays", "minExamples", "lr", "l2"]) {
      if (args[key] !== undefined) retrainArgs.push(`--${key}=${args[key]}`);
    }
    await runNodeScript("retrain-daily.js", retrainArgs, { cwd: staging, timeoutMs });
    const retrain = await readJson(staged.retrainStatus);
    if (retrain.ok !== true || retrain.skipped === true || retrain.stage !== "completed") {
      throw new Error("Retrain health gate rejected skipped/failed output");
    }
    const modelBytes = await fs.readFile(staged.model);
    const model = validateTrainedModel(JSON.parse(modelBytes));
    if (retrain.modelType !== MODEL_TYPE || retrain.featureSchemaVersion !== FEATURE_SCHEMA_VERSION
      || retrain.modelHash !== sha256(modelBytes) || retrain.modelVersion !== model.version) {
      throw new Error("Retrain status/model hashes mismatch");
    }
    Object.assign(status, {
      modelVersion: model.version, modelHash: sha256(modelBytes),
      validation: model.metrics.validation,
    });
    let preflight;
    if (autoPush) {
      await setStage("deploy-preflight");
      preflight = deploymentPreflight([paths.model, paths.retrainStatus], process.cwd());
    }
    await setStage("promote");
    await writeJson(staged.status, status);
    await promoteArtifacts([
      { source: staged.model, target: paths.model },
      { source: staged.retrainStatus, target: paths.retrainStatus },
      { source: staged.examples, target: paths.examples },
      { source: staged.status, target: paths.status },
    ]);
    promoted = true;
    if (autoPush) {
      await setStage("deploy");
      status.deployment = autoCommitAndPush(preflight, String(args.commitMessage || "Update confirmed-lineup run model"));
      await writeJson(paths.status, status);
      if (shouldVerify) {
        await setStage("verify-deployment");
        status.deployment = await verifyDeployment(baseUrl, status, {
          attempts: verifyAttempts, delayMs: verifyDelayMs, timeoutMs: httpTimeoutMs,
        });
      } else status.deployment = { ...status.deployment, state: "pushed_unverified" };
    }
    Object.assign(status, { ok: true, stage: "completed", finishedAt: new Date().toISOString() });
    await writeJson(paths.status, status);
    console.log(JSON.stringify(status, null, 2));
  } catch (error) {
    status.ok = false;
    status.failure = { stage: status.stage, message: error.message };
    status.finishedAt = new Date().toISOString();
    status.promoted = promoted;
    if (autoPush && ["deploy-preflight", "deploy", "verify-deployment"].includes(status.stage)) {
      status.deployment = { ...status.deployment, state: "failed", error: error.message };
    }
    if (!promoted) {
      try {
        const activeBytes = await fs.readFile(paths.model);
        const active = JSON.parse(activeBytes);
        status.modelVersion = validateModel(active) && active.validationIndependent === true ? active.version : null;
        status.modelHash = status.modelVersion ? sha256(activeBytes) : null;
      } catch (readError) {
        if (readError.code === "ENOENT") {
          status.modelVersion = null;
          status.modelHash = null;
        } else status.activeModelError = readError.message;
      }
    }
    await writeJson(paths.status, status);
    throw error;
  } finally {
    if (staging) await fs.rm(staging, { recursive: true, force: true });
    await release();
  }
}

module.exports = { verifyDeployment };

if (require.main === module) {
  main().catch((error) => {
    console.error(`[helper-pc] ${error.message}`);
    process.exitCode = 1;
  });
}
