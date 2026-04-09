const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const { parseArgs, readNdjson } = require("./ml-utils");

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function resolveKboOpeningDay(now) {
  const year = now.getFullYear();
  const configured = String(process.env.KBO_OPENING_DAY || "").trim();
  if (/^\d{8}$/.test(configured) && configured.startsWith(String(year))) {
    return configured;
  }
  return `${year}0331`;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function runNodeScript(scriptFile, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptFile, ...args], {
      cwd: process.cwd(),
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${path.basename(scriptFile)} exited with code ${code}`));
    });
  });
}

async function retry(taskName, attempts, retryDelayMs, fn) {
  let lastError = null;

  for (let i = 1; i <= attempts; i += 1) {
    try {
      console.log(`[daily-retrain] ${taskName} attempt ${i}/${attempts}`);
      await fn();
      return;
    } catch (error) {
      lastError = error;
      console.error(`[daily-retrain] ${taskName} failed: ${error.message}`);
      if (i < attempts) {
        console.log(`[daily-retrain] waiting ${retryDelayMs}ms before retry`);
        await sleep(retryDelayMs);
      }
    }
  }

  throw lastError;
}

async function writeStatus(statusPath, payload) {
  await fs.mkdir(path.dirname(statusPath), { recursive: true });
  await fs.writeFile(statusPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const league = "kbo";

  const now = new Date();
  const defaultFrom = resolveKboOpeningDay(now);
  const defaultTo = formatDate(now);

  const from = args.from || defaultFrom;
  const to = args.to || defaultTo;
  const holdoutDays = Number(args.holdoutDays || 3);
  const retryCount = Number(args.retryCount || 3);
  const retryDelayMs = Number(args.retryDelayMs || 7000);
  const minExamples = Number(args.minExamples || 30);

  const resultsPath = path.join(process.cwd(), "data", `game_results.${league}.ndjson`);
  const examplesPath = path.join(process.cwd(), "data", `training_examples.${league}.ndjson`);
  const modelPath = path.join(process.cwd(), "data", `model_coefficients.${league}.json`);
  const modelBackupPath = path.join(process.cwd(), "data", `model_coefficients.${league}.backup.json`);
  const statusPath = path.join(process.cwd(), "data", `daily_retrain_status.${league}.json`);

  const startedAt = new Date().toISOString();
  console.log(`[daily-retrain] start league=${league} from=${from} to=${to} holdoutDays=${holdoutDays}`);

  try {
    await retry("fetch-results", retryCount, retryDelayMs, async () => {
      await runNodeScript(path.join("scripts", "fetch-results.js"), [
        `--from=${from}`,
        `--to=${to}`,
        `--output=${resultsPath}`,
      ]);
    });

    await runNodeScript(path.join("scripts", "build-training-examples.js"), [
      `--results=${resultsPath}`,
      `--output=${examplesPath}`,
    ]);

    const examples = await readNdjson(examplesPath);
    if (examples.length < minExamples) {
      throw new Error(
        `insufficient training examples (${examples.length} < ${minExamples}), skip retrain to avoid unstable model`,
      );
    }

    try {
      const existing = await fs.readFile(modelPath, "utf8");
      await fs.writeFile(modelBackupPath, existing, "utf8");
      console.log(`[daily-retrain] model backup saved to ${modelBackupPath}`);
    } catch {
      console.log("[daily-retrain] no previous model to backup");
    }

    await runNodeScript(path.join("scripts", "train-logistic.js"), [
      `--input=${examplesPath}`,
      `--output=${modelPath}`,
      `--holdoutDays=${holdoutDays}`,
      `--version=trained-logistic-${league}-${new Date().toISOString().slice(0, 10)}`,
    ]);

    await runNodeScript(path.join("scripts", "eval-logistic.js"), [
      `--input=${examplesPath}`,
      `--model=${modelPath}`,
    ]);

    const finishedAt = new Date().toISOString();
    await writeStatus(statusPath, {
      ok: true,
      league,
      startedAt,
      finishedAt,
      from,
      to,
      holdoutDays,
      retryCount,
      retryDelayMs,
      minExamples,
      message: "daily retrain completed",
    });
    console.log("[daily-retrain] completed");
  } catch (error) {
    const finishedAt = new Date().toISOString();
    await writeStatus(statusPath, {
      ok: false,
      league,
      startedAt,
      finishedAt,
      from,
      to,
      holdoutDays,
      retryCount,
      retryDelayMs,
      minExamples,
      error: error.message,
    });
    console.error(`[daily-retrain] failed: ${error.message}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[daily-retrain] unexpected: ${error.message}`);
  process.exit(1);
});
