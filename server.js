require("./lib/runtime").assertSupportedRuntime();
const path = require("path");
const fs = require("fs/promises");
const express = require("express");
const cheerio = require("cheerio");
const { createHash } = require("crypto");
const { version: APP_VERSION } = require("./package.json");
const { DEFAULT_EXPONENT, calculatePythagoreanWinPct } = require("./lib/pythagorean");
const { FEATURE_SCHEMA_VERSION, MODEL_TYPE, isPregameSnapshot } = require("./lib/prediction-contract");
const { validateModel, validateInputs, predictGame } = require("./lib/score-model");
const { collectConfirmedInputs } = require("./lib/kbo-confirmed-data");
const { assertDateRange, readNdjson, seoulToday } = require("./lib/artifacts");
const { isPublishablePrediction } = require("./lib/published-predictions");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.KBO_DATA_DIR || path.join(__dirname, "data"));
const MODEL_FILE = path.join(DATA_DIR, "run_model.kbo.json");
const SNAPSHOT_FILE = path.join(DATA_DIR, "published_predictions.kbo.ndjson");
const KBO_HITTER_URL = "https://www.koreabaseball.com/Record/Team/Hitter/Basic1.aspx";
const KBO_PITCHER_URL = "https://www.koreabaseball.com/Record/Team/Pitcher/Basic1.aspx";
const KBO_GAME_LIST_URL = "https://www.koreabaseball.com/ws/Main.asmx/GetKboGameList";
const teamCache = new Map();

function number(value) {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchHtml(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`KBO records HTTP ${response.status}`);
  return response.text();
}

// Retain the existing team statistics surface; it is not a prediction fallback.
function parseTeamTable(html, fields) {
  const $ = cheerio.load(html);
  const map = new Map();
  $("table.tData.tt tbody tr").each((_, row) => {
    const node = $(row);
    const team = node.find("td").eq(1).text().trim();
    const values = Object.fromEntries(Object.entries(fields).map(([key, id]) => [key, number(node.find(`td[data-id='${id}']`).text().trim())]));
    if (team && Object.values(values).every((value) => value !== null && value >= 0)) map.set(team, values);
  });
  return map;
}

async function loadTeamRows(exponent) {
  const key = `${new Date().getFullYear()}:${exponent}`;
  const cached = teamCache.get(key);
  if (cached && Date.now() - cached.cachedAt < 60000) return cached.rows;
  const [hitterHtml, pitcherHtml] = await Promise.all([fetchHtml(KBO_HITTER_URL), fetchHtml(KBO_PITCHER_URL)]);
  const hitter = parseTeamTable(hitterHtml, { runsScored: "RUN_CN", games: "GAME_CN", battingAvg: "HRA_RT", homeRuns: "HR_CN" });
  const pitcher = parseTeamTable(pitcherHtml, { runsAllowed: "R_CN", teamEra: "ERA_RT", teamWhip: "WHIP_RT",
    saves: "SV_CN", holds: "HOLD_CN", games: "GAME_CN", strikeouts: "KK_CN", walks: "BB_CN" });
  const rows = [];
  for (const [team, batting] of hitter) {
    const pitching = pitcher.get(team);
    if (!pitching) continue;
    rows.push({ team, ...batting, runsAllowed: pitching.runsAllowed, teamEra: pitching.teamEra,
      teamWhip: pitching.teamWhip, hrPerGame: batting.games ? batting.homeRuns / batting.games : 0,
      bullpenUsagePerGame: pitching.games ? (pitching.saves + pitching.holds) / pitching.games : 0,
      kbbRatio: (pitching.strikeouts + 1) / (pitching.walks + 1),
      pythagoreanWinPct: calculatePythagoreanWinPct(batting.runsScored, pitching.runsAllowed, exponent) });
  }
  if (hitter.size !== 10 || pitcher.size !== 10 || rows.length !== 10) throw new Error("Upstream KBO format changed");
  rows.sort((a, b) => b.pythagoreanWinPct - a.pythagoreanWinPct);
  teamCache.set(key, { cachedAt: Date.now(), rows });
  return rows;
}

