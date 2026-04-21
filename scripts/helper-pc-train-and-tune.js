const fs = require("fs/promises");
const path = require("path");
const { spawnSync } = require("child_process");

const { parseArgs } = require("./ml-utils");

function formatDateYYYYMMDD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function getSeoulTodayYYYYMMDD() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    return formatDateYYYYMMDD(new Date());
  }

  return `${year}${month}${day}`;
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function parseNumberFlag(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function runNodeScript(scriptFile, scriptArgs = [], timeoutMs = 0) {
  const result = spawnSync(process.execPath, [scriptFile, ...scriptArgs], {
    stdio: "inherit",
    cwd: process.cwd(),
    timeout: timeoutMs > 0 ? timeoutMs : undefined,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`Failed: node ${scriptFile} ${scriptArgs.join(" ")} (signal: ${result.signal})`);
  }
  if (result.status !== 0) {
    throw new Error(`Failed: node ${scriptFile} ${scriptArgs.join(" ")}`);
  }
}

function runCommand(command, commandArgs = [], options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    stdio: options.stdio || "pipe",
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runStageWithRetry(stageName, attempts, retryDelayMs, fn) {
  let lastError = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      console.log(`[helper-pc] ${stageName} attempt ${i}/${attempts}`);
      await fn();
      return;
    } catch (error) {
      lastError = error;
      console.error(`[helper-pc] ${stageName} failed: ${error.message}`);
      if (i < attempts) {
        console.log(`[helper-pc] waiting ${retryDelayMs}ms before retry`);
        await sleep(retryDelayMs);
      }
    }
  }
  throw lastError;
}

