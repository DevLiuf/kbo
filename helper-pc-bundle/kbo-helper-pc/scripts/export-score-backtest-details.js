const path = require("path");
const { parseArgs } = require("./ml-utils");
const { loadBacktestRows } = require("../lib/backtest");
const { atomicWrite, writeJson } = require("../lib/artifacts");
const { rejectObsoleteOptions } = require("./score-training-utils");
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
function csvEscape(value) {
  const text = String(value ?? "");
  return /[,\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function summarize(rows) {
  const decisive = rows.filter((row) => !row.isDraw);
  return { games: rows.length, decisiveGames: decisive.length, drawGames: rows.length - decisive.length,
    winnerAccuracy: mean(decisive.map((row) => Number(row.predictionHit))),
    expectedRunMae: mean(rows.map((row) => row.expectedRunMae)), predictedScoreMae: mean(rows.map((row) => row.predictedScoreMae)),
    logLoss: mean(decisive.map((row) => row.logLoss)), brier: mean(decisive.map((row) => row.brier)) };
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  rejectObsoleteOptions(args);
  const { rows: games, source } = await loadBacktestRows(args);
  const rows = games.map((game) => {
    const label = Number(game.actualHomeScore > game.actualAwayScore);
    const p = Math.max(1e-9, Math.min(1 - 1e-9, game.homeWinProbability));
    return { ...game,
      expectedRunMae: (Math.abs(game.expectedAwayRuns - game.actualAwayScore) + Math.abs(game.expectedHomeRuns - game.actualHomeScore)) / 2,
      predictedScoreMae: (Math.abs(game.predictedAwayScore - game.actualAwayScore) + Math.abs(game.predictedHomeScore - game.actualHomeScore)) / 2,
      logLoss: game.isDraw ? null : -(label * Math.log(p) + (1 - label) * Math.log(1 - p)),
      brier: game.isDraw ? null : (p - label) ** 2 };
  });
  const summary = { source, probabilitySemantics: "Win probabilities conditional on decisive nine-inning scores; tieAfterNineProbability is not final-game draw probability.", overall: summarize(rows) };
  const headers = ["gameDate", "gameTime", "gameKey", "awayTeam", "homeTeam", "predictedWinner", "actualWinner", "predictionHit", "isDraw",
    "awayWinProbability", "homeWinProbability", "tieAfterNineProbability", "expectedAwayRuns", "expectedHomeRuns", "predictedAwayScore", "predictedHomeScore",
    "actualAwayScore", "actualHomeScore", "expectedRunMae", "predictedScoreMae", "logLoss", "brier", "modelVersion"];
  const directory = args.outDir || path.join(process.cwd(), "data", "backtests");
  const prefix = args.outPrefix || `score_backtest_${args.from}_${args.to}`;
  const csvPath = path.join(directory, `${prefix}.csv`);
  const summaryPath = path.join(directory, `${prefix}.summary.json`);
  await atomicWrite(csvPath, [headers.join(","), ...rows.map((row) => headers.map((name) => csvEscape(row[name])).join(","))].join("\n") + "\n");
  await writeJson(summaryPath, summary);
  console.log(JSON.stringify({ csvPath, summaryPath, ...summary }));
  if (!rows.length) process.exitCode = 1;
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { summarize, main };
