const fs = require("fs/promises");
const path = require("path");
const http = require("http");

const { iterDates, parseArgs } = require("./ml-utils");

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http
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

function toSafeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (text.includes(",") || text.includes("\n") || text.includes('"')) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function scoreMae(predAway, predHome, actualAway, actualHome) {
  if (
    !Number.isFinite(predAway)
    || !Number.isFinite(predHome)
    || !Number.isFinite(actualAway)
    || !Number.isFinite(actualHome)
  ) {
    return null;
  }

  return (Math.abs(predAway - actualAway) + Math.abs(predHome - actualHome)) / 2;
}

function getTotalBand(totalRuns) {
  if (!Number.isFinite(totalRuns)) {
    return "unknown";
  }
  if (totalRuns <= 7) {
    return "low_total";
  }
  if (totalRuns <= 10) {
    return "mid_total";
  }
  return "high_total";
}

function getEdgeBand(probGap) {
  if (!Number.isFinite(probGap)) {
    return "unknown";
  }
  if (probGap < 0.08) {
    return "coinflip";
  }
  if (probGap < 0.2) {
    return "moderate_edge";
  }
  return "strong_edge";
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  if (valid.length === 0) {
    return null;
  }
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function buildGroupSummary(rows, field) {
  const groups = new Map();

  for (const row of rows) {
    const key = String(row[field] || "unknown");
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(row);
  }

  const summary = {};
  for (const [key, grouped] of groups.entries()) {
    summary[key] = {
      games: grouped.length,
      winnerAccuracy: mean(grouped.map((row) => (row.winnerHit ? 1 : 0))),
      predictedScoreMae: mean(grouped.map((row) => row.predictedScoreMae)),
      saberExpectedMae: mean(grouped.map((row) => row.saberExpectedMae)),
      markovMae: mean(grouped.map((row) => row.markovMae)),
      monteCarloMae: mean(grouped.map((row) => row.monteCarloMae)),
      over85HitRate: mean(grouped.map((row) => (row.over85Hit ? 1 : 0))),
      over85ProbAvg: mean(grouped.map((row) => row.over85Prob)),
    };
  }

  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const from = String(args.from || "").trim();
  const to = String(args.to || "").trim();
  const baseUrl = String(args.baseUrl || "http://localhost:3000").replace(/\/$/, "");
  const outDir = String(args.outDir || path.join(process.cwd(), "data", "backtests"));
  const outPrefix = String(args.outPrefix || `saber_backtest_${from}_${to}`);

  if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) {
    throw new Error("Usage: node scripts/export-saber-backtest-details.js --from=YYYYMMDD --to=YYYYMMDD [--baseUrl=http://localhost:3000]");
  }

  const rows = [];
  for (const date of iterDates(from, to)) {
    const payload = await fetchJson(`${baseUrl}/api/predictions/gameday?date=${date}&includeFinished=true`);
    for (const game of payload.predictions || []) {
      const actualAway = toSafeNumber(game.actualAwayScore);
      const actualHome = toSafeNumber(game.actualHomeScore);
      if (!Number.isFinite(actualAway) || !Number.isFinite(actualHome)) {
        continue;
      }

      const modelFeatures = game.modelFeatures || {};
      const predictedAway = toSafeNumber(game.predictedAwayScore);
      const predictedHome = toSafeNumber(game.predictedHomeScore);
      const expectedAway = toSafeNumber(game.expectedAwayRuns);
      const expectedHome = toSafeNumber(game.expectedHomeRuns);
      const markovAway = toSafeNumber(modelFeatures.markovAwayRuns);
      const markovHome = toSafeNumber(modelFeatures.markovHomeRuns);
      const monteAway = toSafeNumber(modelFeatures.monteCarloAwayRuns);
      const monteHome = toSafeNumber(modelFeatures.monteCarloHomeRuns);
      const over85Prob = toSafeNumber(modelFeatures.monteCarloTotalOver85Prob);
      const actualTotal = actualAway + actualHome;
      const probGap = Math.abs((toSafeNumber(game.homeWinProbability, 0.5)) - (toSafeNumber(game.awayWinProbability, 0.5)));

      const row = {
        gameDate: String(game.gameDate || date),
        gameTime: String(game.gameTime || ""),
        awayTeam: String(game.awayTeam || ""),
        homeTeam: String(game.homeTeam || ""),
        predictedWinner: String(game.predictedWinner || ""),
        actualWinner: String(game.actualWinner || ""),
        winnerHit: game.predictionHit === true,
        awayWinProbability: toSafeNumber(game.awayWinProbability),
        homeWinProbability: toSafeNumber(game.homeWinProbability),
        predictedAwayScore: predictedAway,
        predictedHomeScore: predictedHome,
        actualAwayScore: actualAway,
        actualHomeScore: actualHome,
        actualTotal,
        predictedTotal: Number.isFinite(predictedAway) && Number.isFinite(predictedHome) ? predictedAway + predictedHome : null,
        predictedScoreMae: scoreMae(predictedAway, predictedHome, actualAway, actualHome),
        expectedAwayRuns: expectedAway,
        expectedHomeRuns: expectedHome,
        saberExpectedMae: scoreMae(expectedAway, expectedHome, actualAway, actualHome),
        markovAwayRuns: markovAway,
        markovHomeRuns: markovHome,
        markovMae: scoreMae(markovAway, markovHome, actualAway, actualHome),
        monteCarloAwayRuns: monteAway,
        monteCarloHomeRuns: monteHome,
        monteCarloMae: scoreMae(monteAway, monteHome, actualAway, actualHome),
        saberApplied: modelFeatures.saberApplied === true,
        totalBand: getTotalBand(actualTotal),
        edgeBand: getEdgeBand(probGap),
        over85Prob,
        over85Hit: actualTotal >= 9,
      };

      rows.push(row);
    }
  }

  rows.sort((a, b) => `${a.gameDate} ${a.gameTime}`.localeCompare(`${b.gameDate} ${b.gameTime}`));

  const summary = {
    range: { from, to },
    games: rows.length,
    overall: {
      winnerAccuracy: mean(rows.map((row) => (row.winnerHit ? 1 : 0))),
      predictedScoreMae: mean(rows.map((row) => row.predictedScoreMae)),
      saberExpectedMae: mean(rows.map((row) => row.saberExpectedMae)),
      markovMae: mean(rows.map((row) => row.markovMae)),
      monteCarloMae: mean(rows.map((row) => row.monteCarloMae)),
      saberAppliedRate: mean(rows.map((row) => (row.saberApplied ? 1 : 0))),
    },
    byTotalBand: buildGroupSummary(rows, "totalBand"),
    byEdgeBand: buildGroupSummary(rows, "edgeBand"),
  };

  const headers = [
    "gameDate",
    "gameTime",
    "awayTeam",
    "homeTeam",
    "predictedWinner",
    "actualWinner",
    "winnerHit",
    "awayWinProbability",
    "homeWinProbability",
    "predictedAwayScore",
    "predictedHomeScore",
    "actualAwayScore",
    "actualHomeScore",
    "actualTotal",
    "predictedTotal",
    "predictedScoreMae",
    "expectedAwayRuns",
    "expectedHomeRuns",
    "saberExpectedMae",
    "markovAwayRuns",
    "markovHomeRuns",
    "markovMae",
    "monteCarloAwayRuns",
    "monteCarloHomeRuns",
    "monteCarloMae",
    "saberApplied",
    "totalBand",
    "edgeBand",
    "over85Prob",
    "over85Hit",
  ];

  const csv = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n") + "\n";

  await fs.mkdir(outDir, { recursive: true });
  const csvPath = path.join(outDir, `${outPrefix}.csv`);
  const jsonPath = path.join(outDir, `${outPrefix}.summary.json`);
  await fs.writeFile(csvPath, csv, "utf8");
  await fs.writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    csvPath,
    summaryPath: jsonPath,
    games: rows.length,
    overall: summary.overall,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
