const fs = require("fs/promises");
const path = require("path");
const { parseArgs } = require("./ml-utils");
const { finiteNumber: toSafeNumber, loadBacktestRows, calcBetOutcome } = require("../lib/backtest");


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


function summarizeProfitRows(rows) {
  const betRows = rows.filter((row) => row.betPlaced);
  const totalStakeUnits = betRows.reduce((sum, row) => sum + row.stakeUnits, 0);
  const totalPayoutUnits = betRows.reduce((sum, row) => sum + row.payoutUnits, 0);
  const totalProfitUnits = betRows.reduce((sum, row) => sum + row.profitUnits, 0);
  const wins = betRows.filter((row) => row.winnerHit === true && !row.isDraw).length;
  const losses = betRows.filter((row) => row.winnerHit === false && !row.isDraw).length;
  const voidCount = betRows.filter((row) => row.isDraw).length;

  return {
    games: rows.length,
    bets: betRows.length,
    wins,
    losses,
    voidCount,
    hitRate: wins + losses > 0 ? round(wins / (wins + losses)) : null,
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
  const outDir = String(args.outDir || path.join(process.cwd(), "data", "backtests"));
  const outPrefix = String(args.outPrefix || `betting_tag_profit_${from}_${to}`);

  const recommendOdds = Number(args.recommendOdds || 1.9);
  const cautionOdds = Number(args.cautionOdds || 1.9);
  const avoidOdds = Number(args.avoidOdds || 1.9);
  const recommendStake = Number(args.recommendStake || 1);
  const cautionStake = Number(args.cautionStake || 0.5);
  const avoidStake = Number(args.avoidStake || 0);


  const oddsByTag = getTagOddsMap({ recommendOdds, cautionOdds, avoidOdds });
  const stakeByTag = getTagStakeMap({ recommendStake, cautionStake, avoidStake });

  const { rows: games, source } = await loadBacktestRows(args);
  const rows = [];
  for (const game of games) {

      const modelFeatures = game.modelFeatures || {};
      const bettingTag = String(game.bettingTag || "주의");
      const stakeUnits = Number.isFinite(stakeByTag[bettingTag]) ? stakeByTag[bettingTag] : cautionStake;
      const odds = Number.isFinite(oddsByTag[bettingTag]) ? oddsByTag[bettingTag] : cautionOdds;
      const winnerHit = game.predictionHit;
      const outcome = calcBetOutcome({
        stakeUnits,
        odds,
        winnerHit,
        isDraw: game.isDraw,
      });

      rows.push({
        gameDate: String(game.gameDate),
        gameTime: String(game.gameTime || ""),
        awayTeam: String(game.awayTeam || ""),
        homeTeam: String(game.homeTeam || ""),
        bettingTag,
        bettingReason: String(game.bettingReason || ""),
        predictedWinner: String(game.predictedWinner || ""),
        actualWinner: String(game.actualWinner || ""),
        winnerHit,
        isDraw: game.isDraw,
        decisionBasis: game.decisionBasis,
        predictedRunDiff: toSafeNumber(game.predictedRunDiff),
        edgeTier: String(modelFeatures.edgeTier || ""),
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

  rows.sort((a, b) => `${a.gameDate} ${a.gameTime}`.localeCompare(`${b.gameDate} ${b.gameTime}`));

  const recommendedOnlyRows = rows.map((row) => {
    if (row.bettingTag !== "추천") {
      return { ...row, betPlaced: false, payoutUnits: 0, profitUnits: 0, stakeUnits: 0 };
    }
    return row;
  });

  const summary = {
    range: { from, to },
    source,
    assumptions: {
      oddsByTag,
      stakeByTag,
      note: "SIMULATION ONLY: assumed decimal odds, not historical market odds or market expected value (EV). Draws refund stake (profit 0). profit = payout - stake; ROI includes refunded stakes; hit rate excludes draws.",
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
    "isDraw",
    "decisionBasis",
    "predictedRunDiff",
    "edgeTier",
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
