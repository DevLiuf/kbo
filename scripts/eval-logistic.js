const path = require("path");
const fs = require("fs/promises");

const { parseArgs, readNdjson, sigmoid } = require("./ml-utils");

function dot(model, x) {
  const useReconstructed = Number.isFinite(model.runCreationResidualDiff)
    && Number.isFinite(model.powerContactMixDiff);

  return model.intercept
    + model.offenseDiff * x.offenseDiff
    + model.defenseDiff * x.defenseDiff
    + model.starterEraDiff * x.starterEraDiff
    + (useReconstructed
      ? (model.runCreationResidualDiff * (Number(x.runCreationResidualDiff) || 0))
        + (model.powerContactMixDiff * (Number(x.powerContactMixDiff) || 0))
      : ((Number(model.battingAvgDiff) || 0) * (Number(x.battingAvgDiff) || 0))
        + ((Number(model.hrPerGameDiff) || 0) * (Number(x.hrPerGameDiff) || 0)))
    + (Number(model.starterHitsPer9Diff) || 0) * (Number(x.starterHitsPer9Diff) || 0)
    + (Number(model.starterHrPer9Diff) || 0) * (Number(x.starterHrPer9Diff) || 0)
    + (Number(model.starterFreePassPer9Diff) || 0) * (Number(x.starterFreePassPer9Diff) || 0)
    + (Number(model.starterSoPer9Diff) || 0) * (Number(x.starterSoPer9Diff) || 0)
    + (Number(model.starterRunsPer9Diff) || 0) * (Number(x.starterRunsPer9Diff) || 0)
    + model.whipDiff * x.whipDiff
    + model.bullpenDiff * x.bullpenDiff
    + model.homeAdvantage * x.homeAdvantage
    + model.lineupSignal * x.lineupSignal;
}

function calibratedProb(model, row) {
  const raw = dot(model, row);
  const a = Number.isFinite(model.plattA) ? model.plattA : 1;
  const b = Number.isFinite(model.plattB) ? model.plattB : 0;
  const temperature = Number.isFinite(model.temperature) && model.temperature > 0
    ? model.temperature
    : 1;
  return Math.max(1e-9, Math.min(1 - 1e-9, sigmoid((a * raw + b) / temperature)));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input || path.join(process.cwd(), "data", "training_examples.ndjson");
  const modelFile = args.model || path.join(process.cwd(), "data", "model_coefficients.json");

  const rows = await readNdjson(input);
  if (rows.length === 0) {
    throw new Error("no training examples found");
  }

  const model = JSON.parse(await fs.readFile(modelFile, "utf8"));
  let logLoss = 0;
  let brier = 0;
  let correct = 0;

  for (const row of rows) {
    const p = calibratedProb(model, row);
    logLoss += -(row.labelHomeWin * Math.log(p) + (1 - row.labelHomeWin) * Math.log(1 - p));
    brier += (p - row.labelHomeWin) ** 2;
    correct += (p >= 0.5 ? 1 : 0) === row.labelHomeWin ? 1 : 0;
  }

  console.log("samples", rows.length);
  console.log("accuracy", (correct / rows.length).toFixed(4));
  console.log("logloss", (logLoss / rows.length).toFixed(4));
  console.log("brier", (brier / rows.length).toFixed(4));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
