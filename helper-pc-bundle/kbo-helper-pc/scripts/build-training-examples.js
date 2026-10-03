const { atomicWrite, ndjson, readNdjson } = require("../lib/artifacts");
const path = require("path");
const { parseArgs } = require("./ml-utils");
const { FEATURE_SCHEMA_VERSION, isPregameSnapshot, isHistoricalTrainingSnapshot } = require("../lib/prediction-contract");
const { validateRange, inRange, rejectObsoleteOptions } = require("./score-training-utils");
const { validateInputs } = require("../lib/score-model");

function buildExamples(snapshots, results, { from, to, historical = [] } = {}) {
  validateRange(from, to);
  const exclusions = { invalidSnapshot: 0, invalidHistoricalSnapshot: 0, incomplete: 0, invalidScore: 0,
    missingTrainingSnapshot: 0, invalidInputs: 0, dateMismatch: 0, idMismatch: 0, outOfRange: 0 };
  const latest = new Map();
  for (const row of snapshots) {
    if (!row || String(row.league || "kbo").toLowerCase() !== "kbo") {
      exclusions.invalidSnapshot += 1;
      continue;
    }
    if (!isPregameSnapshot(row) || typeof row.gameKey !== "string" || !row.gameKey.trim()
        || row.gameId !== row.gameKey) {
      exclusions.invalidSnapshot += 1;
      continue;
    }
    if (!validateInputs(row.modelInputs)) {
      exclusions.invalidInputs += 1;
      continue;
    }
    const current = latest.get(row.gameKey);
    if (!current || Date.parse(row.asOfTimestamp) > Date.parse(current.asOfTimestamp)) latest.set(row.gameKey, row);
  }
  for (const row of historical) {
    if (!isHistoricalTrainingSnapshot(row)) {
      exclusions.invalidHistoricalSnapshot += 1;
      continue;
    }
    const current = latest.get(row.gameKey);
    if (!current || (current.mode === "historical_reconstruction"
        && Date.parse(row.reconstructedAt) > Date.parse(current.reconstructedAt))) latest.set(row.gameKey, row);
  }
  const resultMap = new Map();
  for (const row of results) {
    if (row && String(row.league || "kbo").toLowerCase() === "kbo" && row.gameKey) resultMap.set(row.gameKey, row);
  }
  const examples = [];
  for (const result of resultMap.values()) {
    if (!inRange(result, from, to)) { exclusions.outOfRange += 1; continue; }
    if (result.completed !== true) { exclusions.incomplete += 1; continue; }
    if (!Number.isInteger(result.homeScore) || !Number.isInteger(result.awayScore)
        || result.homeScore < 0 || result.awayScore < 0) { exclusions.invalidScore += 1; continue; }
    const snapshot = latest.get(result.gameKey);
    if (!snapshot) { exclusions.missingTrainingSnapshot += 1; continue; }
    if (result.gameDate !== snapshot.gameDate) { exclusions.dateMismatch += 1; continue; }
    if (typeof result.gameId !== "string" || !result.gameId.trim()
        || result.gameId !== snapshot.gameId || result.gameKey !== result.gameId) {
      exclusions.idMismatch += 1;
      continue;
    }
    examples.push({
      league: "kbo", gameId: result.gameId, gameKey: result.gameKey, gameDate: result.gameDate,
      awayTeam: result.awayTeam, homeTeam: result.homeTeam, mode: snapshot.mode,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION, gameState: snapshot.gameState,
      lineupConfirmed: true, trainingEligible: true,
      gameStartsAt: snapshot.gameStartsAt, asOfTimestamp: snapshot.asOfTimestamp,
      ...(snapshot.mode === "historical_reconstruction" ? {
        dataOrigin: snapshot.dataOrigin, reconstructedAt: snapshot.reconstructedAt,
        inputsCutoffAt: snapshot.inputsCutoffAt, sourceThroughDate: snapshot.sourceThroughDate,
        awayLineup: snapshot.awayLineup, homeLineup: snapshot.homeLineup,
      } : snapshot.dataOrigin ? { dataOrigin: snapshot.dataOrigin } : {}),
      homeScore: result.homeScore, awayScore: result.awayScore,
      modelInputs: snapshot.modelInputs,
    });
  }
  examples.sort((a, b) => a.gameDate.localeCompare(b.gameDate) || a.gameKey.localeCompare(b.gameKey));
  const historicalExamples = examples.filter((row) => row.mode === "historical_reconstruction").length;
  return { examples, summary: { snapshots: snapshots.length, historicalInputs: historical.length,
    results: results.length, examples: examples.length, historicalExamples,
    liveExamples: examples.length - historicalExamples, exclusions } };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  rejectObsoleteOptions(args);
  const snapshotsPath = args.snapshots || path.join(process.cwd(), "data", "prediction_snapshots.ndjson");
  const resultsPath = args.results || path.join(process.cwd(), "data", "game_results.kbo.ndjson");
  const historicalPath = args.historical ?? path.join(process.cwd(), "data", "historical_inputs.kbo.ndjson");
  const outputPath = args.output || path.join(process.cwd(), "data", "run_training_examples.kbo.ndjson");
  const historical = await readNdjson(historicalPath, { allowMissing: args.historical === undefined });
  const { examples, summary } = buildExamples(
    await readNdjson(snapshotsPath, { allowMissing: args.snapshots === undefined }), await readNdjson(resultsPath),
    { ...args, historical });
  await atomicWrite(outputPath, ndjson(examples));
  console.log(JSON.stringify({ output: outputPath, ...summary }));
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildExamples, main };
