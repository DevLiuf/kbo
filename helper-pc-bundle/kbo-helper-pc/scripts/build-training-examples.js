const fs = require("fs/promises");
const path = require("path");

const { parseArgs, readNdjson } = require("./ml-utils");

const CONTACT_TO_RPG_COEFF = 8;
const POWER_TO_RPG_COEFF = 0.9;
const POWER_CONTACT_MIX_COEFF = 1.6;
const CONTACT_PENALTY_MIX_COEFF = 10;

function buildReconstructedMlBattingFeatures({ offenseDiff, battingAvgDiff, hrPerGameDiff }) {
  const runCreationResidualDiff = offenseDiff - (
    (battingAvgDiff * CONTACT_TO_RPG_COEFF)
    + (hrPerGameDiff * POWER_TO_RPG_COEFF)
  );
  const powerContactMixDiff =
    (hrPerGameDiff * POWER_CONTACT_MIX_COEFF)
    - (battingAvgDiff * CONTACT_PENALTY_MIX_COEFF);

  return {
    runCreationResidualDiff,
    powerContactMixDiff,
  };
}

function resolveRowGameKey(row) {
  return String(row.gameKey || row.gameId || "").trim();
}

function latestSnapshotsByGame(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = resolveRowGameKey(row);
    if (!key) {
      continue;
    }

    const rowTimestamp = typeof row.asOfTimestamp === "string" ? row.asOfTimestamp : "";
    const current = map.get(key);
    const currentTimestamp = current && typeof current.asOfTimestamp === "string"
      ? current.asOfTimestamp
      : "";
    if (!current || rowTimestamp > currentTimestamp) {
      map.set(key, row);
    }
  }
  return map;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshotsPath = args.snapshots || path.join(process.cwd(), "data", "prediction_snapshots.ndjson");
  const resultsPath = args.results || path.join(process.cwd(), "data", "game_results.kbo.ndjson");
  const outputPath = args.output || path.join(process.cwd(), "data", "training_examples.kbo.ndjson");

  const snapshots = (await readNdjson(snapshotsPath)).filter((row) => String(row.league || "kbo").toLowerCase() === "kbo");
  const results = (await readNdjson(resultsPath)).filter((row) => String(row.league || "kbo").toLowerCase() === "kbo");

  const latestSnapshot = latestSnapshotsByGame(snapshots);
  const completedResults = results.filter((row) => row.completed === true);

  const examples = [];
  for (const result of completedResults) {
    const resultKey = resolveRowGameKey(result);
    if (!resultKey) {
      continue;
    }

    const snapshot = latestSnapshot.get(resultKey);
    if (!snapshot || !snapshot.features) {
      continue;
    }

    const labelHomeWin = result.homeScore > result.awayScore ? 1 : 0;
    const feat = snapshot.features;
    const offenseDiff = Number(feat.offenseDiff) || 0;
    const battingAvgDiff = Number(feat.battingAvgDiff) || 0;
    const hrPerGameDiff = Number(feat.hrPerGameDiff) || 0;
    const reconstructed = buildReconstructedMlBattingFeatures({
      offenseDiff,
      battingAvgDiff,
      hrPerGameDiff,
    });

    examples.push({
      league: "kbo",
      gameId: result.gameId,
      gameKey: resultKey,
      gameDate: result.gameDate,
      mode: snapshot.mode,
      labelHomeWin,
      offenseDiff,
      defenseDiff: Number(feat.defenseDiff) || 0,
      starterEraDiff: Number(feat.starterEraDiff) || 0,
      battingAvgDiff,
      hrPerGameDiff,
      runCreationResidualDiff: Number(reconstructed.runCreationResidualDiff) || 0,
      powerContactMixDiff: Number(reconstructed.powerContactMixDiff) || 0,
      starterHitsPer9Diff: Number(feat.starterHitsPer9Diff) || 0,
      starterHrPer9Diff: Number(feat.starterHrPer9Diff) || 0,
      starterFreePassPer9Diff: Number(feat.starterFreePassPer9Diff) || 0,
      starterSoPer9Diff: Number(feat.starterSoPer9Diff) || 0,
      starterRunsPer9Diff: Number(feat.starterRunsPer9Diff) || 0,
      whipDiff: Number(feat.whipDiff) || 0,
      bullpenDiff: Number(feat.bullpenDiff) || 0,
      homeAdvantage: Number(feat.homeAdvantage) || 0,
      lineupSignal: feat.lineupConfirmed ? 1 : 0,
    });
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const content = examples.map((row) => JSON.stringify(row)).join("\n") + (examples.length ? "\n" : "");
  await fs.writeFile(outputPath, content, "utf8");
  console.log(`built ${examples.length} KBO training examples`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
