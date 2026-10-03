const fs = require("fs/promises");
const path = require("path");
const { parseArgs } = require("./ml-utils");
const { FEATURE_SCHEMA_VERSION, isPregameSnapshot } = require("../lib/prediction-contract");
const { FEATURE_NAMES, readRows, validateRange, inRange } = require("../lib/logistic");

function buildExamples(snapshots, results, { from, to } = {}) {
  validateRange(from, to);
  const exclusions = { invalidSnapshot: 0, incomplete: 0, invalidScore: 0, draw: 0,
    missingPregameSnapshot: 0, invalidFeatures: 0, dateMismatch: 0, outOfRange: 0 };
  const latest = new Map();
  for (const row of snapshots) {
    if (String(row.league || "kbo").toLowerCase() !== "kbo") continue;
    if (!isPregameSnapshot(row) || typeof row.gameKey !== "string" || !row.gameKey) {
      exclusions.invalidSnapshot += 1;
      continue;
    }
    if (!FEATURE_NAMES.every((name) => Number.isFinite(row.features[name]))) {
      exclusions.invalidFeatures += 1;
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
    if (!Number.isFinite(result.homeScore) || !Number.isFinite(result.awayScore)
        || result.homeScore < 0 || result.awayScore < 0) { exclusions.invalidScore += 1; continue; }
    if (result.homeScore === result.awayScore) { exclusions.draw += 1; continue; }
    const snapshot = latest.get(result.gameKey);
    if (!snapshot) { exclusions.missingPregameSnapshot += 1; continue; }
    if (result.gameDate !== snapshot.gameDate) { exclusions.dateMismatch += 1; continue; }
    examples.push({
      league: "kbo", gameId: result.gameId, gameKey: result.gameKey, gameDate: result.gameDate,
      awayTeam: result.awayTeam, homeTeam: result.homeTeam, mode: snapshot.mode,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION, gameState: snapshot.gameState,
      gameStartsAt: snapshot.gameStartsAt, asOfTimestamp: snapshot.asOfTimestamp,
      homeScore: result.homeScore, awayScore: result.awayScore,
      labelHomeWin: result.homeScore > result.awayScore ? 1 : 0,
      ...Object.fromEntries(FEATURE_NAMES.map((name) => [name, snapshot.features[name]])),
    });
  }
  examples.sort((a, b) => a.gameDate.localeCompare(b.gameDate) || a.gameKey.localeCompare(b.gameKey));
  return { examples, summary: { snapshots: snapshots.length, results: results.length,
    examples: examples.length, exclusions } };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.marketOdds !== undefined) throw new Error("--marketOdds was removed: schema-2 training uses only archived inference features");
  const snapshotsPath = args.snapshots || path.join(process.cwd(), "data", "prediction_snapshots.ndjson");
  const resultsPath = args.results || path.join(process.cwd(), "data", "game_results.kbo.ndjson");
  const outputPath = args.output || path.join(process.cwd(), "data", "training_examples.kbo.ndjson");
  const { examples, summary } = buildExamples(await readRows(snapshotsPath), await readRows(resultsPath), args);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, examples.map((row) => JSON.stringify(row)).join("\n") + (examples.length ? "\n" : ""), "utf8");
  console.log(JSON.stringify({ output: outputPath, ...summary }));
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildExamples, main };