function dateRangeValid(range) {
  try { assertDateRange(range.from, range.to); return true; } catch { return false; }
}

async function loadRunModel() {
  let bytes;
  try { bytes = await fs.readFile(MODEL_FILE); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { model: null, reason: "새 득점 모델의 학습·독립 검증 자료가 없습니다.", code: "MODEL_NOT_TRAINED" };
  }
  let model;
  try { model = JSON.parse(bytes); } catch {
    return { model: null, reason: "새 득점 모델 파일을 읽을 수 없습니다.", code: "MODEL_INVALID" };
  }
  const metrics = model?.metrics?.validation;
  if (!validateModel(model) || model.validationIndependent !== true
      || !dateRangeValid(model.trainingRange) || !dateRangeValid(model.validationRange)
      || model.trainingRange.to >= model.validationRange.from || !(metrics?.samples > 0)
      || !(metrics?.decisiveGames > 0)
      || !["poissonNll", "mae", "logLoss", "brier"].every((key) => Number.isFinite(metrics[key]) && metrics[key] >= 0)) {
    return { model: null, reason: "새 득점 모델의 형식 또는 독립 검증 조건이 유효하지 않습니다.", code: "MODEL_UNVALIDATED" };
  }
  return { model: { ...model, modelHash: createHash("sha256").update(bytes).digest("hex") }, reason: null, code: null };
}

function modelStatus(loaded) {
  const model = loaded.model;
  return {
    appVersion: APP_VERSION, featureSchemaVersion: FEATURE_SCHEMA_VERSION, modelType: MODEL_TYPE,
    modelVersion: model?.version || null, modelHash: model?.modelHash || null,
    status: model ? "ready" : "unavailable", unavailableReason: loaded.reason, unavailableCode: loaded.code,
    modelValidationIndependent: Boolean(model), modelTrainedAt: model?.trainedAt || null,
    modelTrainingRange: model?.trainingRange || null, modelValidationRange: model?.validationRange || null,
  };
}

async function gameList(date) {
  const response = await fetch(KBO_GAME_LIST_URL, {
    method: "POST", signal: AbortSignal.timeout(8000),
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "User-Agent": "Mozilla/5.0",
      "X-Requested-With": "XMLHttpRequest", Referer: "https://www.koreabaseball.com/Schedule/GameCenter/Main.aspx" },
    body: new URLSearchParams({ leId: "1", srId: "0,1,3,4,5,6,7,8,9", date }).toString(),
  });
  if (!response.ok) throw new Error(`KBO schedule HTTP ${response.status}`);
  const payload = await response.json();
  if (String(payload?.code) !== "100" || !Array.isArray(payload.game)) throw new Error("Invalid KBO schedule response");
  if (payload.game.some((game) => game.G_DT !== date || !game.G_ID)) throw new Error("KBO schedule date/identity mismatch");
  return payload.game;
}

function gameMetadata(game) {
  const start = /^\d{8}$/.test(game.G_DT) && /^\d{2}:\d{2}$/.test(game.G_TM)
    ? new Date(`${game.G_DT.slice(0, 4)}-${game.G_DT.slice(4, 6)}-${game.G_DT.slice(6, 8)}T${game.G_TM}:00+09:00`) : null;
  const final = String(game.GAME_STATE_SC) === "3";
  const awayScore = final ? number(game.T_SCORE_CN) : null;
  const homeScore = final ? number(game.B_SCORE_CN) : null;
  return { league: "kbo", gameId: game.G_ID, gameKey: game.G_ID, gameDate: game.G_DT, gameTime: game.G_TM,
    gameStartsAt: start && Number.isFinite(start.getTime()) ? start.toISOString() : null,
    gameState: String(game.GAME_STATE_SC), stadium: game.S_NM,
    awayTeam: game.AWAY_NM, homeTeam: game.HOME_NM, awayTeamId: game.AWAY_ID, homeTeamId: game.HOME_ID,
    awayStarter: String(game.T_PIT_P_NM || "").trim(), homeStarter: String(game.B_PIT_P_NM || "").trim(),
    actualAwayScore: awayScore, actualHomeScore: homeScore,
    actualWinner: awayScore !== null && homeScore !== null && awayScore !== homeScore
      ? (homeScore > awayScore ? game.HOME_NM : game.AWAY_NM) : null };
}

