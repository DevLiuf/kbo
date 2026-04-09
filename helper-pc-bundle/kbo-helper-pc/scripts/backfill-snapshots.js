const { parseArgs, iterDates } = require("./ml-utils");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const from = args.from;
  const to = args.to || from;
  const includeFinished = String(args.includeFinished || "true") === "true";
  const baseUrl = String(args.baseUrl || "http://localhost:3000").replace(/\/$/, "");

  if (!from || !/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) {
    throw new Error("Usage: node scripts/backfill-snapshots.js --from=YYYYMMDD --to=YYYYMMDD [--includeFinished=true]");
  }

  const dates = iterDates(from, to);
  const summary = { requestedDates: dates.length, successDates: 0, predictionRows: 0, failedDates: 0 };

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
      const count = Array.isArray(payload?.predictions) ? payload.predictions.length : 0;
      summary.successDates += 1;
      summary.predictionRows += count;
    } catch {
      summary.failedDates += 1;
    }
  }

  console.log(JSON.stringify({ from, to, includeFinished, league: "kbo", summary }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
