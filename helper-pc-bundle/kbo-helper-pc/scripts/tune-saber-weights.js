const { parseArgs, iterDates } = require("./ml-utils");

const http = require("http");
const https = require("https");
const fs = require("fs/promises");
const path = require("path");

function fetchJson(url) {
  const client = String(url).startsWith("https://") ? https : http;
  return new Promise((resolve, reject) => {
    client
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
  });
}

function meanAbsoluteError(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  const totalError = rows.reduce((sum, row) => (
    sum + Math.abs(row.predAway - row.actualAway) + Math.abs(row.predHome - row.actualHome)
  ), 0);

  return totalError / (rows.length * 2);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = String(args.baseUrl || "http://localhost:3000").replace(/\/$/, "");
  const from = String(args.from || "").trim();
  const to = String(args.to || "").trim();

  if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) {
    throw new Error("Usage: node scripts/tune-saber-weights.js --from=YYYYMMDD --to=YYYYMMDD [--baseUrl=http://localhost:3000]");
  }

  const allGames = [];
  for (const date of iterDates(from, to)) {
    const payload = await fetchJson(`${baseUrl}/api/predictions/gameday?date=${date}&includeFinished=true`);
    for (const game of payload.predictions || []) {
      if (Number.isFinite(game.actualAwayScore) && Number.isFinite(game.actualHomeScore)) {
        allGames.push(game);
      }
    }
  }

  const candidates = [];
  const clampCandidates = [2.5, 3, 3.5, 4, 4.5];
  const baseCandidates = [0.5, 0.55, 0.6, 0.65, 0.7];
  const markovCandidates = [0.2, 0.25, 0.3, 0.35];
  const monteCandidates = [0.05, 0.1, 0.15, 0.2];

  for (const clampThreshold of clampCandidates) {
    for (const baseWeight of baseCandidates) {
      for (const markovWeight of markovCandidates) {
        for (const monteWeight of monteCandidates) {
          if (Math.abs((baseWeight + markovWeight + monteWeight) - 1) > 1e-9) {
            continue;
          }

          const scored = allGames.map((game) => {
            const modelFeatures = game.modelFeatures || {};
            const baseAway = Number(game.expectedAwayRuns) || 0;
            const baseHome = Number(game.expectedHomeRuns) || 0;
            const markovAway = Number(modelFeatures.markovAwayRuns);
            const markovHome = Number(modelFeatures.markovHomeRuns);
            const monteAway = Number(modelFeatures.monteCarloAwayRuns);
            const monteHome = Number(modelFeatures.monteCarloHomeRuns);

            if (!Number.isFinite(markovAway) || !Number.isFinite(markovHome) || !Number.isFinite(monteAway) || !Number.isFinite(monteHome)) {
              return {
                predAway: baseAway,
                predHome: baseHome,
                actualAway: game.actualAwayScore,
                actualHome: game.actualHomeScore,
              };
            }

            const trustedMarkovAway = Math.abs(markovAway - baseAway) <= clampThreshold ? markovAway : baseAway;
            const trustedMarkovHome = Math.abs(markovHome - baseHome) <= clampThreshold ? markovHome : baseHome;
            const trustedMonteAway = Math.abs(monteAway - baseAway) <= clampThreshold ? monteAway : baseAway;
            const trustedMonteHome = Math.abs(monteHome - baseHome) <= clampThreshold ? monteHome : baseHome;

            return {
              predAway: (baseAway * baseWeight) + (trustedMarkovAway * markovWeight) + (trustedMonteAway * monteWeight),
              predHome: (baseHome * baseWeight) + (trustedMarkovHome * markovWeight) + (trustedMonteHome * monteWeight),
              actualAway: game.actualAwayScore,
              actualHome: game.actualHomeScore,
            };
          });

          candidates.push({
            clampThreshold,
            baseWeight,
            markovWeight,
            monteWeight,
            mae: meanAbsoluteError(scored),
          });
        }
      }
    }
  }

  candidates.sort((a, b) => a.mae - b.mae);

  const best = candidates[0] || null;
  const statusPath = path.join(process.cwd(), "data", "saber_tuning_status.kbo.json");
  await fs.mkdir(path.dirname(statusPath), { recursive: true });
  await fs.writeFile(
    statusPath,
    `${JSON.stringify({
      tunedAt: new Date().toISOString(),
      rangeFrom: from,
      rangeTo: to,
      sampleSize: allGames.length,
      best,
      top5: candidates.slice(0, 5),
    }, null, 2)}\n`,
    "utf8",
  );

  console.log(JSON.stringify({
    sampleSize: allGames.length,
    best,
    top5: candidates.slice(0, 5),
    statusPath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
