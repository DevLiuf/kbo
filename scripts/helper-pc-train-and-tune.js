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

function runNodeScript(scriptFile, scriptArgs = []) {
  const result = spawnSync(process.execPath, [scriptFile, ...scriptArgs], {
    stdio: "inherit",
    cwd: process.cwd(),
  });

  if (result.status !== 0) {
    throw new Error(`Failed: node ${scriptFile} ${scriptArgs.join(" ")}`);
  }
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
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

  if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) {
    throw new Error("Usage: node scripts/helper-pc-train-and-tune.js --from=YYYYMMDD [--to=YYYYMMDD] [--baseUrl=https://kbo-predictor.vercel.app]");
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
    next: {
      commit: "git add data/model_coefficients.kbo.json data/saber_tuning_status.kbo.json && git commit -m \"Update ML model and saber tuning outputs\" && git push",
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
