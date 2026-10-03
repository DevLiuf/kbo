const path = require("path");
const { parseArgs, iterDates } = require("./ml-utils");
const { FEATURE_SCHEMA_VERSION, isPregameSnapshot } = require("../lib/prediction-contract");
const { assertDateRange, atomicWrite, ndjson, readNdjson, seoulToday } = require("../lib/artifacts");
const { assertSupportedRuntime } = require("../lib/runtime");
const { FEATURE_NAMES } = require("../lib/logistic");

function buildSnapshotRow(payload, prediction) {
  return {
    ...prediction,
    league: "kbo",
    asOfTimestamp: prediction.asOfTimestamp || payload.asOfTimestamp,
    gameDate: prediction.gameDate || payload.date,
    gameKey: prediction.gameKey || prediction.gameId,
    features: prediction.features,
  };
}

function mergeArchive(existing, collected) {
  const archive = [];
  const latest = new Map();
  for (const row of [...existing, ...collected]) {
    const gameKey = String(row.gameKey || row.gameId || "").trim();
    if (!isPregameSnapshot(row) || !gameKey) {
      archive.push(row);
      continue;
    }
    const key = JSON.stringify([gameKey, row.mode || "", row.featureSchemaVersion]);
    const current = latest.get(key);
    if (!current || Date.parse(row.asOfTimestamp) > Date.parse(current.asOfTimestamp)) latest.set(key, row);
  }
  return [...archive, ...latest.values()];
}

async function main() {
  assertSupportedRuntime();
  const args = parseArgs(process.argv.slice(2));
  const from = String(args.from || "");
  const to = String(args.to || from);
  assertDateRange(from, to);
  const today = seoulToday();
  const collectionFrom = from > today ? from : today;
  const snapshotsPath = path.resolve(String(args.output || args.snapshots || "data/prediction_snapshots.ndjson"));
  const timeoutMs = Number(args.timeoutMs || 15000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("--timeoutMs must be a positive integer");
  const summary = { requestedDates: 0, successDates: 0, predictionRows: 0, writtenRows: 0, failedDates: 0 };
  if (to < today) {
    console.log(JSON.stringify({ from, to, snapshotsPath, skipped: true, reason: "historical_collection_forbidden", summary }));
    return;
  }
  const baseUrl = String(args.baseUrl || "http://localhost:3000").replace(/\/$/, "");
  const existing = await readNdjson(snapshotsPath, { allowMissing: true });
  const collected = [];
  const failures = [];
  const dates = iterDates(collectionFrom, to);
  summary.requestedDates = dates.length;
  for (const date of dates) {
    const url = new URL(`${baseUrl}/api/predictions/gameday`);
    url.searchParams.set("date", date);
    url.searchParams.set("includeFinished", "false");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!payload || !Array.isArray(payload.predictions)
        || (payload.date !== date && !(payload.predictions.length === 0 && payload.requestedDate === date))
        || !Number.isFinite(Date.parse(payload.asOfTimestamp))) {
        throw new Error("Invalid gameday response schema");
      }
      for (const prediction of payload.predictions) {
        summary.predictionRows += 1;
        if (!prediction || prediction.featureSchemaVersion !== FEATURE_SCHEMA_VERSION
          || typeof prediction.gameStartsAt !== "string" || !Number.isFinite(Date.parse(prediction.gameStartsAt))
          || String(prediction.gameDate || payload.date) !== date
          || !String(prediction.gameKey || prediction.gameId || "").trim()) {
          throw new Error("Invalid schema2 prediction");
        }
        const row = buildSnapshotRow(payload, prediction);
        if (isPregameSnapshot(row)) {
          const input = row.scoreModelInputs;
          if (!FEATURE_NAMES.every((name) => Number.isFinite(row.features[name]))
            || !input || !Number.isFinite(input.baselineAwayRuns) || !Number.isFinite(input.baselineHomeRuns)
            || typeof input.saberApplied !== "boolean"
            || ![input.markovAwayRuns, input.markovHomeRuns, input.monteCarloAwayRuns, input.monteCarloHomeRuns]
              .every((value) => value === null || Number.isFinite(value))) {
            throw new Error("Invalid raw pregame features/scoreModelInputs");
          }
          collected.push(row);
        } else if (prediction.trainingEligible === true) throw new Error("Invalid eligible pregame prediction");
      }
      summary.successDates += 1;
    } catch (error) {
      summary.failedDates += 1;
      failures.push(`${date}: ${error.message}`);
    }
  }
  if (failures.length) throw new Error(`Snapshot collection failed; archive unchanged: ${failures.join("; ")}`);
  if (collected.length) {
    const merged = mergeArchive(existing, collected);
    await atomicWrite(snapshotsPath, ndjson(merged));
    summary.writtenRows = collected.length;
  }
  console.log(JSON.stringify({
    from, to, collectionFrom, snapshotsPath, summary,
    resetSnapshots: false,
    archivePolicy: "preserve-existing-games-and-latest-valid-pregame-per-mode-schema",
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
