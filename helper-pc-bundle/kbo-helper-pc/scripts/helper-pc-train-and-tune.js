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

function runNodeScript(scriptFile, scriptArgs = []) {
  const result = spawnSync(process.execPath, [scriptFile, ...scriptArgs], {
    stdio: "inherit",
    cwd: process.cwd(),
  });

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

function parseBooleanFlag(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "y";
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const from = String(args.from || "20260331").trim();
  const to = String(args.to || formatDateYYYYMMDD(new Date())).trim();
  const baseUrl = String(
    args.baseUrl
      || process.env.PREDICT_BASE_URL
      || "https://kbo-predictor.vercel.app",
  ).replace(/\/$/, "");
  const autoPush = parseBooleanFlag(args.autoPush || process.env.HELPER_PC_AUTO_PUSH);
  const commitMessage = String(args.commitMessage || "Update ML model and saber tuning outputs").trim();

  if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) {
    throw new Error("Usage: node scripts/helper-pc-train-and-tune.js --from=YYYYMMDD --to=YYYYMMDD [--baseUrl=https://kbo-predictor.vercel.app]");
  }

  console.log("[helper-pc] 1/2 ML retrain start");
  runNodeScript(path.join("scripts", "retrain-daily.js"));

  console.log("[helper-pc] 2/2 Saber tuning start");
  runNodeScript(path.join("scripts", "tune-saber-weights.js"), [
    `--from=${from}`,
    `--to=${to}`,
    `--baseUrl=${baseUrl}`,
  ]);

  const modelPath = path.join(process.cwd(), "data", "model_coefficients.kbo.json");
  const saberPath = path.join(process.cwd(), "data", "saber_tuning_status.kbo.json");
  const model = await readJson(modelPath);
  const saber = await readJson(saberPath);
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
    saberTunedAt: saber.tunedAt,
    saberRange: {
      from: saber.rangeFrom || null,
      to: saber.rangeTo || null,
    },
    autoPush: autoPushResult,
    next: {
      commit: "git add data/model_coefficients.kbo.json data/saber_tuning_status.kbo.json && git commit -m \"Update ML model and saber tuning outputs\" && git push",
      auto: "node scripts/helper-pc-train-and-tune.js --from=20260331 --autoPush=true",
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