function unavailable(metadata, code, reason, details = {}) {
  return { ...metadata, ...details, status: "unavailable", unavailableCode: code, unavailableReason: reason,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION, modelType: MODEL_TYPE, mode: "post_lineup",
    lineupConfirmed: details.lineupConfirmed === true, trainingEligible: false,
    modelInputs: details.modelInputs || null, awayWinProbability: null, homeWinProbability: null,
    expectedAwayRuns: null, expectedHomeRuns: null, predictedAwayScore: null, predictedHomeScore: null,
    predictedWinner: null, predictedRunDiff: null, tieAfterNineProbability: null, predictionHit: null };
}

async function archivedPredictions() {
  const rows = await readNdjson(SNAPSHOT_FILE, { allowMissing: true });
  const latest = new Map();
  for (const row of rows) {
    if (!isPublishablePrediction(row)) continue;
    const prior = latest.get(row.gameKey);
    if (!prior || Date.parse(row.asOfTimestamp) > Date.parse(prior.asOfTimestamp)) latest.set(row.gameKey, row);
  }
  return latest;
}

async function forecast(game, loaded, archives, requestedDate) {
  const metadata = gameMetadata(game);
  const starts = Date.parse(metadata.gameStartsAt);
  const notPregame = metadata.gameState !== "1" || !Number.isFinite(starts) || Date.now() >= starts || requestedDate !== seoulToday();
  if (notPregame) {
    const archived = archives.get(metadata.gameKey);
    if (archived && archived.gameDate === metadata.gameDate && archived.awayTeam === metadata.awayTeam && archived.homeTeam === metadata.homeTeam) {
      const winner = archived.homeWinProbability >= archived.awayWinProbability ? metadata.homeTeam : metadata.awayTeam;
      return { ...archived, ...metadata, status: "ready", predictionSource: "archived_pregame",
        archivedPredictionAsOf: archived.asOfTimestamp, predictedWinner: winner, trainingEligible: false,
        predictionHit: metadata.actualWinner ? metadata.actualWinner === winner : null };
    }
    return unavailable(metadata, "NO_PREGAME_ARCHIVE", "경기 전 확정 라인업 예측 기록이 없어 예측을 제공하지 않습니다.");
  }
  let observed;
  try { observed = await collectConfirmedInputs(game); }
  catch (error) {
    return unavailable(metadata, error.code || "DATA_UNAVAILABLE", error.message);
  }
  const details = { awayLineup: observed.awayLineup, homeLineup: observed.homeLineup,
    lineupConfirmed: observed.lineupConfirmed === true, modelInputs: observed.modelInputs,
    diagnostics: observed.diagnostics, asOfTimestamp: new Date().toISOString() };
  const candidate = { ...metadata, ...details, featureSchemaVersion: FEATURE_SCHEMA_VERSION, mode: "post_lineup" };
  if (!isPregameSnapshot(candidate) || !validateInputs(observed.modelInputs)) {
    return unavailable(metadata, "PREGAME_DATA_INVALID", "수집 도중 경기가 시작했거나 필수 경기 전 데이터가 유효하지 않습니다.");
  }
  if (!loaded.model) {
    // Archive observed inputs for first-model training, never invent forecast numbers.
    return { ...unavailable(metadata, loaded.code, loaded.reason, details), trainingEligible: true };
  }
  try {
    const scored = predictGame(loaded.model, observed.modelInputs);
    return { ...candidate, ...scored, status: "ready", modelType: MODEL_TYPE, modelVersion: loaded.model.version,
      modelHash: loaded.model.modelHash, trainingEligible: true, predictionSource: "live_pregame",
      predictedWinner: scored.homeWinProbability >= scored.awayWinProbability ? metadata.homeTeam : metadata.awayTeam,
      confidenceLevel: "post_lineup", predictionNote: "확정 라인업·선발 FIP·실제 구원 등판 기록 기반 득점 모델. 승률은 9이닝 비동점 조건부입니다.",
      predictionHit: null };
  } catch (error) {
    return { ...unavailable(metadata, "MODEL_INFERENCE_INVALID", error.message, details), trainingEligible: true };
  }
}