function autoCommitAndPush(commitMessage) {
  const gitCheck = runCommand("git", ["rev-parse", "--is-inside-work-tree"]);
  if (gitCheck.status !== 0 || String(gitCheck.stdout || "").trim() !== "true") {
    return {
      status: "skipped",
      reason: "not a git repository",
    };
  }

  const targetFiles = [
    path.join("data", "model_coefficients.kbo.json"),
    path.join("data", "saber_tuning_status.kbo.json"),
    path.join("data", "daily_retrain_status.kbo.json"),
  ];

  const addResult = runCommand("git", ["add", ...targetFiles], { stdio: "inherit" });
  if (addResult.status !== 0) {
    throw new Error("autoPush failed: git add");
  }

  const hasStaged = runCommand("git", ["diff", "--cached", "--quiet"]);
  if (hasStaged.status === 0) {
    return {
      status: "skipped",
      reason: "no staged changes",
    };
  }
  if (hasStaged.status !== 1) {
    throw new Error("autoPush failed: git diff --cached --quiet");
  }

  const commitResult = runCommand("git", ["commit", "-m", commitMessage], { stdio: "inherit" });
  if (commitResult.status !== 0) {
    throw new Error("autoPush failed: git commit");
  }

  const pushResult = runCommand("git", ["push"], { stdio: "inherit" });
  if (pushResult.status !== 0) {
    throw new Error("autoPush failed: git push");
  }

  return {
    status: "done",
    message: commitMessage,
  };
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function assertDateRange(from, to) {
  if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) {
    throw new Error("Usage: node scripts/helper-pc-train-and-tune.js --from=YYYYMMDD [--to=YYYYMMDD] [--baseUrl=https://kbo-predictor.vercel.app]");
  }
  if (from > to) {
    throw new Error(`invalid date range: from(${from}) > to(${to})`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const from = String(args.from || "20260331").trim();
  const to = String(args.to || getSeoulTodayYYYYMMDD()).trim();
  const baseUrl = String(
    args.baseUrl
      || process.env.PREDICT_BASE_URL
      || "https://kbo-predictor.vercel.app",
  ).replace(/\/$/, "");

  assertDateRange(from, to);

  const autoPush = parseBooleanFlag(args.autoPush || process.env.HELPER_PC_AUTO_PUSH, false);
  const resetSnapshots = parseBooleanFlag(args.resetSnapshots || process.env.HELPER_PC_RESET_SNAPSHOTS, false);
  const allowInsufficient = parseBooleanFlag(args.allowInsufficient || process.env.HELPER_PC_ALLOW_INSUFFICIENT, true);
  const stageRetryCount = Math.max(1, parseNumberFlag(args.stageRetryCount || process.env.HELPER_PC_STAGE_RETRY_COUNT, 2));
  const stageRetryDelayMs = Math.max(0, parseNumberFlag(args.stageRetryDelayMs || process.env.HELPER_PC_STAGE_RETRY_DELAY_MS, 5000));
  const stageTimeoutMs = Math.max(0, parseNumberFlag(args.stageTimeoutMs || process.env.HELPER_PC_STAGE_TIMEOUT_MS, 25 * 60 * 1000));
  const minTuneSample = Math.max(1, parseNumberFlag(args.minTuneSample || process.env.HELPER_PC_MIN_TUNE_SAMPLE, 20));
  const commitMessage = String(args.commitMessage || "Update ML model and saber tuning outputs").trim();

  console.log("[helper-pc] 1/3 Snapshot backfill start");
  await runStageWithRetry("snapshot-backfill", stageRetryCount, stageRetryDelayMs, async () => {
    runNodeScript(path.join("scripts", "backfill-snapshots.js"), [
      `--from=${from}`,
      `--to=${to}`,
      "--includeFinished=true",
      `--baseUrl=${baseUrl}`,
      `--resetSnapshots=${resetSnapshots ? "true" : "false"}`,
    ], stageTimeoutMs);
  });

  console.log("[helper-pc] 2/3 ML retrain start");
  await runStageWithRetry("ml-retrain", stageRetryCount, stageRetryDelayMs, async () => {
    runNodeScript(path.join("scripts", "retrain-daily.js"), [
      `--from=${from}`,
      `--to=${to}`,
      `--allowInsufficient=${allowInsufficient ? "true" : "false"}`,
    ], stageTimeoutMs);
  });

  const retrainStatusPath = path.join(process.cwd(), "data", "daily_retrain_status.kbo.json");
  const retrainStatus = await readJson(retrainStatusPath);
  const retrainSkipped = retrainStatus?.ok === true && retrainStatus?.skipped === true;

  const modelPath = path.join(process.cwd(), "data", "model_coefficients.kbo.json");
  const saberPath = path.join(process.cwd(), "data", "saber_tuning_status.kbo.json");
  const model = await readJson(modelPath);

  const hasRetrainTrainRange = retrainStatus?.ok === true
    && retrainSkipped === false
    && /^\d{8}$/.test(String(retrainStatus.trainingFromGameDate || ""))
    && /^\d{8}$/.test(String(retrainStatus.trainingToGameDate || ""));
  const hasModelTrainRange = /^\d{8}$/.test(String(model.trainingFromGameDate || ""))
    && /^\d{8}$/.test(String(model.trainingToGameDate || ""));
  const tuneFrom = hasRetrainTrainRange
    ? String(retrainStatus.trainingFromGameDate)
    : hasModelTrainRange
      ? String(model.trainingFromGameDate)
      : from;
  const tuneTo = hasRetrainTrainRange
    ? String(retrainStatus.trainingToGameDate)
    : hasModelTrainRange
      ? String(model.trainingToGameDate)
      : to;
  assertDateRange(tuneFrom, tuneTo);

  console.log(`[helper-pc] 3/3 Saber tuning start (range: ${tuneFrom}~${tuneTo})`);
  await runStageWithRetry("saber-tuning", stageRetryCount, stageRetryDelayMs, async () => {
    runNodeScript(path.join("scripts", "tune-saber-weights.js"), [
      `--from=${tuneFrom}`,
      `--to=${tuneTo}`,
      `--baseUrl=${baseUrl}`,
    ], stageTimeoutMs);
  });

  const saber = await readJson(saberPath);
  const tuneSampleHealthy = Number(saber.sampleSize || 0) >= minTuneSample;

  const autoPushResult = autoPush
    ? autoCommitAndPush(commitMessage)
    : { status: "disabled" };

  console.log("\n[helper-pc] done");
  console.log(JSON.stringify({
    modelVersion: model.version,
    modelTrainedAt: model.trainedAt,
    trainingRange: {
      from: model.trainingFromGameDate || null,
      to: model.trainingToGameDate || null,
    },
    retrainStatus: {
      ok: retrainStatus?.ok === true,
      skipped: retrainSkipped,
      reason: retrainStatus?.skipReason || null,
      trainingExamples: retrainStatus?.trainingExamples ?? null,
      trainingRange: {
        from: retrainStatus?.trainingFromGameDate || null,
        to: retrainStatus?.trainingToGameDate || null,
      },
    },
    saberTunedAt: saber.tunedAt,
    tuningInputRange: {
      from: tuneFrom,
      to: tuneTo,
    },
    saberRange: {
      from: saber.rangeFrom || null,
      to: saber.rangeTo || null,
    },
    saberSampleSize: saber.sampleSize,
    saberSampleHealthy: tuneSampleHealthy,
    minTuneSample,
    autoPush: autoPushResult,
    next: {
      daily: "node scripts/helper-pc-train-and-tune.js --from=20260331 --autoPush=true",
      resetRun: "node scripts/helper-pc-train-and-tune.js --from=20260331 --resetSnapshots=true",
    },
  }, null, 2));

  if (!tuneSampleHealthy) {
    console.error(`[helper-pc] warning: saber sampleSize(${saber.sampleSize}) < minTuneSample(${minTuneSample})`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
