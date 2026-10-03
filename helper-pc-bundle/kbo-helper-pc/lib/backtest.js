const path = require("path");
const { isPregameSnapshot } = require("./prediction-contract");
const { MODEL_TYPE } = require("./score-model");
const { assertDateRange, readNdjson } = require("./artifacts");

function isReadyPrediction(row) {
  return isPregameSnapshot(row) && row.status === "ready" && row.modelType === MODEL_TYPE
    && [row.expectedAwayRuns, row.expectedHomeRuns].every((value) => Number.isFinite(value) && value > 0 && value <= 50)
    && [row.predictedAwayScore, row.predictedHomeScore].every((value) => Number.isInteger(value) && value >= 0)
    && [row.awayWinProbability, row.homeWinProbability, row.tieAfterNineProbability].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    && Math.abs(row.awayWinProbability + row.homeWinProbability - 1) < 1e-9;
}

function finiteNumber(value) {
  if (value === null || value === undefined || typeof value === "boolean" || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function gameKey(row) {
  const id = row.gameKey || row.gameId;
  return id ? `${String(row.league || "kbo").toLowerCase()}:${id}` : null;
}

function joinArchivedPredictions(snapshots, results, { from, to } = {}) {
  const latest = new Map();
  for (const snapshot of snapshots) {
    if (!isReadyPrediction(snapshot) || (from && snapshot.gameDate < from) || (to && snapshot.gameDate > to)) continue;
    const key = gameKey(snapshot);
    if (!key) continue;
    const previous = latest.get(key);
    if (!previous || Date.parse(snapshot.asOfTimestamp) > Date.parse(previous.asOfTimestamp)) latest.set(key, snapshot);
  }
  const completed = new Map();
  for (const result of results) {
    const key = gameKey(result);
    const away = finiteNumber(result.awayScore);
    const home = finiteNumber(result.homeScore);
    if (!key || result.completed !== true || !Number.isInteger(away) || !Number.isInteger(home) || away < 0 || home < 0) continue;
    completed.set(key, { ...result, awayScore: away, homeScore: home });
  }
  const rows = [];
  for (const [key, prediction] of latest) {
    const result = completed.get(key);
    if (!result || (result.gameDate && result.gameDate !== prediction.gameDate)) continue;
    const isDraw = result.awayScore === result.homeScore;
    const actualWinner = isDraw ? null : result.homeScore > result.awayScore ? prediction.homeTeam : prediction.awayTeam;
    if (!isDraw && (!actualWinner || ![prediction.homeTeam, prediction.awayTeam].includes(prediction.predictedWinner))) continue;
    rows.push({ ...prediction, actualAwayScore: result.awayScore, actualHomeScore: result.homeScore,
      actualWinner, isDraw, predictionHit: isDraw ? null : prediction.predictedWinner === actualWinner });
  }
  return rows.sort((a, b) => `${a.gameDate} ${a.gameTime || ""}`.localeCompare(`${b.gameDate} ${b.gameTime || ""}`));
}

async function readArchive(filePath) {
  return readNdjson(filePath);
}

async function loadBacktestRows(args) {
  if (Object.hasOwn(args, "baseUrl")) throw new Error("--baseUrl is no longer supported: use --snapshots and --results for immutable local archives (no historical recomputation).");
  const from = String(args.from || "");
  const to = String(args.to || "");
  if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to) || from > to) throw new Error("Use --from=YYYYMMDD --to=YYYYMMDD [--snapshots=path.ndjson --results=path.ndjson]");
  assertDateRange(from, to);
  const snapshots = String(args.snapshots || path.join(process.cwd(), "data", "prediction_snapshots.ndjson"));
  const results = String(args.results || path.join(process.cwd(), "data", "game_results.kbo.ndjson"));
  const [predictionRows, resultRows] = await Promise.all([readArchive(snapshots), readArchive(results)]);
  return { rows: joinArchivedPredictions(predictionRows, resultRows, { from, to }), source: { snapshots, results, from, to } };
}


module.exports = { finiteNumber, joinArchivedPredictions, loadBacktestRows };