app.use(express.static(path.join(__dirname, "public")));
app.get("/api/model/status", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try { res.json(modelStatus(await loadRunModel())); }
  catch (error) { console.error("Model status failed", error); res.status(503).json({ error: "Model status unavailable." }); }
});

app.get("/api/predictions/archive/status", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const bytes = await fs.readFile(SNAPSHOT_FILE);
    res.json({ featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      snapshotHash: createHash("sha256").update(bytes).digest("hex") });
  } catch (error) {
    if (error.code === "ENOENT") {
      return res.json({ featureSchemaVersion: FEATURE_SCHEMA_VERSION, snapshotHash: null });
    }
    console.error("Prediction archive status failed", error);
    res.status(503).json({ error: "Prediction archive status unavailable." });
  }
});

app.get("/api/teams/pythagorean", async (req, res) => {
  if (String(req.query.league || "kbo").toLowerCase() !== "kbo") return res.status(400).json({ error: "KBO-only service: league must be kbo." });

  const exponent = req.query.exponent === undefined ? DEFAULT_EXPONENT : number(req.query.exponent);
  if (exponent === null || exponent < 0.1 || exponent > 10) return res.status(400).json({ error: "exponent must be between 0.1 and 10." });
  try {
    const rows = await loadTeamRows(exponent);
    res.json({ league: "kbo", source: { hitter: KBO_HITTER_URL, pitcher: KBO_PITCHER_URL }, season: new Date().getFullYear(),
      exponent, teamCount: rows.length, updatedAt: new Date().toISOString(), rows });
  } catch (error) {
    console.error("Team records failed", error);
    res.status(error.message.includes("format changed") ? 502 : 503).json({ error: "Failed to load KBO records." });
  }
});

app.get("/api/predictions/gameday", async (req, res) => {
  if (String(req.query.league || "kbo").toLowerCase() !== "kbo") return res.status(400).json({ error: "KBO-only service: league must be kbo." });
  if (req.query.homeAdvantage !== undefined) return res.status(400).json({ error: "homeAdvantage was removed; home effect is learned by the count model." });
  const date = req.query.date === undefined ? seoulToday() : String(req.query.date);
  try { assertDateRange(date, date); } catch { return res.status(400).json({ error: "date must be a valid YYYYMMDD date." }); }
  const includeFinished = req.query.includeFinished === "true";
  res.set("Cache-Control", "no-store");
  try {
    const [games, loaded, archives] = await Promise.all([gameList(date), loadRunModel(), archivedPredictions()]);
    const visible = games.filter((game) => ["1", "2", ...(includeFinished ? ["3"] : [])].includes(String(game.GAME_STATE_SC))
      && ["", "정상경기"].includes(String(game.CANCEL_SC_NM || "").trim()));
    const predictions = await Promise.all(visible.map((game) => forecast(game, loaded, archives, date)));
    const status = modelStatus(loaded);
    res.json({ ...status, modelStatus: status.status, league: "kbo", date, requestedDate: date,
      dateText: `${date.slice(0, 4)}.${date.slice(4, 6)}.${date.slice(6, 8)}`, asOfTimestamp: new Date().toISOString(),
      probabilityBasis: "decisive_nine_innings", signalKind: "confirmed_lineup_run_model", includeFinished,
      gameCount: predictions.length, readyGameCount: predictions.filter((row) => row.status === "ready").length,
      predictions, source: { gameCenter: "https://www.koreabaseball.com/Schedule/GameCenter/Main.aspx", hitter: KBO_HITTER_URL, pitcher: KBO_PITCHER_URL } });
  } catch (error) {
    console.error("Gameday data failed", error);
    res.status(503).json({ error: "Failed to load KBO confirmed-lineup game data." });
  }
});

if (require.main === module) app.listen(PORT, () => console.log(`KBO pythagorean app is running at http://localhost:${PORT}`));
module.exports = app;
