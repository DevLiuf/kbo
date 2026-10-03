const { atomicWrite, ndjson, readNdjson } = require("../lib/artifacts");
const path = require("path");
const { parseArgs } = require("./ml-utils");
const { FEATURE_SCHEMA_VERSION, isPregameSnapshot } = require("../lib/prediction-contract");
const { validateRange, inRange, rejectObsoleteOptions } = require("./score-training-utils");
const { validateInputs } = require("../lib/score-model");

function buildExamples(snapshots, results, { from, to } = {}) {
  validateRange(from, to);
  const exclusions = { invalidSnapshot: 0, incomplete: 0, invalidScore: 0,
    missingPregameSnapshot: 0, invalidInputs: 0, dateMismatch: 0, outOfRange: 0 };
  const latest = new Map();
  for (const row of snapshots) {
    if (String(row.league || "kbo").toLowerCase() !== "kbo") continue;
    if (!isPregameSnapshot(row) || typeof row.gameKey !== "string" || !row.gameKey) {
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
  const resultMap = new Map();
  for (const row of results) {
    if (String(row.league || "kbo").toLowerCase() === "kbo" && row.gameKey) resultMap.set(row.gameKey, row);
  }
  const examples = [];
  for (const result of resultMap.values()) {
    if (!inRange(result, from, to)) { exclusions.outOfRange += 1; continue; }
    if (result.completed !== true) { exclusions.incomplete += 1; continue; }
    if (!Number.isInteger(result.homeScore) || !Number.isInteger(result.awayScore)
        || result.homeScore < 0 || result.awayScore < 0) { exclusions.invalidScore += 1; continue; }
    const snapshot = latest.get(result.gameKey);
    if (!snapshot) { exclusions.missingPregameSnapshot += 1; continue; }
    if (result.gameDate !== snapshot.gameDate) { exclusions.dateMismatch += 1; continue; }
    examples.push({
      league: "kbo", gameId: result.gameId, gameKey: result.gameKey, gameDate: result.gameDate,
      awayTeam: result.awayTeam, homeTeam: result.homeTeam, mode: snapshot.mode,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION, gameState: snapshot.gameState,
      lineupConfirmed: true, trainingEligible: true,
      gameStartsAt: snapshot.gameStartsAt, asOfTimestamp: snapshot.asOfTimestamp,
      homeScore: result.homeScore, awayScore: result.awayScore,
      modelInputs: snapshot.modelInputs,
    });
  }
  examples.sort((a, b) => a.gameDate.localeCompare(b.gameDate) || a.gameKey.localeCompare(b.gameKey));
  return { examples, summary: { snapshots: snapshots.length, results: results.length,
    examples: examples.length, exclusions } };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  rejectObsoleteOptions(args);
  const snapshotsPath = args.snapshots || path.join(process.cwd(), "data", "prediction_snapshots.ndjson");
  const resultsPath = args.results || path.join(process.cwd(), "data", "game_results.kbo.ndjson");
  const outputPath = args.output || path.join(process.cwd(), "data", "run_training_examples.kbo.ndjson");
  const { examples, summary } = buildExamples(await readNdjson(snapshotsPath), await readNdjson(resultsPath), args);
  await atomicWrite(outputPath, ndjson(examples));
  console.log(JSON.stringify({ output: outputPath, ...summary }));
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildExamples, main };
