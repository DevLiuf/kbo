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

function mean(values) {
  const valid = values.filter(Number.isFinite);
  if (valid.length === 0) {
    return null;
  }
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function getTagOddsMap({ recommendOdds, cautionOdds, avoidOdds }) {
  return {
    추천: recommendOdds,
    주의: cautionOdds,
    회피: avoidOdds,
  };
}

function getTagStakeMap({ recommendStake, cautionStake, avoidStake }) {
  return {
    추천: recommendStake,
    주의: cautionStake,
    회피: avoidStake,
  };
}

function calcBetOutcome({ stakeUnits, odds, winnerHit }) {
  if (!Number.isFinite(stakeUnits) || stakeUnits <= 0) {
    return {
      placed: false,
      payoutUnits: 0,
      profitUnits: 0,
    };
  }

  const safeOdds = Number.isFinite(odds) && odds > 1 ? odds : 1.9;
  if (winnerHit) {
    const payoutUnits = stakeUnits * safeOdds;
    return {
      placed: true,
      payoutUnits,
      profitUnits: payoutUnits - stakeUnits,
    };
  }

  return {
    placed: true,
    payoutUnits: 0,
    profitUnits: -stakeUnits,
  };
}

function summarizeProfitRows(rows) {
  const betRows = rows.filter((row) => row.betPlaced);
  const totalStakeUnits = betRows.reduce((sum, row) => sum + row.stakeUnits, 0);
  const totalPayoutUnits = betRows.reduce((sum, row) => sum + row.payoutUnits, 0);
  const totalProfitUnits = betRows.reduce((sum, row) => sum + row.profitUnits, 0);
  const wins = betRows.filter((row) => row.winnerHit).length;
  const losses = betRows.length - wins;

  return {
    games: rows.length,
    bets: betRows.length,
    wins,
    losses,
    hitRate: betRows.length > 0 ? round(wins / betRows.length) : null,
    totalStakeUnits: round(totalStakeUnits),
    totalPayoutUnits: round(totalPayoutUnits),
    totalProfitUnits: round(totalProfitUnits),
    roi: totalStakeUnits > 0 ? round(totalProfitUnits / totalStakeUnits) : null,
    avgStakePerBet: betRows.length > 0 ? round(totalStakeUnits / betRows.length) : null,
    avgWinProbGap: round(mean(rows.map((row) => row.winProbGap))),
    avgExpectedTotalRuns: round(mean(rows.map((row) => row.expectedTotalRuns))),
  };
}

function buildByTagSummary(rows) {
  const groups = new Map();

  for (const row of rows) {
    const key = String(row.bettingTag || "unknown");
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(row);
  }

  const output = {};
  for (const [tag, grouped] of groups.entries()) {
    output[tag] = summarizeProfitRows(grouped);
  }
  return output;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const from = String(args.from || "").trim();
  const to = String(args.to || "").trim();
  const baseUrl = String(args.baseUrl || "http://localhost:3000").replace(/\/$/, "");
  const outDir = String(args.outDir || path.join(process.cwd(), "data", "backtests"));
  const outPrefix = String(args.outPrefix || `betting_tag_profit_${from}_${to}`);

  const recommendOdds = Number(args.recommendOdds || 1.9);
  const cautionOdds = Number(args.cautionOdds || 1.9);
  const avoidOdds = Number(args.avoidOdds || 1.9);
  const recommendStake = Number(args.recommendStake || 1);
  const cautionStake = Number(args.cautionStake || 0.5);
  const avoidStake = Number(args.avoidStake || 0);

  if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) {
    throw new Error("Usage: node scripts/export-betting-tag-profitability.js --from=YYYYMMDD --to=YYYYMMDD [--baseUrl=http://localhost:3000]");
  }

  const oddsByTag = getTagOddsMap({ recommendOdds, cautionOdds, avoidOdds });
  const stakeByTag = getTagStakeMap({ recommendStake, cautionStake, avoidStake });

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
      const bettingTag = String(game.bettingTag || "주의");
      const stakeUnits = Number.isFinite(stakeByTag[bettingTag]) ? stakeByTag[bettingTag] : cautionStake;
      const odds = Number.isFinite(oddsByTag[bettingTag]) ? oddsByTag[bettingTag] : cautionOdds;
      const winnerHit = game.predictionHit === true;
      const outcome = calcBetOutcome({
        stakeUnits,
        odds,
        winnerHit,
      });

      rows.push({
        gameDate: String(game.gameDate || date),
        gameTime: String(game.gameTime || ""),
        awayTeam: String(game.awayTeam || ""),
        homeTeam: String(game.homeTeam || ""),
        bettingTag,
        bettingReason: String(game.bettingReason || ""),
        predictedWinner: String(game.predictedWinner || ""),
        actualWinner: String(game.actualWinner || ""),
        winnerHit,
        homeWinProbability: toSafeNumber(game.homeWinProbability),
        awayWinProbability: toSafeNumber(game.awayWinProbability),
        winProbGap: toSafeNumber(modelFeatures.winProbGap),
        edgeBand: String(modelFeatures.edgeBand || "unknown"),
        totalBand: String(modelFeatures.totalBand || "unknown"),
        expectedTotalRuns: toSafeNumber(modelFeatures.expectedTotalRuns),
        saberApplied: modelFeatures.saberApplied === true,
        stakeUnits,
        odds,
        betPlaced: outcome.placed,
        payoutUnits: round(outcome.payoutUnits),
        profitUnits: round(outcome.profitUnits),
      });
    }
  }

  rows.sort((a, b) => `${a.gameDate} ${a.gameTime}`.localeCompare(`${b.gameDate} ${b.gameTime}`));

  const recommendedOnlyRows = rows.map((row) => {
    if (row.bettingTag !== "추천") {
      return { ...row, betPlaced: false, payoutUnits: 0, profitUnits: 0, stakeUnits: 0 };
    }
    return row;
  });

  const summary = {
    range: { from, to },
    assumptions: {
      oddsByTag,
      stakeByTag,
      note: "Decimal odds model. profit = payout - stake, ROI = totalProfit / totalStake",
    },
    games: rows.length,
    overall: summarizeProfitRows(rows),
    byTag: buildByTagSummary(rows),
    strategies: {
      recommendAndCaution: summarizeProfitRows(rows.filter((row) => row.bettingTag === "추천" || row.bettingTag === "주의")),
      recommendOnly: summarizeProfitRows(recommendedOnlyRows),
    },
  };

  const headers = [
    "gameDate",
    "gameTime",
    "awayTeam",
    "homeTeam",
    "bettingTag",
    "bettingReason",
    "predictedWinner",
    "actualWinner",
    "winnerHit",
    "homeWinProbability",
    "awayWinProbability",
    "winProbGap",
    "edgeBand",
    "totalBand",
    "expectedTotalRuns",
    "saberApplied",
    "stakeUnits",
    "odds",
    "betPlaced",
    "payoutUnits",
    "profitUnits",
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
    byTag: summary.byTag,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
