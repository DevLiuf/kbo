const fs = require("fs/promises");
const path = require("path");

const { parseArgs, iterDates } = require("./ml-utils");

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "y";
}

function buildSnapshotRow({ payload, prediction, requestedDate }) {
  const asOfTimestamp = typeof payload?.asOfTimestamp === "string"
    ? payload.asOfTimestamp
    : new Date().toISOString();
  const gameDate = String(prediction?.gameDate || payload?.date || requestedDate || "").trim() || requestedDate;

  return {
    asOfTimestamp,
    league: "kbo",
    gameDate,
    gameId: prediction?.gameId,
    gameKey: prediction?.gameKey || prediction?.gameId,
    modelVersion: prediction?.modelVersion,
    mode: prediction?.mode,
    lineupConfirmed: prediction?.lineupConfirmed,
    homeWinProbability: prediction?.homeWinProbability,
    awayWinProbability: prediction?.awayWinProbability,
    predictedHomeScore: prediction?.predictedHomeScore,
    predictedAwayScore: prediction?.predictedAwayScore,
    predictedWinner: prediction?.predictedWinner,
    features: prediction?.modelFeatures || prediction?.features || null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const from = args.from;
  const to = args.to || from;
  const includeFinished = parseBool(args.includeFinished, true);
  const resetSnapshots = parseBool(args.resetSnapshots, false);
  const baseUrl = String(args.baseUrl || "http://localhost:3000").replace(/\/$/, "");
  const snapshotsPath = String(
    args.output
      || args.snapshots
      || path.join(process.cwd(), "data", "prediction_snapshots.ndjson"),
  ).trim();

  if (!from || !/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) {
    throw new Error("Usage: node scripts/backfill-snapshots.js --from=YYYYMMDD --to=YYYYMMDD [--includeFinished=true] [--baseUrl=http://localhost:3000] [--resetSnapshots=true] [--snapshots=path]");
  }

  const dates = iterDates(from, to);
  const summary = {
    requestedDates: dates.length,
    successDates: 0,
    predictionRows: 0,
    writtenRows: 0,
    failedDates: 0,
  };

  await fs.mkdir(path.dirname(snapshotsPath), { recursive: true });
  if (resetSnapshots) {
    await fs.writeFile(snapshotsPath, "", "utf8");
  }

  for (const date of dates) {
    const url = new URL(`${baseUrl}/api/predictions/gameday`);
    url.searchParams.set("date", date);
    url.searchParams.set("includeFinished", String(includeFinished));

    try {
      const response = await fetch(url);
      if (!response.ok) {
        summary.failedDates += 1;
        continue;
      }
      const payload = await response.json();
      const predictions = Array.isArray(payload?.predictions) ? payload.predictions : [];
      const rows = predictions.map((prediction) => JSON.stringify(
        buildSnapshotRow({ payload, prediction, requestedDate: date }),
      ));
      const count = rows.length;

      if (count > 0) {
        await fs.appendFile(snapshotsPath, `${rows.join("\n")}\n`, "utf8");
      }

      summary.successDates += 1;
      summary.predictionRows += count;
      summary.writtenRows += count;
    } catch {
      summary.failedDates += 1;
    }
  }

  console.log(JSON.stringify({
    from,
    to,
    includeFinished,
    resetSnapshots,
    snapshotsPath,
    league: "kbo",
    summary,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
