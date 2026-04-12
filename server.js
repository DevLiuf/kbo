const path = require("path");
const fs = require("fs/promises");
const express = require("express");
const cheerio = require("cheerio");

const {
  DEFAULT_EXPONENT,
  calculatePythagoreanWinPct,
} = require("./lib/pythagorean");

const app = express();
const PORT = process.env.PORT || 3000;
const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 60 * 1000;
const EXPECTED_TEAMS = 10;
const DEFAULT_MODEL_VERSION = "baseline-logistic-shadow-v0.1.0";
const SNAPSHOT_DIR = path.join(__dirname, "data");
const SNAPSHOT_FILE = path.join(SNAPSHOT_DIR, "prediction_snapshots.ndjson");
const MODEL_COEFFICIENTS_FILE = path.join(SNAPSHOT_DIR, "model_coefficients.json");
const SABER_TUNING_STATUS_FILE = path.join(SNAPSHOT_DIR, "saber_tuning_status.kbo.json");

const DEFAULT_MODEL_COEFFICIENTS = {
  version: DEFAULT_MODEL_VERSION,
  intercept: -0.18,
  offenseDiff: 0.42,
  defenseDiff: 0.29,
  starterEraDiff: 0.11,
  runCreationResidualDiff: 0.28,
  powerContactMixDiff: 0.22,
  starterHitsPer9Diff: 0.08,
  starterHrPer9Diff: 0.12,
  starterFreePassPer9Diff: 0.1,
  starterSoPer9Diff: 0.06,
  starterRunsPer9Diff: 0.14,
  whipDiff: 0.24,
  bullpenDiff: 0.18,
  homeAdvantage: 1.4,
  lineupSignal: 0.12,
  preLineupShrink: 0.75,
  blendWeightPost: 0.65,
  blendWeightPre: 0.45,
  plattA: 1,
  plattB: 0,
};

const KBO_HITTER_URL = "https://www.koreabaseball.com/Record/Team/Hitter/Basic1.aspx";
const KBO_PITCHER_URL = "https://www.koreabaseball.com/Record/Team/Pitcher/Basic1.aspx";
const KBO_PLAYER_HITTER_ADVANCED_URL = "https://www.koreabaseball.com/Record/Player/HitterBasic/Basic2.aspx";
const KBO_PLAYER_PITCHER_BASIC_URL = "https://www.koreabaseball.com/Record/Player/PitcherBasic/Basic1.aspx";
const KBO_SEARCH_PLAYER_URL = "https://www.koreabaseball.com/ws/Controls.asmx/GetSearchPlayer";
const KBO_GAME_DATE_URL = "https://www.koreabaseball.com/ws/Main.asmx/GetKboGameDate";
const KBO_GAME_LIST_URL = "https://www.koreabaseball.com/ws/Main.asmx/GetKboGameList";
const KBO_PITCHER_RECORD_ANALYSIS_URL = "https://www.koreabaseball.com/ws/Schedule.asmx/GetPitcherRecordAnalysis";
const KBO_PITCHER_RECORD_ANALYSIS_POST_URL = "https://www.koreabaseball.com/ws/Schedule.asmx/GetPitcherRecordAnalysisPost";
const KBO_LINEUP_ANALYSIS_URL = "https://www.koreabaseball.com/ws/Schedule.asmx/GetLineUpAnalysis";
const KBO_SERIES_IDS = "0,1,3,4,5,6,7,8,9";
const KBO_LINEUP_CACHE = new Map();
const KBO_PLAYER_HITTER_ADVANCED_CACHE = new Map();
const KBO_PLAYER_PITCHER_BASIC_CACHE = new Map();
const KBO_PITCHER_DETAIL_CACHE = new Map();
const KBO_HITTER_DETAIL_CACHE = new Map();
const KBO_SEARCH_PLAYER_CACHE = new Map();

const KBO_TEAM_NAME_TO_ID = {
  KT: "KT",
  SSG: "SK",
  NC: "NC",
  삼성: "SS",
  한화: "HH",
  LG: "LG",
  키움: "WO",
  두산: "OB",
  롯데: "LT",
  KIA: "HT",
};

const STARTER_ERA_MIN = 2;
const STARTER_ERA_MAX = 7.5;
const STARTER_RELIABILITY_GAMES = 6;
const STARTER_RELIABILITY_MIN = 0.15;
const STARTER_RELIABILITY_MAX = 0.9;
const STARTER_RUN_IMPACT_COEFF = 0.38;
const LINEUP_WAR_OFFENSE_COEFF = 0.6;
const LINEUP_WAR_RUN_IMPACT_COEFF = 0.25;
const SABER_MARKOV_INNINGS = 9;
const SABER_MONTE_CARLO_INNINGS = 9;
const SABER_MONTE_CARLO_ITERATIONS = 900;
const SABER_BLEND_BASE_WEIGHT = 0.7;
const SABER_BLEND_MARKOV_WEIGHT = 0.25;
const SABER_BLEND_MONTE_WEIGHT = 0.05;
const SABER_CLAMP_THRESHOLD = 2.5;
const BETTING_RECOMMEND_EDGE_MIN = 0.24;
const BETTING_AVOID_EDGE_MAX = 0.08;
const BETTING_RECOMMEND_TOTAL_MIN = 7.2;
const BETTING_AVOID_TOTAL_MAX = 6.9;
const AWAY_WIN_DECISION_EDGE_MIN = 0.105;
const LINEUP_BLEND_WEIGHT_PRE = 0.15;
const LINEUP_BLEND_WEIGHT_POST = 0.4;
const CONTACT_TO_RPG_COEFF = 8;
const POWER_TO_RPG_COEFF = 0.9;
const POWER_CONTACT_MIX_COEFF = 1.6;
const CONTACT_PENALTY_MIX_COEFF = 10;

const cachedPayloadByKey = new Map();

function normalizeLeague(rawLeague) {
  const league = String(rawLeague || "kbo").trim().toLowerCase();
  return league === "kbo" ? "kbo" : null;
}

function getLeagueModelCoefficientsPath(league) {
  return path.join(SNAPSHOT_DIR, `model_coefficients.${league}.json`);
}

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function now() {
  return Date.now();
}

function formatDateYYYYMMDD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function formatDateYYYYMMDDInTimeZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    return formatDateYYYYMMDD(date);
  }

  return `${year}${month}${day}`;
}

function yyyymmddToIsoDate(dateText) {
  if (!/^\d{8}$/.test(String(dateText || ""))) {
    return null;
  }
  return `${dateText.slice(0, 4)}-${dateText.slice(4, 6)}-${dateText.slice(6, 8)}`;
}

function isoDateToYyyymmdd(dateText) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateText || ""))) {
    return null;
  }
  return dateText.replaceAll("-", "");
}

function getNextYyyymmdd(dateText) {
  const iso = yyyymmddToIsoDate(dateText);
  if (!iso) {
    return null;
  }

  const next = new Date(`${iso}T00:00:00`);
  next.setDate(next.getDate() + 1);
  return formatDateYYYYMMDD(next);
}

function isAfterGameDateEnd(dateText, nowDate = new Date()) {
  if (!/^\d{8}$/.test(String(dateText || ""))) {
    return false;
  }

  const seoulToday = formatDateYYYYMMDDInTimeZone(nowDate, "Asia/Seoul");
  return seoulToday > String(dateText);
}

function parseKboDateTime(dateText, timeText) {
  if (!/^\d{8}$/.test(dateText) || !/^\d{2}:\d{2}$/.test(timeText || "")) {
    return null;
  }

  const year = Number(dateText.slice(0, 4));
  const month = Number(dateText.slice(4, 6)) - 1;
  const day = Number(dateText.slice(6, 8));
  const [hour, minute] = timeText.split(":").map(Number);

  return new Date(year, month, day, hour, minute, 0, 0);
}

function isLineupConfirmedForGame(game, nowDate) {
  const state = String(game.GAME_STATE_SC || "");
  if (["2", "3"].includes(state)) {
    return true;
  }

  if (["4", "5"].includes(state)) {
    return false;
  }

  if (state !== "1") {
    return false;
  }

  const startDate = parseKboDateTime(game.G_DT, game.G_TM);
  if (!startDate) {
    return false;
  }

  const lineupReleaseTime = new Date(startDate.getTime() - 60 * 60 * 1000);
  return nowDate >= lineupReleaseTime;
}

function isUsableStarterName(name) {
  const text = String(name || "").trim();
  if (!text) {
    return false;
  }

  const normalized = text.toLowerCase();
  const blockedTokens = ["-", "미정", "예정", "tbd", "pending", "unknown", "없음", "na", "n/a"];
  return !blockedTokens.includes(normalized);
}

function calculateLog5WinProbability(homeWinPct, awayWinPct) {
  const numerator = homeWinPct * (1 - awayWinPct);
  const denominator = numerator + (1 - homeWinPct) * awayWinPct;

  if (denominator === 0) {
    return 0.5;
  }

  return numerator / denominator;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundToOne(value) {
  return Math.round(value * 10) / 10;
}

function roundToThree(value) {
  return Math.round(value * 1000) / 1000;
}

function buildReconstructedMlBattingFeatures({ offenseDiff, battingAvgDiff, hrPerGameDiff }) {
  const runCreationResidualDiff = offenseDiff - (
    (battingAvgDiff * CONTACT_TO_RPG_COEFF)
    + (hrPerGameDiff * POWER_TO_RPG_COEFF)
  );
  const powerContactMixDiff =
    (hrPerGameDiff * POWER_CONTACT_MIX_COEFF)
    - (battingAvgDiff * CONTACT_PENALTY_MIX_COEFF);

  return {
    runCreationResidualDiff,
    powerContactMixDiff,
  };
}

function parseInningsToOuts(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  const decimal = text.match(/^(\d+)(?:\.(\d))?$/);
  if (decimal) {
    const fullInnings = Number(decimal[1]);
    const partialOuts = decimal[2] ? Number(decimal[2]) : 0;
    if (Number.isFinite(fullInnings) && Number.isFinite(partialOuts) && partialOuts >= 0 && partialOuts <= 2) {
      return (fullInnings * 3) + partialOuts;
    }
  }

  const fraction = text.match(/^(\d+)\s+(\d)\/(\d)$/);
  if (fraction) {
    const fullInnings = Number(fraction[1]);
    const numerator = Number(fraction[2]);
    const denominator = Number(fraction[3]);
    if (Number.isFinite(fullInnings) && Number.isFinite(numerator) && denominator === 3) {
      return (fullInnings * 3) + numerator;
    }
  }

  return null;
}

function perNine(statValue, inningsOuts) {
  if (!Number.isFinite(statValue) || !Number.isFinite(inningsOuts) || inningsOuts <= 0) {
    return null;
  }
  return (statValue * 27) / inningsOuts;
}

function makeGameIdentityKey(parts) {
  const normalized = parts
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("-");
  return normalized || null;
}

function resolveGameKey(game) {
  const gameId = String(game.G_ID || "").trim();
  if (gameId) {
    return gameId;
  }

  return makeGameIdentityKey([
    game.G_DT,
    game.G_TM,
    game.AWAY_ID || game.AWAY_NM,
    game.HOME_ID || game.HOME_NM,
  ]);
}

function parseGameScore(value) {
  const parsed = toFiniteNumber(value);
  return parsed === null ? null : parsed;
}

function buildPoissonProbabilities(lambda, maxRuns) {
  const boundedLambda = clamp(lambda, 0.1, 15);
  const probs = new Array(maxRuns + 1).fill(0);
  probs[0] = Math.exp(-boundedLambda);
  for (let k = 1; k <= maxRuns; k += 1) {
    probs[k] = probs[k - 1] * (boundedLambda / k);
  }
  return probs;
}

function pickLikelyScoreByWinner({
  awayLambda,
  homeLambda,
  predictedWinner,
  homeTeam,
  awayTeam,
  targetRunDiff,
  lineupConfirmed,
}) {
  const maxRuns = lineupConfirmed ? 14 : 11;
  const awayProbs = buildPoissonProbabilities(awayLambda, maxRuns);
  const homeProbs = buildPoissonProbabilities(homeLambda, maxRuns);

  let best = null;
  const winnerIsHome = predictedWinner === homeTeam;
  const winnerIsAway = predictedWinner === awayTeam;
  const expectedTotalRuns = awayLambda + homeLambda;
  const diffPenaltyWeight = lineupConfirmed ? 0.45 : 0.2;
  const totalPenaltyWeight = lineupConfirmed ? 0.08 : 0.05;

  for (let awayScore = 0; awayScore <= maxRuns; awayScore += 1) {
    for (let homeScore = 0; homeScore <= maxRuns; homeScore += 1) {
      if (winnerIsHome && homeScore <= awayScore) {
        continue;
      }
      if (winnerIsAway && awayScore <= homeScore) {
        continue;
      }

      const jointProbability = awayProbs[awayScore] * homeProbs[homeScore];
      const runDiff = Math.abs(homeScore - awayScore);
      const diffDistance = Math.abs(runDiff - targetRunDiff);
      const totalDistance = Math.abs(awayScore + homeScore - expectedTotalRuns);
      const score = jointProbability / (
        1 + (diffDistance * diffPenaltyWeight) + (totalDistance * totalPenaltyWeight)
      );

      if (!best || score > best.score) {
        best = {
          awayScore,
          homeScore,
          score,
        };
      }
    }
  }

  if (!best) {
    if (winnerIsHome) {
      return { awayScore: 2, homeScore: 3 };
    }
    return { awayScore: 3, homeScore: 2 };
  }

  return {
    awayScore: best.awayScore,
    homeScore: best.homeScore,
  };
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function applyPlattCalibration(logitScore, model) {
  const a = Number.isFinite(model.plattA) ? model.plattA : 1;
  const b = Number.isFinite(model.plattB) ? model.plattB : 0;
  return sigmoid(a * logitScore + b);
}

function buildFeatureContributions(featureValues, model) {
  const entries = [
    ["offenseDiff", "팀 득점 (R/G)", featureValues.offenseDiff, model.offenseDiff],
    ["defenseDiff", "실점 억제 (낮을수록 좋음)", featureValues.defenseDiff, model.defenseDiff],
    ["starterEraDiff", "선발투수 ERA", featureValues.starterEraDiff, model.starterEraDiff],
    [
      "runCreationResidualDiff",
      "득점 잔차 (중복제어)",
      featureValues.runCreationResidualDiff,
      model.runCreationResidualDiff,
    ],
    [
      "powerContactMixDiff",
      "파워-컨택 밸런스",
      featureValues.powerContactMixDiff,
      model.powerContactMixDiff,
    ],
    [
      "starterHitsPer9Diff",
      "선발 피안타/9",
      featureValues.starterHitsPer9Diff,
      model.starterHitsPer9Diff,
    ],
    [
      "starterHrPer9Diff",
      "선발 피홈런/9",
      featureValues.starterHrPer9Diff,
      model.starterHrPer9Diff,
    ],
    [
      "starterFreePassPer9Diff",
      "선발 볼넷+사구/9",
      featureValues.starterFreePassPer9Diff,
      model.starterFreePassPer9Diff,
    ],
    [
      "starterSoPer9Diff",
      "선발 삼진/9",
      featureValues.starterSoPer9Diff,
      model.starterSoPer9Diff,
    ],
    [
      "starterRunsPer9Diff",
      "선발 실점/9",
      featureValues.starterRunsPer9Diff,
      model.starterRunsPer9Diff,
    ],
    ["whipDiff", "팀 WHIP", featureValues.whipDiff, model.whipDiff],
    ["bullpenDiff", "불펜 지표 (SV+HLD/KBB)", featureValues.bullpenDiff, model.bullpenDiff],
    ["homeAdvantage", "홈 어드밴티지", featureValues.homeAdvantage, model.homeAdvantage],
    ["lineupSignal", "라인업 확정", featureValues.lineupSignal, model.lineupSignal],
  ];

  if (Number.isFinite(model.battingAvgDiff)) {
    entries.push(["battingAvgDiff", "팀 타율 (AVG·legacy)", featureValues.battingAvgDiff, model.battingAvgDiff]);
  }
  if (Number.isFinite(model.hrPerGameDiff)) {
    entries.push(["hrPerGameDiff", "팀 홈런 (HR/G·legacy)", featureValues.hrPerGameDiff, model.hrPerGameDiff]);
  }

  if (Number.isFinite(featureValues.lineupWarDiff) && featureValues.lineupSignal === 1) {
    entries.push([
      "lineupWarDiff",
      "라인업 WAR 평균",
      featureValues.lineupWarDiff,
      LINEUP_WAR_OFFENSE_COEFF,
    ]);
  }

  const contributions = entries.map(([key, label, value, weight]) => {
    const numericWeight = Number.isFinite(Number(weight)) ? Number(weight) : 0;
    const numericValue = Number.isFinite(Number(value)) ? Number(value) : 0;
    const contribution = numericValue * numericWeight;
    return {
      key,
      label,
      value: roundToThree(numericValue),
      weight: roundToThree(numericWeight),
      contribution: roundToThree(contribution),
    };
  });

  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return contributions;
}

async function persistPredictionSnapshots({ asOfTimestamp, date, league, predictions }) {
  if (!Array.isArray(predictions) || predictions.length === 0) {
    return;
  }

  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });

  const rows = predictions.map((prediction) => JSON.stringify({
    asOfTimestamp,
    league,
    gameDate: date,
    gameId: prediction.gameId,
    gameKey: prediction.gameKey || prediction.gameId,
    modelVersion: prediction.modelVersion || DEFAULT_MODEL_VERSION,
    mode: prediction.mode,
    lineupConfirmed: prediction.lineupConfirmed,
    homeWinProbability: prediction.homeWinProbability,
    awayWinProbability: prediction.awayWinProbability,
    predictedHomeScore: prediction.predictedHomeScore,
    predictedAwayScore: prediction.predictedAwayScore,
    predictedWinner: prediction.predictedWinner,
    features: prediction.modelFeatures,
  })).join("\n") + "\n";

  await fs.appendFile(SNAPSHOT_FILE, rows, "utf8");
}

async function loadModelCoefficients(league = "kbo") {
  const normalizedLeague = normalizeLeague(league) || "kbo";
  const normalizeModel = (parsed) => {
    const requiredBase = [
      "intercept",
      "offenseDiff",
      "defenseDiff",
      "starterEraDiff",
      "whipDiff",
      "bullpenDiff",
      "homeAdvantage",
      "lineupSignal",
      "preLineupShrink",
      "blendWeightPost",
      "blendWeightPre",
      "plattA",
      "plattB",
    ];

    for (const key of requiredBase) {
      if (!Number.isFinite(parsed[key])) {
        return null;
      }
    }

    const hasReconstructed = Number.isFinite(parsed.runCreationResidualDiff)
      && Number.isFinite(parsed.powerContactMixDiff);
    const hasLegacy = Number.isFinite(parsed.battingAvgDiff)
      && Number.isFinite(parsed.hrPerGameDiff);

    if (!hasReconstructed && !hasLegacy) {
      return null;
    }

    const normalized = {
      ...parsed,
      defenseDiff: Math.abs(parsed.defenseDiff),
      runCreationResidualDiff: hasReconstructed ? parsed.runCreationResidualDiff : 0,
      powerContactMixDiff: hasReconstructed ? parsed.powerContactMixDiff : 0,
      starterHitsPer9Diff: Number.isFinite(parsed.starterHitsPer9Diff) ? parsed.starterHitsPer9Diff : 0,
      starterHrPer9Diff: Number.isFinite(parsed.starterHrPer9Diff) ? parsed.starterHrPer9Diff : 0,
      starterFreePassPer9Diff: Number.isFinite(parsed.starterFreePassPer9Diff) ? parsed.starterFreePassPer9Diff : 0,
      starterSoPer9Diff: Number.isFinite(parsed.starterSoPer9Diff) ? parsed.starterSoPer9Diff : 0,
      starterRunsPer9Diff: Number.isFinite(parsed.starterRunsPer9Diff) ? parsed.starterRunsPer9Diff : 0,
    };

    if (typeof normalized.version !== "string" || normalized.version.length === 0) {
      normalized.version = DEFAULT_MODEL_COEFFICIENTS.version;
    }

    return normalized;
  };

  const tryLoadModelFromPath = async (filePath) => {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      return normalizeModel(parsed);
    } catch {
      return null;
    }
  };

  try {
    const leagueModel = await tryLoadModelFromPath(getLeagueModelCoefficientsPath(normalizedLeague));
    if (leagueModel) {
      return leagueModel;
    }

    const legacyModel = await tryLoadModelFromPath(MODEL_COEFFICIENTS_FILE);
    if (legacyModel) {
      return legacyModel;
    }

    return DEFAULT_MODEL_COEFFICIENTS;
  } catch {
    return DEFAULT_MODEL_COEFFICIENTS;
  }
}

async function loadSaberTuningStatus() {
  try {
    const raw = await fs.readFile(SABER_TUNING_STATUS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      tunedAt: typeof parsed.tunedAt === "string" ? parsed.tunedAt : null,
      rangeFrom: typeof parsed.rangeFrom === "string" ? parsed.rangeFrom : null,
      rangeTo: typeof parsed.rangeTo === "string" ? parsed.rangeTo : null,
      sampleSize: Number.isFinite(parsed.sampleSize) ? parsed.sampleSize : null,
      best: parsed.best && typeof parsed.best === "object" ? parsed.best : null,
    };
  } catch {
    return {
      tunedAt: null,
      rangeFrom: null,
      rangeTo: null,
      sampleSize: null,
      best: null,
    };
  }
}

async function fetchHtml(url) {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const response = await fetch(url, {
    signal,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; kbo-pythagorean-demo/1.0)",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return response.text();
}

async function fetchKboJson(url, payload) {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "User-Agent": "Mozilla/5.0 (compatible; kbo-pythagorean-demo/1.0)",
    },
    body: new URLSearchParams(payload).toString(),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return response.json();
}

function parseHitterRuns(html) {
  const $ = cheerio.load(html);
  const runsByTeam = new Map();

  $("table.tData.tt tbody tr").each((_, row) => {
    const teamName = $(row).find("td").eq(1).text().trim();
    const runsScoredText = $(row).find("td[data-id='RUN_CN']").text().trim();
    const gamesText = $(row).find("td[data-id='GAME_CN']").text().trim();
    const battingAvgText = $(row).find("td[data-id='HRA_RT']").text().trim();
    const homeRunsText = $(row).find("td[data-id='HR_CN']").text().trim();
    const runsScored = toFiniteNumber(runsScoredText);
    const games = toFiniteNumber(gamesText);
    const battingAvg = toFiniteNumber(battingAvgText);
    const homeRuns = toFiniteNumber(homeRunsText);

    if (
      !teamName ||
      runsScored === null ||
      games === null ||
      battingAvg === null ||
      homeRuns === null
    ) {
      return;
    }

    runsByTeam.set(teamName, {
      team: teamName,
      runsScored,
      games,
      battingAvg,
      homeRuns,
    });
  });

  return runsByTeam;
}

function parsePitcherRunsAllowed(html) {
  const $ = cheerio.load(html);
  const runsAllowedByTeam = new Map();

  $("table.tData.tt tbody tr").each((_, row) => {
    const teamName = $(row).find("td").eq(1).text().trim();
    const runsAllowedText = $(row).find("td[data-id='R_CN']").text().trim();
    const eraText = $(row).find("td[data-id='ERA_RT']").text().trim();
    const whipText = $(row).find("td[data-id='WHIP_RT']").text().trim();
    const savesText = $(row).find("td[data-id='SV_CN']").text().trim();
    const holdsText = $(row).find("td[data-id='HOLD_CN']").text().trim();
    const gamesText = $(row).find("td[data-id='GAME_CN']").text().trim();
    const strikeoutsText = $(row).find("td[data-id='KK_CN']").text().trim();
    const walksText = $(row).find("td[data-id='BB_CN']").text().trim();
    const runsAllowed = toFiniteNumber(runsAllowedText);
    const teamEra = toFiniteNumber(eraText);
    const teamWhip = toFiniteNumber(whipText);
    const saves = toFiniteNumber(savesText);
    const holds = toFiniteNumber(holdsText);
    const games = toFiniteNumber(gamesText);
    const strikeouts = toFiniteNumber(strikeoutsText);
    const walks = toFiniteNumber(walksText);

    if (
      !teamName ||
      runsAllowed === null ||
      teamEra === null ||
      teamWhip === null ||
      saves === null ||
      holds === null ||
      games === null ||
      strikeouts === null ||
      walks === null
    ) {
      return;
    }

    runsAllowedByTeam.set(teamName, {
      runsAllowed,
      teamEra,
      teamWhip,
      saves,
      holds,
      games,
      strikeouts,
      walks,
    });
  });

  return runsAllowedByTeam;
}

function normalizePlayerNameKey(name) {
  return String(name || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[·ㆍ.·'`\-]/g, "")
    .replace(/[^0-9A-Za-z가-힣]/g, "")
    .trim();
}

function normalizeTeamNameKey(team) {
  return String(team || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .trim();
}

function resolveKboTeamId(teamName) {
  const normalized = normalizeTeamNameKey(teamName);
  if (!normalized) {
    return null;
  }
  return KBO_TEAM_NAME_TO_ID[normalized] || null;
}

function buildTeamPlayerKey(team, name) {
  const normalizedTeam = normalizeTeamNameKey(team);
  const normalizedName = normalizePlayerNameKey(name);
  if (!normalizedTeam || !normalizedName) {
    return "";
  }
  return `${normalizedTeam}:${normalizedName}`;
}

function normalizeLineupPositionGroup(position) {
  const raw = String(position || "").toUpperCase();
  if (!raw) {
    return "";
  }

  if (raw.includes("투수") || raw === "P") {
    return "투수";
  }
  if (raw.includes("포수") || raw === "C") {
    return "포수";
  }
  if (
    raw.includes("외야")
    || raw.includes("좌익")
    || raw.includes("중견")
    || raw.includes("우익")
    || raw === "LF"
    || raw === "CF"
    || raw === "RF"
  ) {
    return "외야수";
  }
  if (
    raw.includes("내야")
    || raw.includes("1루")
    || raw.includes("2루")
    || raw.includes("3루")
    || raw.includes("유격")
    || raw === "1B"
    || raw === "2B"
    || raw === "3B"
    || raw === "SS"
  ) {
    return "내야수";
  }
  if (raw.includes("지명") || raw === "DH") {
    return "지명타자";
  }

  return "";
}

function isHitterSearchCandidate(player) {
  const profile = String(player?.P_LINK || "");
  const posGroup = normalizeLineupPositionGroup(player?.POS_NO);
  if (/PitcherDetail/i.test(profile)) {
    return false;
  }
  return posGroup !== "투수";
}

function buildHitterAdvancedSourceUrls() {
  const sorts = [
    "OPS_RT",
    "HIT_CN",
    "HR_CN",
    "RBI_CN",
    "BB_CN",
    "PA_CN",
    "SB_CN",
    "GPA_RT",
    "ISOP_RT",
  ];

  const urls = [KBO_PLAYER_HITTER_ADVANCED_URL];
  for (const sortKey of sorts) {
    urls.push(`${KBO_PLAYER_HITTER_ADVANCED_URL}?sort=${encodeURIComponent(sortKey)}`);
  }

  return [...new Set(urls)];
}

function parseKboPlayerHitterAdvanced(html) {
  const $ = cheerio.load(html);
  const metricsByPlayer = new Map();

  const rowSelector = "table.tData01.tt tbody tr, table.tData.tt tbody tr";
  $(rowSelector).each((_, rowNode) => {
    const cells = $(rowNode).find("td");
    if (cells.length < 12) {
      return;
    }

    const nameCell = cells.eq(1);
    const name = nameCell.text().trim();
    const team = cells.eq(2).text().trim();
    const slg = toFiniteNumber(cells.eq(9).text().trim());
    const obp = toFiniteNumber(cells.eq(10).text().trim());
    const ops = toFiniteNumber(cells.eq(11).text().trim());
    const bb = toFiniteNumber(cells.eq(4).text().trim());
    const hbp = toFiniteNumber(cells.eq(6).text().trim());
    const profileHref = nameCell.find("a").attr("href") || "";
    const playerIdMatch = profileHref.match(/[?&]playerId=(\d+)/);
    const playerId = playerIdMatch ? playerIdMatch[1] : null;

    if (!name || !team) {
      return;
    }

    const key = buildTeamPlayerKey(team, name);
    if (!key) {
      return;
    }

    metricsByPlayer.set(key, {
      name,
      team,
      playerId,
      ops,
      obp,
      slg,
      bb,
      hbp,
    });
  });

  return metricsByPlayer;
}

async function loadKboPlayerHitterAdvancedMap() {
  const cacheKey = "kbo:player-hitter-basic2";
  const cached = KBO_PLAYER_HITTER_ADVANCED_CACHE.get(cacheKey);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const urls = buildHitterAdvancedSourceUrls();
    const fetched = await Promise.allSettled(urls.map((url) => fetchHtml(url)));
    const value = new Map();

    for (const item of fetched) {
      if (item.status !== "fulfilled") {
        continue;
      }

      const partial = parseKboPlayerHitterAdvanced(item.value);
      for (const [key, nextMetrics] of partial.entries()) {
        const prevMetrics = value.get(key);
        if (!prevMetrics) {
          value.set(key, nextMetrics);
          continue;
        }

        const prevOps = toFiniteNumber(prevMetrics.ops);
        const nextOps = toFiniteNumber(nextMetrics.ops);
        if (!Number.isFinite(prevOps) && Number.isFinite(nextOps)) {
          value.set(key, nextMetrics);
        }
      }
    }

    KBO_PLAYER_HITTER_ADVANCED_CACHE.set(cacheKey, {
      fetchedAt: Date.now(),
      value,
    });
    return value;
  } catch {
    return new Map();
  }
}

async function lookupLineupHitterMetrics(metricsByPlayer, team, playerName, lineupPosition = "") {
  const lookupKey = buildTeamPlayerKey(team, playerName);
  if (lookupKey && metricsByPlayer.has(lookupKey)) {
    return metricsByPlayer.get(lookupKey);
  }

  const normalizedName = normalizePlayerNameKey(playerName);
  if (!normalizedName) {
    return null;
  }

  let candidate = null;
  let candidateCount = 0;
  for (const [key, metrics] of metricsByPlayer.entries()) {
    if (!key.endsWith(`:${normalizedName}`)) {
      continue;
    }
    candidate = metrics;
    candidateCount += 1;
    if (candidateCount > 1) {
      return null;
    }
  }

  if (candidate) {
    return candidate;
  }

  return resolveHitterMetricsByPlayerSearch(team, playerName, lineupPosition);
}

async function searchKboPlayersByName(name) {
  const normalizedName = normalizePlayerNameKey(name);
  if (!normalizedName) {
    return [];
  }

  const cached = KBO_SEARCH_PLAYER_CACHE.get(normalizedName);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const payload = await fetchKboJson(KBO_SEARCH_PLAYER_URL, { name: normalizedName });
    const nowPlayers = Array.isArray(payload?.now) ? payload.now : [];
    KBO_SEARCH_PLAYER_CACHE.set(normalizedName, {
      fetchedAt: Date.now(),
      value: nowPlayers,
    });
    return nowPlayers;
  } catch {
    return [];
  }
}

function parseKboHitterDetailProfile(html, playerId) {
  const $ = cheerio.load(html);
  const tables = $("table").toArray();

  const readTable = (predicate) => {
    const table = tables.find((tableNode) => {
      const headers = $(tableNode).find("thead th").toArray().map((th) => $(th).text().trim());
      return predicate(headers);
    });

    if (!table) {
      return null;
    }

    const headers = $(table).find("thead th").toArray().map((th) => $(th).text().trim());
    const firstRow = $(table).find("tbody tr").first();
    const values = firstRow.find("td").toArray().map((td) => $(td).text().trim());
    if (values.length === 0 || /^기록이 없습니다/.test(values[0])) {
      return null;
    }

    const map = new Map();
    headers.forEach((header, index) => {
      map.set(header, values[index] || "");
    });
    return map;
  };

  const seasonA = readTable((headers) => headers.includes("팀명") && headers.includes("AVG") && headers.includes("PA") && headers.includes("AB"));
  const seasonB = readTable((headers) => headers.includes("BB") && headers.includes("SLG") && headers.includes("OBP") && headers.includes("OPS"));

  if (!seasonA || !seasonB) {
    return null;
  }

  return {
    playerId: String(playerId),
    team: String(seasonA.get("팀명") || "").trim(),
    ops: toFiniteNumber(seasonB.get("OPS")),
    obp: toFiniteNumber(seasonB.get("OBP")),
    slg: toFiniteNumber(seasonB.get("SLG")),
    bb: toFiniteNumber(seasonB.get("BB")),
    hbp: toFiniteNumber(seasonB.get("HBP")),
  };
}

async function loadKboHitterDetailById(playerId) {
  const normalizedId = String(playerId || "").trim();
  if (!normalizedId) {
    return null;
  }

  const cached = KBO_HITTER_DETAIL_CACHE.get(normalizedId);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const detailUrl = `https://www.koreabaseball.com/Record/Player/HitterDetail/Basic.aspx?playerId=${encodeURIComponent(normalizedId)}`;
    const html = await fetchHtml(detailUrl);
    const value = parseKboHitterDetailProfile(html, normalizedId);
    KBO_HITTER_DETAIL_CACHE.set(normalizedId, {
      fetchedAt: Date.now(),
      value,
    });
    return value;
  } catch {
    return null;
  }
}

async function resolveHitterMetricsByPlayerSearch(teamName, playerName, lineupPosition = "") {
  const teamId = resolveKboTeamId(teamName);
  const candidates = await searchKboPlayersByName(playerName);
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  const normalizedName = normalizePlayerNameKey(playerName);
  const filteredByName = candidates.filter((player) => normalizePlayerNameKey(player?.P_NM) === normalizedName);
  const filteredByTeam = teamId
    ? filteredByName.filter((player) => String(player?.T_ID || "").trim() === teamId)
    : filteredByName;

  let pool = filteredByTeam.length > 0
    ? filteredByTeam
    : (filteredByName.length > 0 ? filteredByName : candidates);

  const lineupGroup = normalizeLineupPositionGroup(lineupPosition);
  if (lineupGroup) {
    if (lineupGroup === "지명타자") {
      const nonPitchers = pool.filter((player) => normalizeLineupPositionGroup(player?.POS_NO) !== "투수");
      if (nonPitchers.length > 0) {
        pool = nonPitchers;
      }
    } else {
      const matchedGroup = pool.filter((player) => normalizeLineupPositionGroup(player?.POS_NO) === lineupGroup);
      if (matchedGroup.length > 0) {
        pool = matchedGroup;
      }
    }
  }

  const hitterCandidates = pool.filter((player) => isHitterSearchCandidate(player));
  if (hitterCandidates.length > 0) {
    pool = hitterCandidates;
  }

  for (const selected of pool) {
    const playerId = selected?.P_ID;
    if (!playerId) {
      continue;
    }

    const detail = await loadKboHitterDetailById(playerId);
    if (detail) {
      return detail;
    }
  }

  return null;
}

function parseKboPlayerPitcherBasic(html) {
  const $ = cheerio.load(html);
  const byTeamName = new Map();
  const byPlayerId = new Map();

  const rowSelector = "table.tData01.tt tbody tr, table.tData.tt tbody tr";
  $(rowSelector).each((_, rowNode) => {
    const cells = $(rowNode).find("td");
    if (cells.length < 19) {
      return;
    }

    const nameCell = cells.eq(1);
    const name = nameCell.text().trim();
    const team = cells.eq(2).text().trim();
    const era = toFiniteNumber(cells.eq(3).text().trim());
    const games = toFiniteNumber(cells.eq(4).text().trim());
    const inningsOuts = parseInningsToOuts(cells.eq(10).text().trim());
    const hits = toFiniteNumber(cells.eq(11).text().trim());
    const homeRuns = toFiniteNumber(cells.eq(12).text().trim());
    const walks = toFiniteNumber(cells.eq(13).text().trim());
    const hitByPitch = toFiniteNumber(cells.eq(14).text().trim());
    const strikeouts = toFiniteNumber(cells.eq(15).text().trim());
    const runsAllowed = toFiniteNumber(cells.eq(16).text().trim());
    const earnedRuns = toFiniteNumber(cells.eq(17).text().trim());
    const whip = toFiniteNumber(cells.eq(18).text().trim());
    const profileHref = nameCell.find("a").attr("href") || "";
    const playerIdMatch = profileHref.match(/[?&]playerId=(\d+)/);
    const playerId = playerIdMatch ? playerIdMatch[1] : null;

    if (!name || !team) {
      return;
    }

    const key = buildTeamPlayerKey(team, name);
    if (!key) {
      return;
    }

    const entry = {
      name,
      team,
      playerId,
      era,
      games,
      inningsOuts,
      hits,
      homeRuns,
      walks,
      hitByPitch,
      strikeouts,
      runsAllowed,
      earnedRuns,
      whip,
      hitsPer9: perNine(hits, inningsOuts),
      hrPer9: perNine(homeRuns, inningsOuts),
      bbPer9: perNine(walks, inningsOuts),
      hbpPer9: perNine(hitByPitch, inningsOuts),
      soPer9: perNine(strikeouts, inningsOuts),
      runsPer9: perNine(runsAllowed, inningsOuts),
      freePassPer9: perNine((Number(walks) || 0) + (Number(hitByPitch) || 0), inningsOuts),
      kbbRatio: Number.isFinite(strikeouts) && Number.isFinite(walks)
        ? (strikeouts + 1) / (walks + 1)
        : null,
    };

    byTeamName.set(key, entry);
    if (playerId) {
      byPlayerId.set(playerId, entry);
    }
  });

  return {
    byTeamName,
    byPlayerId,
  };
}

async function loadKboPlayerPitcherBasicMap() {
  const cacheKey = "kbo:player-pitcher-basic1";
  const cached = KBO_PLAYER_PITCHER_BASIC_CACHE.get(cacheKey);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const html = await fetchHtml(KBO_PLAYER_PITCHER_BASIC_URL);
    const value = parseKboPlayerPitcherBasic(html);
    KBO_PLAYER_PITCHER_BASIC_CACHE.set(cacheKey, {
      fetchedAt: Date.now(),
      value,
    });
    return value;
  } catch {
    return {
      byTeamName: new Map(),
      byPlayerId: new Map(),
    };
  }
}

function parseKboPitcherDetailProfile(html, playerId) {
  const $ = cheerio.load(html);
  const tables = $("table").toArray();

  const readTable = (predicate) => {
    const table = tables.find((tableNode) => {
      const headers = $(tableNode).find("thead th").toArray().map((th) => $(th).text().trim());
      return predicate(headers);
    });

    if (!table) {
      return null;
    }

    const headers = $(table).find("thead th").toArray().map((th) => $(th).text().trim());
    const firstRow = $(table).find("tbody tr").first();
    const values = firstRow.find("td").toArray().map((td) => $(td).text().trim());
    if (values.length === 0) {
      return null;
    }

    const map = new Map();
    headers.forEach((header, index) => {
      map.set(header, values[index] || "");
    });
    return map;
  };

  const seasonA = readTable((headers) => headers.includes("팀명") && headers.includes("ERA") && headers.includes("IP") && headers.includes("H") && headers.includes("HR"));
  const seasonB = readTable((headers) => headers.includes("BB") && headers.includes("SO") && headers.includes("R") && headers.includes("WHIP"));
  const gameLog = readTable((headers) => headers.includes("일자") && headers.includes("HBP") && headers.includes("IP"));

  if (!seasonA || !seasonB) {
    return null;
  }

  let gameLogHbp = 0;
  const gameLogTable = tables.find((tableNode) => {
    const headers = $(tableNode).find("thead th").toArray().map((th) => $(th).text().trim());
    return headers.includes("일자") && headers.includes("HBP") && headers.includes("IP");
  });

  if (gameLogTable) {
    const headers = $(gameLogTable).find("thead th").toArray().map((th) => $(th).text().trim());
    const hbpIndex = headers.indexOf("HBP");
    if (hbpIndex >= 0) {
      $(gameLogTable).find("tbody tr").each((_, rowNode) => {
        const cells = $(rowNode).find("td");
        if (cells.length <= hbpIndex) {
          return;
        }
        const value = toFiniteNumber(cells.eq(hbpIndex).text().trim());
        if (Number.isFinite(value)) {
          gameLogHbp += value;
        }
      });
    }
  }

  const team = String(seasonA.get("팀명") || "").trim();
  const inningsOuts = parseInningsToOuts(seasonA.get("IP"));
  const hits = toFiniteNumber(seasonA.get("H"));
  const homeRuns = toFiniteNumber(seasonA.get("HR"));
  const walks = toFiniteNumber(seasonB.get("BB"));
  const strikeouts = toFiniteNumber(seasonB.get("SO"));
  const runsAllowed = toFiniteNumber(seasonB.get("R"));
  const games = toFiniteNumber(seasonA.get("G"));
  const era = toFiniteNumber(seasonA.get("ERA"));
  const whip = toFiniteNumber(seasonB.get("WHIP"));
  const qs = toFiniteNumber(seasonB.get("QS"));
  const hitByPitch = Number.isFinite(gameLogHbp) ? gameLogHbp : 0;

  return {
    team,
    playerId: String(playerId),
    era,
    games,
    inningsOuts,
    hits,
    homeRuns,
    walks,
    hitByPitch,
    strikeouts,
    runsAllowed,
    whip,
    qs,
    hitsPer9: perNine(hits, inningsOuts),
    hrPer9: perNine(homeRuns, inningsOuts),
    bbPer9: perNine(walks, inningsOuts),
    hbpPer9: perNine(hitByPitch, inningsOuts),
    soPer9: perNine(strikeouts, inningsOuts),
    runsPer9: perNine(runsAllowed, inningsOuts),
    freePassPer9: perNine((Number(walks) || 0) + (Number(hitByPitch) || 0), inningsOuts),
    kbbRatio: Number.isFinite(strikeouts) && Number.isFinite(walks)
      ? (strikeouts + 1) / (walks + 1)
      : null,
  };
}

async function loadKboPitcherDetailById(playerId) {
  const normalizedId = String(playerId || "").trim();
  if (!normalizedId) {
    return null;
  }

  const cached = KBO_PITCHER_DETAIL_CACHE.get(normalizedId);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const detailUrl = `https://www.koreabaseball.com/Record/Player/PitcherDetail/Basic.aspx?playerId=${encodeURIComponent(normalizedId)}`;
    const html = await fetchHtml(detailUrl);
    const value = parseKboPitcherDetailProfile(html, normalizedId);
    KBO_PITCHER_DETAIL_CACHE.set(normalizedId, {
      fetchedAt: Date.now(),
      value,
    });
    return value;
  } catch {
    return null;
  }
}

async function attachStarterPitcherProfiles(prediction, pitcherMap) {
  const byId = pitcherMap?.byPlayerId instanceof Map ? pitcherMap.byPlayerId : new Map();
  const byTeamName = pitcherMap?.byTeamName instanceof Map ? pitcherMap.byTeamName : new Map();
  const awayKey = buildTeamPlayerKey(prediction.awayTeam, prediction.awayStarter);
  const homeKey = buildTeamPlayerKey(prediction.homeTeam, prediction.homeStarter);
  const awayById = prediction.awayPitcherId ? byId.get(String(prediction.awayPitcherId)) : null;
  const homeById = prediction.homePitcherId ? byId.get(String(prediction.homePitcherId)) : null;
  const awayByName = awayKey ? byTeamName.get(awayKey) : null;
  const homeByName = homeKey ? byTeamName.get(homeKey) : null;

  let awayProfile = awayById || awayByName || null;
  let homeProfile = homeById || homeByName || null;

  if (!awayProfile && prediction.awayPitcherId) {
    awayProfile = await loadKboPitcherDetailById(prediction.awayPitcherId);
  }

  if (!homeProfile && prediction.homePitcherId) {
    homeProfile = await loadKboPitcherDetailById(prediction.homePitcherId);
  }

  return {
    awayStarterProfile: awayProfile,
    homeStarterProfile: homeProfile,
  };
}

async function attachLineupHitterMetrics(lineup, teamName, metricsByPlayer) {
  const players = Array.isArray(lineup) ? lineup : [];
  const team = String(teamName || "").trim();
  let matchedCount = 0;

  const enrichedLineup = await Promise.all(players.map(async (player) => {
    const playerName = player?.name || player?.playerName || "";
    const lineupPosition = player?.position || "";
    const metrics = await lookupLineupHitterMetrics(metricsByPlayer, team, playerName, lineupPosition);

    if (!metrics) {
      return player;
    }

    matchedCount += 1;

    return {
      ...player,
      ops: toFiniteNumber(metrics.ops),
      obp: toFiniteNumber(metrics.obp),
      slg: toFiniteNumber(metrics.slg),
      bb: toFiniteNumber(metrics.bb),
      hbp: toFiniteNumber(metrics.hbp),
      playerId: metrics.playerId || player?.playerId || null,
    };
  }));

  return {
    lineup: enrichedLineup,
    matchedCount,
    sourceCount: players.length,
  };
}

function buildTeamRows(hitterRunsMap, pitcherRunsAllowedMap, exponent) {
  const rows = [];

  for (const [team, hitter] of hitterRunsMap.entries()) {
    const pitcher = pitcherRunsAllowedMap.get(team);

    if (!pitcher || typeof pitcher.runsAllowed !== "number") {
      continue;
    }

    const runsAllowed = pitcher.runsAllowed;
    const hrPerGame = hitter.games > 0 ? hitter.homeRuns / hitter.games : 0;
    const bullpenUsagePerGame = pitcher.games > 0 ? (pitcher.saves + pitcher.holds) / pitcher.games : 0;
    const kbbRatio = (pitcher.strikeouts + 1) / (pitcher.walks + 1);

    const pythagoreanWinPct = calculatePythagoreanWinPct(
      hitter.runsScored,
      runsAllowed,
      exponent,
    );

    rows.push({
      team,
      games: hitter.games,
      runsScored: hitter.runsScored,
      runsAllowed,
      battingAvg: hitter.battingAvg,
      homeRuns: hitter.homeRuns,
      hrPerGame,
      teamEra: pitcher.teamEra,
      teamWhip: pitcher.teamWhip,
      bullpenUsagePerGame,
      kbbRatio,
      pythagoreanWinPct,
    });
  }

  rows.sort((a, b) => b.pythagoreanWinPct - a.pythagoreanWinPct);
  return rows;
}

async function loadKboTeamRows(exponent) {
  const [hitterHtml, pitcherHtml] = await Promise.all([
    fetchHtml(KBO_HITTER_URL),
    fetchHtml(KBO_PITCHER_URL),
  ]);

  const hitterRunsMap = parseHitterRuns(hitterHtml);
  const pitcherRunsAllowedMap = parsePitcherRunsAllowed(pitcherHtml);
  const rows = buildTeamRows(hitterRunsMap, pitcherRunsAllowedMap, exponent);

  if (
    hitterRunsMap.size !== EXPECTED_TEAMS ||
    pitcherRunsAllowedMap.size !== EXPECTED_TEAMS ||
    rows.length !== EXPECTED_TEAMS
  ) {
    throw new Error("Upstream KBO format changed.");
  }

  return rows;
}

async function loadTeamRowsByLeague(league, exponent) {
  if (league !== "kbo") {
    throw new Error("KBO only service");
  }
  return loadKboTeamRows(exponent);
}

async function getGameDate(date) {
  const result = await fetchKboJson(KBO_GAME_DATE_URL, {
    leId: "1",
    srId: KBO_SERIES_IDS,
    date,
  });

  if (!result || result.code !== "100" || !result.NOW_G_DT) {
    throw new Error("Failed to load game date.");
  }

  return result;
}

async function getGameList(date) {
  const result = await fetchKboJson(KBO_GAME_LIST_URL, {
    leId: "1",
    srId: KBO_SERIES_IDS,
    date,
  });

  if (!result || result.code !== "100" || !Array.isArray(result.game)) {
    throw new Error("Failed to load game list.");
  }

  return result.game;
}

function parseKboLineupGrid(rawGrid) {
  try {
    const grid = typeof rawGrid === "string" ? JSON.parse(rawGrid) : rawGrid;
    const rows = Array.isArray(grid?.rows) ? grid.rows : [];
    return rows
      .map((rowWrapper) => {
        const row = Array.isArray(rowWrapper?.row) ? rowWrapper.row : [];
        const order = toFiniteNumber(row[0]?.Text);
        const position = String(row[1]?.Text || "").trim();
        const name = String(row[2]?.Text || "").trim();
        const war = toFiniteNumber(row[3]?.Text);

        if (!Number.isFinite(order) || !name) {
          return null;
        }

        return {
          order,
          position,
          name,
          war,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.order - b.order);
  } catch {
    return [];
  }
}

async function loadKboLineupForGame(game) {
  const gameId = String(game?.gameId || "").trim();
  if (!gameId) {
    return {
      awayLineup: [],
      homeLineup: [],
      lineupDataReady: false,
      lineupConfirmed: null,
      lineupStatusText: null,
    };
  }

  const cached = KBO_LINEUP_CACHE.get(gameId);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const payload = await fetchKboJson(KBO_LINEUP_ANALYSIS_URL, {
      leId: String(game.leagueId),
      srId: String(game.seriesId),
      seasonId: String(game.seasonId),
      gameId,
      groupSc: "SEASON",
    });

    const teamMetaA = Array.isArray(payload?.[1]) ? payload[1][0] : null;
    const teamMetaB = Array.isArray(payload?.[2]) ? payload[2][0] : null;
    const gridA = Array.isArray(payload?.[3]) ? payload[3][0] : null;
    const gridB = Array.isArray(payload?.[4]) ? payload[4][0] : null;
    const lineupMeta = Array.isArray(payload?.[0]) ? payload[0][0] : null;

    const lineupA = parseKboLineupGrid(gridA);
    const lineupB = parseKboLineupGrid(gridB);

    const teamAId = String(teamMetaA?.T_ID || "").trim();
    const teamBId = String(teamMetaB?.T_ID || "").trim();
    const awayId = String(game.awayTeamId || "").trim();
    const homeId = String(game.homeTeamId || "").trim();

    let awayLineup = [];
    let homeLineup = [];

    if (teamAId && teamBId) {
      if (teamAId === awayId) {
        awayLineup = lineupA;
      } else if (teamAId === homeId) {
        homeLineup = lineupA;
      }

      if (teamBId === awayId) {
        awayLineup = lineupB;
      } else if (teamBId === homeId) {
        homeLineup = lineupB;
      }
    }

    const lineupCk = toFiniteNumber(lineupMeta?.LINEUP_CK);
    const lineupConfirmed = Number.isFinite(lineupCk) ? lineupCk > 0 : null;
    const lineupStatusText = lineupConfirmed === true
      ? "금일 라인업 기준입니다."
      : lineupConfirmed === false
        ? "라인업 발표 전으로 최근 라인업 기준입니다."
        : null;

    const value = {
      awayLineup,
      homeLineup,
      lineupDataReady: awayLineup.length > 0 || homeLineup.length > 0,
      lineupConfirmed,
      lineupStatusText,
    };

    KBO_LINEUP_CACHE.set(gameId, {
      fetchedAt: Date.now(),
      value,
    });

    return value;
  } catch {
    return {
      awayLineup: [],
      homeLineup: [],
      lineupDataReady: false,
      lineupConfirmed: null,
      lineupStatusText: null,
    };
  }
}

function getTeamRunsPerGame(teamRow) {
  if (!teamRow || !teamRow.games) {
    return { offenseRpg: 0, defenseRpg: 0 };
  }

  return {
    offenseRpg: teamRow.runsScored / teamRow.games,
    defenseRpg: teamRow.runsAllowed / teamRow.games,
  };
}

function getLeagueRunsPerGame(teamRows) {
  if (!Array.isArray(teamRows) || teamRows.length === 0) {
    return 4.5;
  }

  const totalOffenseRpg = teamRows.reduce((sum, row) => {
    const { offenseRpg } = getTeamRunsPerGame(row);
    return sum + offenseRpg;
  }, 0);

  return totalOffenseRpg / teamRows.length;
}

function hasGameCancellationFlag(game) {
  const cancelName = String(game.CANCEL_SC_NM || "").trim();
  if (!cancelName || cancelName === "정상경기") {
    return false;
  }

  const blockedKeywords = ["취소", "우천", "중지", "순연", "노게임", "Postponed", "Canceled", "Cancelled", "Suspended"];
  return blockedKeywords.some((keyword) => cancelName.includes(keyword));
}

function isPredictableGameState(game, includeFinished, includeLiveGames = false) {
  if (hasGameCancellationFlag(game)) {
    return false;
  }

  const state = String(game.GAME_STATE_SC || "");
  if (includeFinished || includeLiveGames) {
    return ["1", "2", "3"].includes(state);
  }

  return state === "1";
}

function predictGames(teamRows, gameList, homeAdvantage, options = {}) {
  const includeFinished = options.includeFinished === true;
  const includeLiveGames = options.includeLiveGames === true;
  const teamMapByName = new Map(teamRows.map((row) => [row.team, row]));
  const teamMapById = new Map(
    teamRows
      .filter((row) => Number.isFinite(row.teamId))
      .map((row) => [String(row.teamId), row]),
  );
  const nowDate = new Date();

  return gameList
    .filter((game) => isPredictableGameState(game, includeFinished, includeLiveGames))
    .filter((game) => game.AWAY_NM && game.HOME_NM)
    .map((game) => {
      const away = teamMapById.get(String(game.AWAY_ID)) || teamMapByName.get(game.AWAY_NM);
      const home = teamMapById.get(String(game.HOME_ID)) || teamMapByName.get(game.HOME_NM);

      if (!away || !home) {
        return null;
      }

      const baseHomeWinProb = calculateLog5WinProbability(home.pythagoreanWinPct, away.pythagoreanWinPct);
      const adjustedHomeWinProb = Math.max(0.01, Math.min(0.99, baseHomeWinProb + homeAdvantage));
      const awayWinProb = 1 - adjustedHomeWinProb;
      const lineupConfirmed = isLineupConfirmedForGame(game, nowDate);
      const awayStarterValue = game.T_PIT_P_NM ? String(game.T_PIT_P_NM).trim() : "";
      const homeStarterValue = game.B_PIT_P_NM ? String(game.B_PIT_P_NM).trim() : "";
      const hasAwayStarter = isUsableStarterName(awayStarterValue);
      const hasHomeStarter = isUsableStarterName(homeStarterValue);
      const awayScore = parseGameScore(game.T_SCORE_CN);
      const homeScore = parseGameScore(game.B_SCORE_CN);
      const isFinal = String(game.GAME_STATE_SC || "") === "3";
      const hasFinalScore = isFinal && Number.isFinite(awayScore) && Number.isFinite(homeScore);
      const starterAnnounced = Number(game.START_PIT_CK) > 0 || hasAwayStarter || hasHomeStarter;

      let actualWinner = null;
      if (hasFinalScore) {
        if (homeScore > awayScore) {
          actualWinner = home.team;
        } else if (awayScore > homeScore) {
          actualWinner = away.team;
        }
      }

      return {
        gameId: game.G_ID,
        gameKey: resolveGameKey(game),
        leagueId: game.LE_ID,
        seriesId: game.SR_ID,
        seasonId: game.SEASON_ID,
        awayTeamId: game.AWAY_ID,
        homeTeamId: game.HOME_ID,
        awayPitcherId: game.T_PIT_P_ID,
        homePitcherId: game.B_PIT_P_ID,
        gameDate: game.G_DT,
        gameTime: game.G_TM,
        stadium: game.S_NM,
        gameState: game.GAME_STATE_SC,
        awayTeam: away.team,
        homeTeam: home.team,
        awayStarter: hasAwayStarter ? awayStarterValue : "",
        homeStarter: hasHomeStarter ? homeStarterValue : "",
        awayStarterRaw: game.T_PIT_P_NM_RAW ? String(game.T_PIT_P_NM_RAW).trim() : "",
        homeStarterRaw: game.B_PIT_P_NM_RAW ? String(game.B_PIT_P_NM_RAW).trim() : "",
        lineupConfirmed,
        starterAnnounced,
        awayPythagorean: away.pythagoreanWinPct,
        homePythagorean: home.pythagoreanWinPct,
        awayWinProbability: Number(awayWinProb.toFixed(3)),
        homeWinProbability: Number(adjustedHomeWinProb.toFixed(3)),
        actualAwayScore: hasFinalScore ? awayScore : null,
        actualHomeScore: hasFinalScore ? homeScore : null,
        actualWinner,
      };
    })
    .filter(Boolean);
}

async function buildKboPredictionsForDate({
  date,
  teamRows,
  homeAdvantage,
  includeFinished,
  includeLiveGames,
  modelCoefficients,
}) {
  const normalizedDate = await getGameDate(date);
  const gameList = await getGameList(normalizedDate.NOW_G_DT);
  const rawPredictions = predictGames(teamRows, gameList, homeAdvantage, {
    includeFinished,
    includeLiveGames,
  });

  const withLineups = await Promise.all(
    rawPredictions.map(async (prediction) => {
      const lineup = await loadKboLineupForGame(prediction);
      return {
        ...prediction,
        awayLineup: lineup.awayLineup,
        homeLineup: lineup.homeLineup,
        lineupDataReady: lineup.lineupDataReady,
        lineupConfirmed: typeof lineup.lineupConfirmed === "boolean"
          ? lineup.lineupConfirmed
          : prediction.lineupConfirmed,
        lineupStatusText: lineup.lineupStatusText,
      };
    }),
  );

  const playerHitterAdvancedMap = await loadKboPlayerHitterAdvancedMap();
  const playerPitcherBasicMap = await loadKboPlayerPitcherBasicMap();
  const withLineupHitterMetrics = await Promise.all(withLineups.map(async (prediction) => {
    const awayMetrics = await attachLineupHitterMetrics(
      prediction.awayLineup,
      prediction.awayTeam,
      playerHitterAdvancedMap,
    );
    const homeMetrics = await attachLineupHitterMetrics(
      prediction.homeLineup,
      prediction.homeTeam,
      playerHitterAdvancedMap,
    );
    const starterProfiles = await attachStarterPitcherProfiles(prediction, playerPitcherBasicMap);
    return {
      ...prediction,
      lineupConfirmed: prediction.lineupConfirmed,
      lineupStatusText: prediction.lineupStatusText,
      awayLineup: awayMetrics.lineup,
      homeLineup: homeMetrics.lineup,
      ...starterProfiles,
      lineupHitterMetricsCoverage: {
        awayMatchedCount: awayMetrics.matchedCount,
        homeMatchedCount: homeMetrics.matchedCount,
        awaySourceCount: awayMetrics.sourceCount,
        homeSourceCount: homeMetrics.sourceCount,
      },
    };
  }));

  const withStarterEra = await enrichPredictionsWithStarterEra(withLineupHitterMetrics);
  const predictions = enrichPredictionsWithScoreModel(
    withStarterEra,
    teamRows,
    homeAdvantage,
    modelCoefficients,
    "kbo",
  ).sort(
    (a, b) => Math.max(b.homeWinProbability, b.awayWinProbability) - Math.max(a.homeWinProbability, a.awayWinProbability),
  );

  return {
    normalizedDate,
    predictions,
  };
}

async function buildPredictionsForDate({
  date,
  teamRows,
  homeAdvantage,
  includeFinished,
  includeLiveGames,
  modelCoefficients,
}) {
  return buildKboPredictionsForDate({
    date,
    teamRows,
    homeAdvantage,
    includeFinished,
    includeLiveGames,
    modelCoefficients,
  });
}

function parseStarterMetrics(analysis) {
  if (!analysis || !Array.isArray(analysis.rows)) {
    return {
      awayStarterEra: null,
      homeStarterEra: null,
      awayStarterGames: null,
      homeStarterGames: null,
      awayStarterWhip: null,
      homeStarterWhip: null,
      awayStarterStartInnings: null,
      homeStarterStartInnings: null,
      awayStarterQs: null,
      homeStarterQs: null,
      awayStarterWar: null,
      homeStarterWar: null,
    };
  }

  let awayStarterEra = null;
  let homeStarterEra = null;
  let awayStarterGames = null;
  let homeStarterGames = null;
  let awayStarterWhip = null;
  let homeStarterWhip = null;
  let awayStarterStartInnings = null;
  let homeStarterStartInnings = null;
  let awayStarterQs = null;
  let homeStarterQs = null;
  let awayStarterWar = null;
  let homeStarterWar = null;

  for (const rowWrapper of analysis.rows) {
    if (!rowWrapper || !Array.isArray(rowWrapper.row)) {
      continue;
    }

    for (const cell of rowWrapper.row) {
      const className = cell && typeof cell.Class === "string" ? cell.Class : "";
      const cellValue = toFiniteNumber(cell && typeof cell.Text === "string" ? cell.Text.trim() : null);

      if (className === "td_era_T" && cellValue !== null) {
        awayStarterEra = cellValue;
      }

      if (className === "td_era_B" && cellValue !== null) {
        homeStarterEra = cellValue;
      }

      if (className === "td_game_T" && cellValue !== null) {
        awayStarterGames = cellValue;
      }

      if (className === "td_game_B" && cellValue !== null) {
        homeStarterGames = cellValue;
      }

      if (className === "td_whip_T" && cellValue !== null) {
        awayStarterWhip = cellValue;
      }

      if (className === "td_whip_B" && cellValue !== null) {
        homeStarterWhip = cellValue;
      }

      if (className === "td_startInn_T" && cellValue !== null) {
        awayStarterStartInnings = cellValue;
      }

      if (className === "td_startInn_B" && cellValue !== null) {
        homeStarterStartInnings = cellValue;
      }

      if (className === "td_qs_T" && cellValue !== null) {
        awayStarterQs = cellValue;
      }

      if (className === "td_qs_B" && cellValue !== null) {
        homeStarterQs = cellValue;
      }

      if (className === "td_war_T" && cellValue !== null) {
        awayStarterWar = cellValue;
      }

      if (className === "td_war_B" && cellValue !== null) {
        homeStarterWar = cellValue;
      }
    }
  }

  const awayHasSample = Number.isFinite(awayStarterGames) && awayStarterGames > 0;
  const homeHasSample = Number.isFinite(homeStarterGames) && homeStarterGames > 0;

  if (!awayHasSample) {
    awayStarterEra = null;
    awayStarterGames = null;
  }

  if (!homeHasSample) {
    homeStarterEra = null;
    homeStarterGames = null;
  }

  return {
    awayStarterEra,
    homeStarterEra,
    awayStarterGames,
    homeStarterGames,
    awayStarterWhip,
    homeStarterWhip,
    awayStarterStartInnings,
    homeStarterStartInnings,
    awayStarterQs,
    homeStarterQs,
    awayStarterWar,
    homeStarterWar,
  };
}

async function getStarterEraForGame(game) {
  if (!game.starterAnnounced) {
    return {
      awayStarterEra: null,
      homeStarterEra: null,
      awayStarterGames: null,
      homeStarterGames: null,
      awayStarterWhip: null,
      homeStarterWhip: null,
      awayStarterStartInnings: null,
      homeStarterStartInnings: null,
      awayStarterQs: null,
      homeStarterQs: null,
      awayStarterWar: null,
      homeStarterWar: null,
    };
  }

  if (!game.awayPitcherId || !game.homePitcherId) {
    return {
      awayStarterEra: null,
      homeStarterEra: null,
      awayStarterGames: null,
      homeStarterGames: null,
      awayStarterWhip: null,
      homeStarterWhip: null,
      awayStarterStartInnings: null,
      homeStarterStartInnings: null,
      awayStarterQs: null,
      homeStarterQs: null,
      awayStarterWar: null,
      homeStarterWar: null,
    };
  }

  const isPostSeason = [3, 4, 5, 7].includes(Number(game.seriesId));
  const url = isPostSeason ? KBO_PITCHER_RECORD_ANALYSIS_POST_URL : KBO_PITCHER_RECORD_ANALYSIS_URL;

  const analysis = await fetchKboJson(url, {
    leId: String(game.leagueId),
    srId: String(game.seriesId),
    seasonId: String(game.seasonId),
    awayTeamId: String(game.awayTeamId),
    awayPitId: String(game.awayPitcherId),
    homeTeamId: String(game.homeTeamId),
    homePitId: String(game.homePitcherId),
    groupSc: "SEASON",
  });

  return parseStarterMetrics(analysis);
}

async function enrichPredictionsWithStarterEra(predictions) {
  const enriched = await Promise.all(
    predictions.map(async (prediction) => {
      const {
        leagueId,
        seriesId,
        seasonId,
        awayTeamId,
        homeTeamId,
        awayPitcherId,
        homePitcherId,
        lineupConfirmed,
        starterAnnounced,
        ...publicPrediction
      } = prediction;

      try {
        const starterEra = await getStarterEraForGame({
          leagueId,
          seriesId,
          seasonId,
          awayTeamId,
          homeTeamId,
          awayPitcherId,
          homePitcherId,
          lineupConfirmed,
          starterAnnounced,
        });

        return {
          ...publicPrediction,
          lineupConfirmed,
          starterAnnounced,
          awayStarterEra: starterEra.awayStarterEra,
          homeStarterEra: starterEra.homeStarterEra,
          awayStarterGames: starterEra.awayStarterGames,
          homeStarterGames: starterEra.homeStarterGames,
          awayStarterWhip: starterEra.awayStarterWhip,
          homeStarterWhip: starterEra.homeStarterWhip,
          awayStarterStartInnings: starterEra.awayStarterStartInnings,
          homeStarterStartInnings: starterEra.homeStarterStartInnings,
          awayStarterQs: starterEra.awayStarterQs,
          homeStarterQs: starterEra.homeStarterQs,
          awayStarterWar: starterEra.awayStarterWar,
          homeStarterWar: starterEra.homeStarterWar,
        };
      } catch (error) {
        return {
          ...publicPrediction,
          lineupConfirmed,
          starterAnnounced,
          awayStarterEra: null,
          homeStarterEra: null,
          awayStarterGames: null,
          homeStarterGames: null,
          awayStarterWhip: null,
          homeStarterWhip: null,
          awayStarterStartInnings: null,
          homeStarterStartInnings: null,
          awayStarterQs: null,
          homeStarterQs: null,
          awayStarterWar: null,
          homeStarterWar: null,
        };
      }
    }),
  );

  return enriched;
}

function enrichPredictionsWithScoreModel(predictions, teamRows, homeAdvantage, modelCoefficients, league = "kbo") {
  const teamMap = new Map(teamRows.map((row) => [row.team, row]));
  const leagueRunsPerGame = getLeagueRunsPerGame(teamRows);
  const homeFieldRunBonus = homeAdvantage * 4.5;
  const model = modelCoefficients || DEFAULT_MODEL_COEFFICIENTS;

  function getTargetRunDiff(homeWinProbability, awayWinProbability, lineupConfirmed) {
    const probDiff = Math.abs(homeWinProbability - awayWinProbability);
    if (!lineupConfirmed) {
      if (probDiff < 0.28) {
        return 1;
      }
      if (probDiff < 0.56) {
        return 2;
      }
      return 3;
    }

    if (probDiff < 0.1) {
      return 1;
    }
    if (probDiff < 0.2) {
      return 2;
    }
    if (probDiff < 0.34) {
      return 3;
    }
    return 4;
  }

  function getStarterRunImpact(starterEra, starterGames) {
    if (!Number.isFinite(starterEra) || !Number.isFinite(starterGames) || starterGames <= 0) {
      return 0;
    }

    const boundedEra = clamp(starterEra, STARTER_ERA_MIN, STARTER_ERA_MAX);
    const reliability = Number.isFinite(starterGames)
      ? clamp(starterGames / STARTER_RELIABILITY_GAMES, STARTER_RELIABILITY_MIN, STARTER_RELIABILITY_MAX)
      : 0.35;
    const eraDelta = boundedEra - leagueRunsPerGame;
    return eraDelta * STARTER_RUN_IMPACT_COEFF * reliability;
  }

  function getStarterEraReliability(awayStarterGames, homeStarterGames) {
    if (!Number.isFinite(awayStarterGames) || !Number.isFinite(homeStarterGames)) {
      return 0;
    }

    const awayReliability = clamp(
      awayStarterGames / STARTER_RELIABILITY_GAMES,
      STARTER_RELIABILITY_MIN,
      STARTER_RELIABILITY_MAX,
    );
    const homeReliability = clamp(
      homeStarterGames / STARTER_RELIABILITY_GAMES,
      STARTER_RELIABILITY_MIN,
      STARTER_RELIABILITY_MAX,
    );
    return Math.min(awayReliability, homeReliability);
  }

  function getStarterMetricReliability(prediction, awayProfile, homeProfile) {
    if (!prediction.starterAnnounced) {
      return 0;
    }

    const awayGames = Number.isFinite(prediction.awayStarterGames)
      ? prediction.awayStarterGames
      : Number(awayProfile?.games);
    const homeGames = Number.isFinite(prediction.homeStarterGames)
      ? prediction.homeStarterGames
      : Number(homeProfile?.games);

    if (!Number.isFinite(awayGames) || !Number.isFinite(homeGames)) {
      return prediction.lineupConfirmed ? 0.35 : 0.2;
    }

    const baseReliability = Math.min(
      clamp(awayGames / STARTER_RELIABILITY_GAMES, STARTER_RELIABILITY_MIN, STARTER_RELIABILITY_MAX),
      clamp(homeGames / STARTER_RELIABILITY_GAMES, STARTER_RELIABILITY_MIN, STARTER_RELIABILITY_MAX),
    );

    return prediction.lineupConfirmed ? baseReliability : baseReliability * 0.7;
  }

  function getLineupWarSummary(lineup) {
    const players = Array.isArray(lineup) ? lineup : [];
    const wars = players
      .map((player) => toFiniteNumber(player?.war))
      .filter((war) => Number.isFinite(war));

    if (wars.length === 0) {
      return {
        average: null,
        count: 0,
      };
    }

    const total = wars.reduce((sum, war) => sum + war, 0);
    return {
      average: total / wars.length,
      count: wars.length,
    };
  }

  function getLineupRateSummary(lineup, fieldName) {
    const players = Array.isArray(lineup) ? lineup : [];
    const values = players
      .map((player) => toFiniteNumber(player?.[fieldName]))
      .filter((value) => Number.isFinite(value));

    if (values.length === 0) {
      return {
        average: null,
        count: 0,
      };
    }

    const total = values.reduce((sum, value) => sum + value, 0);
    return {
      average: total / values.length,
      count: values.length,
    };
  }

  function normalizeEventProbabilities(rawProbabilities) {
    const safe = {
      single: Math.max(0, Number(rawProbabilities.single) || 0),
      double: Math.max(0, Number(rawProbabilities.double) || 0),
      triple: Math.max(0, Number(rawProbabilities.triple) || 0),
      homer: Math.max(0, Number(rawProbabilities.homer) || 0),
      walk: Math.max(0, Number(rawProbabilities.walk) || 0),
      out: Math.max(0, Number(rawProbabilities.out) || 0),
    };

    const total = safe.single + safe.double + safe.triple + safe.homer + safe.walk + safe.out;
    if (total <= 0) {
      return {
        single: 0.155,
        double: 0.045,
        triple: 0.004,
        homer: 0.028,
        walk: 0.082,
        out: 0.686,
      };
    }

    return {
      single: safe.single / total,
      double: safe.double / total,
      triple: safe.triple / total,
      homer: safe.homer / total,
      walk: safe.walk / total,
      out: safe.out / total,
    };
  }

  function buildBaseLineupEventProfile(teamRow, offenseRpg) {
    const battingAvg = clamp(Number(teamRow?.battingAvg) || 0.255, 0.19, 0.34);
    const hrPerGame = clamp(Number(teamRow?.hrPerGame) || 0.9, 0.2, 2.8);
    const paPerGame = 38;
    const homerRate = clamp(hrPerGame / paPerGame, 0.008, 0.09);
    const walkRate = clamp(0.075 + ((offenseRpg - leagueRunsPerGame) * 0.012), 0.045, 0.13);
    const totalHitRate = clamp((battingAvg * 0.78) + 0.06, homerRate + 0.06, 0.34);
    const nonHomerHitRate = Math.max(0.04, totalHitRate - homerRate);
    const doubleRate = clamp(nonHomerHitRate * 0.22, 0.015, 0.09);
    const tripleRate = clamp(nonHomerHitRate * 0.025, 0.001, 0.015);
    const singleRate = Math.max(0.02, nonHomerHitRate - doubleRate - tripleRate);
    const outRate = Math.max(0.2, 1 - (singleRate + doubleRate + tripleRate + homerRate + walkRate));

    return normalizeEventProbabilities({
      single: singleRate,
      double: doubleRate,
      triple: tripleRate,
      homer: homerRate,
      walk: walkRate,
      out: outRate,
    });
  }

  function buildLineupEventProfiles(lineup, teamRow, offenseRpg) {
    const base = buildBaseLineupEventProfile(teamRow, offenseRpg);
    const players = Array.isArray(lineup) ? lineup : [];
    const fallback = new Array(9).fill(null).map(() => base);

    if (players.length === 0) {
      return fallback;
    }

    return fallback.map((_, index) => {
      const player = players[index] || null;
      const war = toFiniteNumber(player?.war);
      const ops = toFiniteNumber(player?.ops);
      const obp = toFiniteNumber(player?.obp);
      const slg = toFiniteNumber(player?.slg);
      const warFactor = Number.isFinite(war)
        ? clamp(1 + (war * 0.035), 0.72, 1.28)
        : 1;
      const opsFactor = Number.isFinite(ops)
        ? clamp(0.88 + ((ops - 0.72) * 1.15), 0.72, 1.45)
        : 1;
      const obpFactor = Number.isFinite(obp)
        ? clamp(0.86 + ((obp - 0.33) * 1.35), 0.72, 1.5)
        : 1;
      const slgFactor = Number.isFinite(slg)
        ? clamp(0.86 + ((slg - 0.40) * 1.15), 0.7, 1.55)
        : 1;

      const contactFactor = clamp((warFactor * 0.35) + (opsFactor * 0.65), 0.68, 1.38);
      const walkFactor = clamp((warFactor * 0.2) + (obpFactor * 0.8), 0.62, 1.5);
      const homerFactor = clamp((warFactor * 0.25) + (slgFactor * 0.75), 0.64, 1.58);
      const outFactor = clamp((contactFactor + walkFactor + homerFactor) / 3, 0.75, 1.35);

      const adjusted = normalizeEventProbabilities({
        single: base.single * contactFactor,
        double: base.double * contactFactor,
        triple: base.triple * contactFactor,
        homer: base.homer * homerFactor,
        walk: base.walk * walkFactor,
        out: base.out / outFactor,
      });

      return adjusted;
    });
  }

  function advanceBasesOnEvent(basesMask, eventName) {
    const onFirst = (basesMask & 1) > 0;
    const onSecond = (basesMask & 2) > 0;
    const onThird = (basesMask & 4) > 0;

    if (eventName === "walk") {
      const forcedRun = onFirst && onSecond && onThird ? 1 : 0;
      const nextThird = onThird || (onSecond && onFirst);
      const nextSecond = onSecond || onFirst;
      const nextFirst = true;
      const nextMask = (nextFirst ? 1 : 0) + (nextSecond ? 2 : 0) + (nextThird ? 4 : 0);
      return { nextMask, runs: forcedRun, isOut: false };
    }

    if (eventName === "single") {
      const runs = onThird ? 1 : 0;
      const nextMask = 1 + (onFirst ? 2 : 0) + (onSecond ? 4 : 0);
      return { nextMask, runs, isOut: false };
    }

    if (eventName === "double") {
      const runs = (onThird ? 1 : 0) + (onSecond ? 1 : 0);
      const nextMask = 2 + (onFirst ? 4 : 0);
      return { nextMask, runs, isOut: false };
    }

    if (eventName === "triple") {
      const runs = (onFirst ? 1 : 0) + (onSecond ? 1 : 0) + (onThird ? 1 : 0);
      return { nextMask: 4, runs, isOut: false };
    }

    if (eventName === "homer") {
      const runs = 1 + (onFirst ? 1 : 0) + (onSecond ? 1 : 0) + (onThird ? 1 : 0);
      return { nextMask: 0, runs, isOut: false };
    }

    return { nextMask: basesMask, runs: 0, isOut: true };
  }

  function runMarkovHalfInning(startBatterIndex, lineupProfiles) {
    const initialKey = `0:0:${startBatterIndex}`;
    let states = new Map([[initialKey, 1]]);
    const inningEndDistribution = new Array(9).fill(0);
    let expectedRuns = 0;

    for (let plateAppearance = 0; plateAppearance < 80; plateAppearance += 1) {
      let totalMass = 0;
      states.forEach((mass) => {
        totalMass += mass;
      });

      if (totalMass < 1e-9) {
        break;
      }

      const nextStates = new Map();

      states.forEach((stateProb, key) => {
        const [outsText, basesText, batterText] = key.split(":");
        const outs = Number(outsText);
        const bases = Number(basesText);
        const batterIndex = Number(batterText);
        const nextBatterIndex = (batterIndex + 1) % 9;
        const batterProfile = lineupProfiles[batterIndex] || lineupProfiles[0];
        const events = [
          ["single", batterProfile.single],
          ["double", batterProfile.double],
          ["triple", batterProfile.triple],
          ["homer", batterProfile.homer],
          ["walk", batterProfile.walk],
          ["out", batterProfile.out],
        ];

        for (const [eventName, eventProb] of events) {
          if (eventProb <= 0) {
            continue;
          }

          const branchProb = stateProb * eventProb;
          const branch = advanceBasesOnEvent(bases, eventName);
          expectedRuns += branchProb * branch.runs;

          if (branch.isOut) {
            const nextOuts = outs + 1;
            if (nextOuts >= 3) {
              inningEndDistribution[nextBatterIndex] += branchProb;
            } else {
              const nextKey = `${nextOuts}:${bases}:${nextBatterIndex}`;
              nextStates.set(nextKey, (nextStates.get(nextKey) || 0) + branchProb);
            }
          } else {
            const nextKey = `${outs}:${branch.nextMask}:${nextBatterIndex}`;
            nextStates.set(nextKey, (nextStates.get(nextKey) || 0) + branchProb);
          }
        }
      });

      states = nextStates;
    }

    states.forEach((mass, key) => {
      const batterIndex = Number(key.split(":")[2]);
      inningEndDistribution[batterIndex] += mass;
    });

    const endMass = inningEndDistribution.reduce((sum, value) => sum + value, 0);
    if (endMass > 0) {
      for (let i = 0; i < inningEndDistribution.length; i += 1) {
        inningEndDistribution[i] /= endMass;
      }
    } else {
      inningEndDistribution[startBatterIndex] = 1;
    }

    return {
      expectedRuns,
      inningEndDistribution,
    };
  }

  function computeMarkovGameExpectedRuns(lineupProfiles, innings = SABER_MARKOV_INNINGS) {
    let startBatterDistribution = new Array(9).fill(0);
    startBatterDistribution[0] = 1;
    let totalExpectedRuns = 0;

    for (let inning = 0; inning < innings; inning += 1) {
      const nextStartDistribution = new Array(9).fill(0);

      for (let batterIndex = 0; batterIndex < 9; batterIndex += 1) {
        const startProb = startBatterDistribution[batterIndex];
        if (startProb <= 0) {
          continue;
        }

        const half = runMarkovHalfInning(batterIndex, lineupProfiles);
        totalExpectedRuns += startProb * half.expectedRuns;

        for (let nextIndex = 0; nextIndex < 9; nextIndex += 1) {
          nextStartDistribution[nextIndex] += startProb * half.inningEndDistribution[nextIndex];
        }
      }

      const norm = nextStartDistribution.reduce((sum, value) => sum + value, 0);
      startBatterDistribution = norm > 0
        ? nextStartDistribution.map((value) => value / norm)
        : (() => {
            const fallback = new Array(9).fill(0);
            fallback[0] = 1;
            return fallback;
          })();
    }

    return totalExpectedRuns;
  }

  function createSeededRng(seedText) {
    let seed = 2166136261;
    const text = String(seedText || "kbo");

    for (let i = 0; i < text.length; i += 1) {
      seed ^= text.charCodeAt(i);
      seed = Math.imul(seed, 16777619) >>> 0;
    }

    return () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function sampleEventFromProfile(profile, rng) {
    const events = [
      ["single", profile.single],
      ["double", profile.double],
      ["triple", profile.triple],
      ["homer", profile.homer],
      ["walk", profile.walk],
      ["out", profile.out],
    ];

    const target = rng();
    let cumulative = 0;

    for (const [eventName, eventProb] of events) {
      cumulative += eventProb;
      if (target <= cumulative) {
        return eventName;
      }
    }

    return "out";
  }

  function simulateHalfInning(lineupProfiles, startBatterIndex, rng) {
    let outs = 0;
    let runs = 0;
    let bases = 0;
    let batterIndex = startBatterIndex;
    let safety = 0;

    while (outs < 3 && safety < 30) {
      const profile = lineupProfiles[batterIndex] || lineupProfiles[0];
      const eventName = sampleEventFromProfile(profile, rng);
      const branch = advanceBasesOnEvent(bases, eventName);

      runs += branch.runs;
      if (branch.isOut) {
        outs += 1;
      } else {
        bases = branch.nextMask;
      }

      batterIndex = (batterIndex + 1) % 9;
      safety += 1;
    }

    return {
      runs,
      nextBatterIndex: batterIndex,
    };
  }

  function simulateTeamRuns(lineupProfiles, innings, rng) {
    let totalRuns = 0;
    let batterIndex = 0;

    for (let inning = 0; inning < innings; inning += 1) {
      const half = simulateHalfInning(lineupProfiles, batterIndex, rng);
      totalRuns += half.runs;
      batterIndex = half.nextBatterIndex;
    }

    return totalRuns;
  }

  function simulateGameRunsMonteCarlo({ awayProfiles, homeProfiles, seedKey }) {
    const rng = createSeededRng(seedKey);
    let awayTotalRuns = 0;
    let homeTotalRuns = 0;
    let awayScoreAtLeastOneCount = 0;
    let homeScoreAtLeastOneCount = 0;
    let totalOver85Count = 0;

    for (let i = 0; i < SABER_MONTE_CARLO_ITERATIONS; i += 1) {
      const awayRuns = simulateTeamRuns(awayProfiles, SABER_MONTE_CARLO_INNINGS, rng);
      const homeRuns = simulateTeamRuns(homeProfiles, SABER_MONTE_CARLO_INNINGS, rng);

      awayTotalRuns += awayRuns;
      homeTotalRuns += homeRuns;
      if (awayRuns >= 1) {
        awayScoreAtLeastOneCount += 1;
      }
      if (homeRuns >= 1) {
        homeScoreAtLeastOneCount += 1;
      }
      if ((awayRuns + homeRuns) >= 9) {
        totalOver85Count += 1;
      }
    }

    return {
      awayAverageRuns: awayTotalRuns / SABER_MONTE_CARLO_ITERATIONS,
      homeAverageRuns: homeTotalRuns / SABER_MONTE_CARLO_ITERATIONS,
      awayScoreAtLeastOneProb: awayScoreAtLeastOneCount / SABER_MONTE_CARLO_ITERATIONS,
      homeScoreAtLeastOneProb: homeScoreAtLeastOneCount / SABER_MONTE_CARLO_ITERATIONS,
      totalOver85Prob: totalOver85Count / SABER_MONTE_CARLO_ITERATIONS,
    };
  }

  return predictions.map((prediction) => {
    const {
      awayStarterProfile,
      homeStarterProfile,
      ...predictionBase
    } = prediction;
    const awayTeamRow = teamMap.get(prediction.awayTeam);
    const homeTeamRow = teamMap.get(prediction.homeTeam);

    if (!awayTeamRow || !homeTeamRow) {
      return prediction;
    }

    const awayRates = getTeamRunsPerGame(awayTeamRow);
    const homeRates = getTeamRunsPerGame(homeTeamRow);

    const heuristicHomeWinProbability = prediction.homeWinProbability;
    const heuristicAwayWinProbability = prediction.awayWinProbability;

    const starterEraRawDiff =
      (Number.isFinite(prediction.homeStarterEra) ? prediction.homeStarterEra : leagueRunsPerGame)
      - (Number.isFinite(prediction.awayStarterEra) ? prediction.awayStarterEra : leagueRunsPerGame);
    const awayStarterProfileData = awayStarterProfile || null;
    const homeStarterProfileData = homeStarterProfile || null;
    const starterEraReliability = getStarterMetricReliability(prediction, awayStarterProfileData, homeStarterProfileData);
    const starterEraDiff = starterEraRawDiff * starterEraReliability;
    const offenseDiff = homeRates.offenseRpg - awayRates.offenseRpg;
    const defenseDiff = awayRates.defenseRpg - homeRates.defenseRpg;
    const battingAvgDiff = homeTeamRow.battingAvg - awayTeamRow.battingAvg;
    const hrPerGameDiff = homeTeamRow.hrPerGame - awayTeamRow.hrPerGame;
    const {
      runCreationResidualDiff,
      powerContactMixDiff,
    } = buildReconstructedMlBattingFeatures({
      offenseDiff,
      battingAvgDiff,
      hrPerGameDiff,
    });
    const whipDiff = awayTeamRow.teamWhip - homeTeamRow.teamWhip;
    const bullpenDiff =
      (homeTeamRow.bullpenUsagePerGame - awayTeamRow.bullpenUsagePerGame)
      + ((homeTeamRow.kbbRatio - awayTeamRow.kbbRatio) * 0.25);

    const awayHitsPer9 = toFiniteNumber(awayStarterProfileData?.hitsPer9);
    const homeHitsPer9 = toFiniteNumber(homeStarterProfileData?.hitsPer9);
    const awayHrPer9 = toFiniteNumber(awayStarterProfileData?.hrPer9);
    const homeHrPer9 = toFiniteNumber(homeStarterProfileData?.hrPer9);
    const awayFreePassPer9 = toFiniteNumber(awayStarterProfileData?.freePassPer9);
    const homeFreePassPer9 = toFiniteNumber(homeStarterProfileData?.freePassPer9);
    const awaySoPer9 = toFiniteNumber(awayStarterProfileData?.soPer9);
    const homeSoPer9 = toFiniteNumber(homeStarterProfileData?.soPer9);
    const awayRunsPer9 = toFiniteNumber(awayStarterProfileData?.runsPer9);
    const homeRunsPer9 = toFiniteNumber(homeStarterProfileData?.runsPer9);

    const starterHitsPer9RawDiff = Number.isFinite(awayHitsPer9) && Number.isFinite(homeHitsPer9)
      ? awayHitsPer9 - homeHitsPer9
      : 0;
    const starterHrPer9RawDiff = Number.isFinite(awayHrPer9) && Number.isFinite(homeHrPer9)
      ? awayHrPer9 - homeHrPer9
      : 0;
    const starterFreePassPer9RawDiff = Number.isFinite(awayFreePassPer9) && Number.isFinite(homeFreePassPer9)
      ? awayFreePassPer9 - homeFreePassPer9
      : 0;
    const starterSoPer9RawDiff = Number.isFinite(awaySoPer9) && Number.isFinite(homeSoPer9)
      ? homeSoPer9 - awaySoPer9
      : 0;
    const starterRunsPer9RawDiff = Number.isFinite(awayRunsPer9) && Number.isFinite(homeRunsPer9)
      ? awayRunsPer9 - homeRunsPer9
      : 0;

    const starterHitsPer9Diff = starterHitsPer9RawDiff * starterEraReliability;
    const starterHrPer9Diff = starterHrPer9RawDiff * starterEraReliability;
    const starterFreePassPer9Diff = starterFreePassPer9RawDiff * starterEraReliability;
    const starterSoPer9Diff = starterSoPer9RawDiff * starterEraReliability;
    const starterRunsPer9Diff = starterRunsPer9RawDiff * starterEraReliability;
    const lineupSignal = prediction.lineupConfirmed ? 1 : 0;

    const awayLineupWar = getLineupWarSummary(prediction.awayLineup);
    const homeLineupWar = getLineupWarSummary(prediction.homeLineup);
    const awayLineupOps = getLineupRateSummary(prediction.awayLineup, "ops");
    const homeLineupOps = getLineupRateSummary(prediction.homeLineup, "ops");
    const awayLineupObp = getLineupRateSummary(prediction.awayLineup, "obp");
    const homeLineupObp = getLineupRateSummary(prediction.homeLineup, "obp");
    const awayLineupSlg = getLineupRateSummary(prediction.awayLineup, "slg");
    const homeLineupSlg = getLineupRateSummary(prediction.homeLineup, "slg");
    const lineupWarRawDiff =
      Number.isFinite(homeLineupWar.average) && Number.isFinite(awayLineupWar.average)
        ? homeLineupWar.average - awayLineupWar.average
        : 0;
    const lineupWarReliability = lineupSignal === 1
      ? Math.min(
        clamp(awayLineupWar.count / 9, 0, 1),
        clamp(homeLineupWar.count / 9, 0, 1),
      )
      : 0;
    const lineupWarDiff = lineupWarRawDiff * lineupWarReliability;
    const hasCompleteLineup = prediction.lineupDataReady
      && Array.isArray(prediction.awayLineup)
      && Array.isArray(prediction.homeLineup)
      && prediction.awayLineup.length >= 9
      && prediction.homeLineup.length >= 9;
    const useSaberHybrid = league === "kbo" && lineupSignal === 1 && hasCompleteLineup;

    const featureValues = {
      offenseDiff,
      defenseDiff,
      starterEraDiff,
      runCreationResidualDiff,
      powerContactMixDiff,
      starterHitsPer9Diff,
      starterHrPer9Diff,
      starterFreePassPer9Diff,
      starterSoPer9Diff,
      starterRunsPer9Diff,
      battingAvgDiff,
      hrPerGameDiff,
      whipDiff,
      bullpenDiff,
      homeAdvantage,
      lineupSignal,
      lineupWarDiff,
    };

    const lineupWarLinearAdj = lineupSignal === 1
      ? featureValues.lineupWarDiff * LINEUP_WAR_OFFENSE_COEFF
      : 0;
    const useReconstructedMlFeatures = Number.isFinite(model.runCreationResidualDiff)
      && Number.isFinite(model.powerContactMixDiff);

    const mlLinear =
      model.intercept
      + (featureValues.offenseDiff * model.offenseDiff)
      + (featureValues.defenseDiff * model.defenseDiff)
      + (featureValues.starterEraDiff * model.starterEraDiff)
      + (useReconstructedMlFeatures
        ? (featureValues.runCreationResidualDiff * model.runCreationResidualDiff)
          + (featureValues.powerContactMixDiff * model.powerContactMixDiff)
        : (featureValues.battingAvgDiff * (Number(model.battingAvgDiff) || 0))
          + (featureValues.hrPerGameDiff * (Number(model.hrPerGameDiff) || 0)))
      + (featureValues.starterHitsPer9Diff * (Number(model.starterHitsPer9Diff) || 0))
      + (featureValues.starterHrPer9Diff * (Number(model.starterHrPer9Diff) || 0))
      + (featureValues.starterFreePassPer9Diff * (Number(model.starterFreePassPer9Diff) || 0))
      + (featureValues.starterSoPer9Diff * (Number(model.starterSoPer9Diff) || 0))
      + (featureValues.starterRunsPer9Diff * (Number(model.starterRunsPer9Diff) || 0))
      + (featureValues.whipDiff * model.whipDiff)
      + (featureValues.bullpenDiff * model.bullpenDiff)
      + (featureValues.homeAdvantage * model.homeAdvantage)
      + (featureValues.lineupSignal * model.lineupSignal)
      + lineupWarLinearAdj;
    const calibratedMlProb = applyPlattCalibration(mlLinear, model);
    const mlHomeWinProbability = clamp(calibratedMlProb, 0.005, 0.995);
    const mlAwayWinProbability = 1 - mlHomeWinProbability;

    const blendWeight = prediction.lineupConfirmed ? model.blendWeightPost : model.blendWeightPre;
    const blendedHomeWinProbability =
      (heuristicHomeWinProbability * (1 - blendWeight)) + (mlHomeWinProbability * blendWeight);

    let decisionHomeWinProbability = mlHomeWinProbability;
    if (!prediction.lineupConfirmed) {
      const preLineupMix = 0.7;
      const sampleCount = Number.isFinite(model.samples) ? model.samples : null;
      const dataReliability = sampleCount === null ? 1 : clamp(sampleCount / 40, 0.35, 1);
      const effectivePreLineupShrink = clamp(model.preLineupShrink * dataReliability, 0.2, 0.85);
      decisionHomeWinProbability =
        (mlHomeWinProbability * preLineupMix)
        + (blendedHomeWinProbability * (1 - preLineupMix));
      decisionHomeWinProbability =
        0.5 + (decisionHomeWinProbability - 0.5) * effectivePreLineupShrink;
    }
    const finalHomeWinProbability = clamp(decisionHomeWinProbability, 0.05, 0.95);
    const finalAwayWinProbability = 1 - finalHomeWinProbability;

    let expectedAwayRuns = (awayRates.offenseRpg + homeRates.defenseRpg) / 2;
    let expectedHomeRuns = (homeRates.offenseRpg + awayRates.defenseRpg) / 2;

    expectedAwayRuns += getStarterRunImpact(prediction.homeStarterEra, prediction.homeStarterGames);
    expectedHomeRuns += getStarterRunImpact(prediction.awayStarterEra, prediction.awayStarterGames);
    expectedHomeRuns += homeFieldRunBonus;

    const teamOnlyAwayRuns = expectedAwayRuns;
    const teamOnlyHomeRuns = expectedHomeRuns;
    const lineupRunAdj = lineupSignal === 1 && Number.isFinite(lineupWarDiff)
      ? lineupWarDiff * LINEUP_WAR_RUN_IMPACT_COEFF
      : 0;
    const lineupAdjustedAwayRuns = teamOnlyAwayRuns - lineupRunAdj;
    const lineupAdjustedHomeRuns = teamOnlyHomeRuns + lineupRunAdj;
    const lineupBlendWeight = prediction.lineupConfirmed
      ? LINEUP_BLEND_WEIGHT_POST
      : LINEUP_BLEND_WEIGHT_PRE;

    expectedAwayRuns = (teamOnlyAwayRuns * (1 - lineupBlendWeight)) + (lineupAdjustedAwayRuns * lineupBlendWeight);
    expectedHomeRuns = (teamOnlyHomeRuns * (1 - lineupBlendWeight)) + (lineupAdjustedHomeRuns * lineupBlendWeight);

    if (!prediction.lineupConfirmed) {
      const runShrink = 0.45;
      expectedAwayRuns = leagueRunsPerGame + ((expectedAwayRuns - leagueRunsPerGame) * runShrink);
      expectedHomeRuns = leagueRunsPerGame + ((expectedHomeRuns - leagueRunsPerGame) * runShrink);
    }

    expectedAwayRuns = clamp(expectedAwayRuns, 1.2, 10.5);
    expectedHomeRuns = clamp(expectedHomeRuns, 1.2, 10.5);

    let markovAwayRuns = null;
    let markovHomeRuns = null;
    let monteCarloAwayRuns = null;
    let monteCarloHomeRuns = null;
    let awayScoreAtLeastOneProb = null;
    let homeScoreAtLeastOneProb = null;
    let monteCarloTotalOver85Prob = null;
    let saberExpectedAwayRuns = null;
    let saberExpectedHomeRuns = null;

    if (useSaberHybrid) {
      const awayProfiles = buildLineupEventProfiles(prediction.awayLineup, awayTeamRow, awayRates.offenseRpg);
      const homeProfiles = buildLineupEventProfiles(prediction.homeLineup, homeTeamRow, homeRates.offenseRpg);

      markovAwayRuns = computeMarkovGameExpectedRuns(awayProfiles);
      markovHomeRuns = computeMarkovGameExpectedRuns(homeProfiles);

      const monteCarlo = simulateGameRunsMonteCarlo({
        awayProfiles,
        homeProfiles,
        seedKey: `${prediction.gameId || prediction.gameTime || "game"}:${prediction.gameDate || "date"}:${prediction.awayTeam}:${prediction.homeTeam}`,
      });

      monteCarloAwayRuns = monteCarlo.awayAverageRuns;
      monteCarloHomeRuns = monteCarlo.homeAverageRuns;
      awayScoreAtLeastOneProb = monteCarlo.awayScoreAtLeastOneProb;
      homeScoreAtLeastOneProb = monteCarlo.homeScoreAtLeastOneProb;
      monteCarloTotalOver85Prob = monteCarlo.totalOver85Prob;

      const awayMarkovDiff = Math.abs(markovAwayRuns - expectedAwayRuns);
      const awayMonteDiff = Math.abs(monteCarloAwayRuns - expectedAwayRuns);
      const homeMarkovDiff = Math.abs(markovHomeRuns - expectedHomeRuns);
      const homeMonteDiff = Math.abs(monteCarloHomeRuns - expectedHomeRuns);
      const awayMarkovTrusted = awayMarkovDiff <= SABER_CLAMP_THRESHOLD;
      const awayMonteTrusted = awayMonteDiff <= SABER_CLAMP_THRESHOLD;
      const homeMarkovTrusted = homeMarkovDiff <= SABER_CLAMP_THRESHOLD;
      const homeMonteTrusted = homeMonteDiff <= SABER_CLAMP_THRESHOLD;

      saberExpectedAwayRuns = clamp(
        (expectedAwayRuns * SABER_BLEND_BASE_WEIGHT)
          + ((awayMarkovTrusted ? markovAwayRuns : expectedAwayRuns) * SABER_BLEND_MARKOV_WEIGHT)
          + ((awayMonteTrusted ? monteCarloAwayRuns : expectedAwayRuns) * SABER_BLEND_MONTE_WEIGHT),
        1.2,
        10.5,
      );
      saberExpectedHomeRuns = clamp(
        (expectedHomeRuns * SABER_BLEND_BASE_WEIGHT)
          + ((homeMarkovTrusted ? markovHomeRuns : expectedHomeRuns) * SABER_BLEND_MARKOV_WEIGHT)
          + ((homeMonteTrusted ? monteCarloHomeRuns : expectedHomeRuns) * SABER_BLEND_MONTE_WEIGHT),
        1.2,
        10.5,
      );

      expectedAwayRuns = saberExpectedAwayRuns;
      expectedHomeRuns = saberExpectedHomeRuns;
    }

    const roundedAwayRuns = roundToOne(expectedAwayRuns);
    const roundedHomeRuns = roundToOne(expectedHomeRuns);
    const targetRunDiff = getTargetRunDiff(
      finalHomeWinProbability,
      finalAwayWinProbability,
      prediction.lineupConfirmed,
    );

    const awayEdge = finalAwayWinProbability - finalHomeWinProbability;
    const predictedWinner = awayEdge > AWAY_WIN_DECISION_EDGE_MIN
      ? prediction.awayTeam
      : prediction.homeTeam;

    const likelyScore = pickLikelyScoreByWinner({
      awayLambda: expectedAwayRuns,
      homeLambda: expectedHomeRuns,
      predictedWinner,
      homeTeam: prediction.homeTeam,
      awayTeam: prediction.awayTeam,
      targetRunDiff,
      lineupConfirmed: prediction.lineupConfirmed,
    });

    let predictedAwayScore = likelyScore.awayScore;
    let predictedHomeScore = likelyScore.homeScore;

    const scoreDiff = Math.abs(predictedHomeScore - predictedAwayScore);
    const winProbGap = Math.abs(finalHomeWinProbability - finalAwayWinProbability);
    const maxSideWinProbability = Math.max(finalHomeWinProbability, finalAwayWinProbability);
    const expectedTotalRuns = expectedAwayRuns + expectedHomeRuns;
    const edgeBand = winProbGap < BETTING_AVOID_EDGE_MAX
      ? "coinflip"
      : winProbGap < BETTING_RECOMMEND_EDGE_MIN
        ? "moderate_edge"
        : "strong_edge";
    const totalBand = expectedTotalRuns <= BETTING_AVOID_TOTAL_MAX
      ? "low_total"
      : expectedTotalRuns >= BETTING_RECOMMEND_TOTAL_MIN
        ? "high_total"
        : "mid_total";

    let bettingTag = "주의";
    let bettingReason = "중간 엣지 구간, 보수 접근 권장";

    if (edgeBand === "coinflip" || totalBand === "low_total") {
      bettingTag = "회피";
      bettingReason = edgeBand === "coinflip"
        ? "승률 격차가 작아 방향성 불명확"
        : "저득점 구간 변동성 높아 회피 권장";
    } else if (edgeBand === "strong_edge" && totalBand !== "low_total") {
      if (!prediction.lineupConfirmed) {
        bettingTag = "주의";
        bettingReason = "강한 엣지지만 라인업 확정 전이라 변동성 주의";
      } else if (!useSaberHybrid) {
        bettingTag = "주의";
        bettingReason = "라인업 확정은 됐지만 세이버 보정 미적용";
      } else if (totalBand !== "high_total") {
        bettingTag = "주의";
        bettingReason = "강한 엣지지만 득점밴드 불확실로 보수 접근";
      } else if (maxSideWinProbability >= 0.9) {
        bettingTag = "주의";
        bettingReason = "확률 과신 구간(90%+)으로 역배 변동성 주의";
      } else {
        bettingTag = "추천";
        bettingReason = "강한 승률 엣지 + 저득점 리스크 낮음";
      }
    }

    const predictionHit = prediction.actualWinner
      ? predictedWinner === prediction.actualWinner
      : null;
    const confidenceLevel = prediction.lineupConfirmed ? "lineup_confirmed" : "pre_lineup";
    const note = typeof prediction.lineupStatusText === "string" && prediction.lineupStatusText.trim()
      ? prediction.lineupStatusText.trim()
      : prediction.lineupConfirmed
        ? "금일 라인업 기준입니다."
        : "라인업 발표 전으로 최근 라인업 기준입니다.";
    const featureContributions = buildFeatureContributions(featureValues, model);

    return {
      ...predictionBase,
      modelVersion: model.version,
      mode: prediction.lineupConfirmed ? "post_lineup" : "pre_lineup",
      decisionBasis: "ml_centered",
      heuristicHomeWinProbability: Number(heuristicHomeWinProbability.toFixed(3)),
      heuristicAwayWinProbability: Number(heuristicAwayWinProbability.toFixed(3)),
      blendedHomeWinProbability: Number(blendedHomeWinProbability.toFixed(3)),
      blendedAwayWinProbability: Number((1 - blendedHomeWinProbability).toFixed(3)),
      mlHomeWinProbability: Number(mlHomeWinProbability.toFixed(3)),
      mlAwayWinProbability: Number(mlAwayWinProbability.toFixed(3)),
      homeWinProbability: Number(finalHomeWinProbability.toFixed(3)),
      awayWinProbability: Number(finalAwayWinProbability.toFixed(3)),
      predictedWinner,
      expectedAwayRuns: roundedAwayRuns,
      expectedHomeRuns: roundedHomeRuns,
      predictedAwayScore,
      predictedHomeScore,
      predictedRunDiff: scoreDiff,
      bettingTag,
      bettingReason,
      actualAwayScore: prediction.actualAwayScore,
      actualHomeScore: prediction.actualHomeScore,
      actualWinner: prediction.actualWinner,
      predictionHit,
      confidenceLevel,
      predictionNote: note,
      featureContributions,
      topContributors: featureContributions.slice(0, 3),
      modelFeatures: {
        awayOffenseRpg: roundToOne(awayRates.offenseRpg),
        awayDefenseRpg: roundToOne(awayRates.defenseRpg),
        homeOffenseRpg: roundToOne(homeRates.offenseRpg),
        homeDefenseRpg: roundToOne(homeRates.defenseRpg),
        offenseDiff: roundToOne(offenseDiff),
        defenseDiff: roundToOne(defenseDiff),
        starterEraDiff: roundToOne(starterEraDiff),
        starterEraRawDiff: roundToOne(starterEraRawDiff),
        starterEraReliability: roundToThree(starterEraReliability),
        lineupWarRawDiff: roundToThree(lineupWarRawDiff),
        lineupWarReliability: roundToThree(lineupWarReliability),
        lineupWarDiff: roundToThree(lineupWarDiff),
        lineupBlendWeight: roundToThree(lineupBlendWeight),
        teamOnlyAwayRuns: roundToThree(teamOnlyAwayRuns),
        teamOnlyHomeRuns: roundToThree(teamOnlyHomeRuns),
        lineupAdjustedAwayRuns: roundToThree(lineupAdjustedAwayRuns),
        lineupAdjustedHomeRuns: roundToThree(lineupAdjustedHomeRuns),
        awayLineupWarAvg: Number.isFinite(awayLineupWar.average) ? roundToThree(awayLineupWar.average) : null,
        homeLineupWarAvg: Number.isFinite(homeLineupWar.average) ? roundToThree(homeLineupWar.average) : null,
        awayLineupWarCount: awayLineupWar.count,
        homeLineupWarCount: homeLineupWar.count,
        awayLineupOpsAvg: Number.isFinite(awayLineupOps.average) ? roundToThree(awayLineupOps.average) : null,
        homeLineupOpsAvg: Number.isFinite(homeLineupOps.average) ? roundToThree(homeLineupOps.average) : null,
        awayLineupObpAvg: Number.isFinite(awayLineupObp.average) ? roundToThree(awayLineupObp.average) : null,
        homeLineupObpAvg: Number.isFinite(homeLineupObp.average) ? roundToThree(homeLineupObp.average) : null,
        awayLineupSlgAvg: Number.isFinite(awayLineupSlg.average) ? roundToThree(awayLineupSlg.average) : null,
        homeLineupSlgAvg: Number.isFinite(homeLineupSlg.average) ? roundToThree(homeLineupSlg.average) : null,
        awayLineupOpsCount: awayLineupOps.count,
        homeLineupOpsCount: homeLineupOps.count,
        awayLineupObpCount: awayLineupObp.count,
        homeLineupObpCount: homeLineupObp.count,
        awayLineupSlgCount: awayLineupSlg.count,
        homeLineupSlgCount: homeLineupSlg.count,
        awayLineupHitterMetricsMatchedCount: Number(prediction.lineupHitterMetricsCoverage?.awayMatchedCount) || 0,
        homeLineupHitterMetricsMatchedCount: Number(prediction.lineupHitterMetricsCoverage?.homeMatchedCount) || 0,
        awayLineupHitterMetricsSourceCount: Number(prediction.lineupHitterMetricsCoverage?.awaySourceCount) || 0,
        homeLineupHitterMetricsSourceCount: Number(prediction.lineupHitterMetricsCoverage?.homeSourceCount) || 0,
        runCreationResidualDiff: roundToThree(runCreationResidualDiff),
        powerContactMixDiff: roundToThree(powerContactMixDiff),
        starterHitsPer9Diff: roundToThree(starterHitsPer9Diff),
        starterHrPer9Diff: roundToThree(starterHrPer9Diff),
        starterFreePassPer9Diff: roundToThree(starterFreePassPer9Diff),
        starterSoPer9Diff: roundToThree(starterSoPer9Diff),
        starterRunsPer9Diff: roundToThree(starterRunsPer9Diff),
        battingAvgDiff: roundToOne(battingAvgDiff),
        hrPerGameDiff: roundToOne(hrPerGameDiff),
        whipDiff: roundToOne(whipDiff),
        bullpenDiff: roundToOne(bullpenDiff),
        awayBattingAvg: awayTeamRow.battingAvg,
        homeBattingAvg: homeTeamRow.battingAvg,
        awayHrPerGame: roundToOne(awayTeamRow.hrPerGame),
        homeHrPerGame: roundToOne(homeTeamRow.hrPerGame),
        awayTeamWhip: awayTeamRow.teamWhip,
        homeTeamWhip: homeTeamRow.teamWhip,
        awayBullpenUsagePerGame: roundToOne(awayTeamRow.bullpenUsagePerGame),
        homeBullpenUsagePerGame: roundToOne(homeTeamRow.bullpenUsagePerGame),
        awayKbbRatio: roundToOne(awayTeamRow.kbbRatio),
        homeKbbRatio: roundToOne(homeTeamRow.kbbRatio),
        awayStarterEra: prediction.awayStarterEra,
        homeStarterEra: prediction.homeStarterEra,
        awayStarterWhip: Number.isFinite(prediction.awayStarterWhip)
          ? roundToThree(prediction.awayStarterWhip)
          : (Number.isFinite(awayStarterProfileData?.whip) ? roundToThree(awayStarterProfileData.whip) : null),
        homeStarterWhip: Number.isFinite(prediction.homeStarterWhip)
          ? roundToThree(prediction.homeStarterWhip)
          : (Number.isFinite(homeStarterProfileData?.whip) ? roundToThree(homeStarterProfileData.whip) : null),
        awayStarterHitsPer9: Number.isFinite(awayHitsPer9) ? roundToThree(awayHitsPer9) : null,
        homeStarterHitsPer9: Number.isFinite(homeHitsPer9) ? roundToThree(homeHitsPer9) : null,
        awayStarterHrPer9: Number.isFinite(awayHrPer9) ? roundToThree(awayHrPer9) : null,
        homeStarterHrPer9: Number.isFinite(homeHrPer9) ? roundToThree(homeHrPer9) : null,
        awayStarterBbPer9: Number.isFinite(toFiniteNumber(awayStarterProfileData?.bbPer9)) ? roundToThree(toFiniteNumber(awayStarterProfileData?.bbPer9)) : null,
        homeStarterBbPer9: Number.isFinite(toFiniteNumber(homeStarterProfileData?.bbPer9)) ? roundToThree(toFiniteNumber(homeStarterProfileData?.bbPer9)) : null,
        awayStarterHbpPer9: Number.isFinite(toFiniteNumber(awayStarterProfileData?.hbpPer9)) ? roundToThree(toFiniteNumber(awayStarterProfileData?.hbpPer9)) : null,
        homeStarterHbpPer9: Number.isFinite(toFiniteNumber(homeStarterProfileData?.hbpPer9)) ? roundToThree(toFiniteNumber(homeStarterProfileData?.hbpPer9)) : null,
        awayStarterSoPer9: Number.isFinite(awaySoPer9) ? roundToThree(awaySoPer9) : null,
        homeStarterSoPer9: Number.isFinite(homeSoPer9) ? roundToThree(homeSoPer9) : null,
        awayStarterRunsPer9: Number.isFinite(awayRunsPer9) ? roundToThree(awayRunsPer9) : null,
        homeStarterRunsPer9: Number.isFinite(homeRunsPer9) ? roundToThree(homeRunsPer9) : null,
        awayStarterHits: Number.isFinite(toFiniteNumber(awayStarterProfileData?.hits)) ? Number(awayStarterProfileData.hits) : null,
        homeStarterHits: Number.isFinite(toFiniteNumber(homeStarterProfileData?.hits)) ? Number(homeStarterProfileData.hits) : null,
        awayStarterHomeRunsAllowed: Number.isFinite(toFiniteNumber(awayStarterProfileData?.homeRuns)) ? Number(awayStarterProfileData.homeRuns) : null,
        homeStarterHomeRunsAllowed: Number.isFinite(toFiniteNumber(homeStarterProfileData?.homeRuns)) ? Number(homeStarterProfileData.homeRuns) : null,
        awayStarterWalks: Number.isFinite(toFiniteNumber(awayStarterProfileData?.walks)) ? Number(awayStarterProfileData.walks) : null,
        homeStarterWalks: Number.isFinite(toFiniteNumber(homeStarterProfileData?.walks)) ? Number(homeStarterProfileData.walks) : null,
        awayStarterHitByPitch: Number.isFinite(toFiniteNumber(awayStarterProfileData?.hitByPitch)) ? Number(awayStarterProfileData.hitByPitch) : null,
        homeStarterHitByPitch: Number.isFinite(toFiniteNumber(homeStarterProfileData?.hitByPitch)) ? Number(homeStarterProfileData.hitByPitch) : null,
        awayStarterStrikeouts: Number.isFinite(toFiniteNumber(awayStarterProfileData?.strikeouts)) ? Number(awayStarterProfileData.strikeouts) : null,
        homeStarterStrikeouts: Number.isFinite(toFiniteNumber(homeStarterProfileData?.strikeouts)) ? Number(homeStarterProfileData.strikeouts) : null,
        awayStarterRunsAllowed: Number.isFinite(toFiniteNumber(awayStarterProfileData?.runsAllowed)) ? Number(awayStarterProfileData.runsAllowed) : null,
        homeStarterRunsAllowed: Number.isFinite(toFiniteNumber(homeStarterProfileData?.runsAllowed)) ? Number(homeStarterProfileData.runsAllowed) : null,
        awayStarterProfileGames: Number.isFinite(toFiniteNumber(awayStarterProfileData?.games)) ? Number(awayStarterProfileData.games) : null,
        homeStarterProfileGames: Number.isFinite(toFiniteNumber(homeStarterProfileData?.games)) ? Number(homeStarterProfileData.games) : null,
        lineupConfirmed: prediction.lineupConfirmed,
        saberApplied: useSaberHybrid,
        winProbGap: roundToThree(winProbGap),
        expectedTotalRuns: roundToThree(expectedTotalRuns),
        edgeBand,
        totalBand,
        homeAdvantage,
        markovAwayRuns: Number.isFinite(markovAwayRuns) ? roundToThree(markovAwayRuns) : null,
        markovHomeRuns: Number.isFinite(markovHomeRuns) ? roundToThree(markovHomeRuns) : null,
        monteCarloAwayRuns: Number.isFinite(monteCarloAwayRuns) ? roundToThree(monteCarloAwayRuns) : null,
        monteCarloHomeRuns: Number.isFinite(monteCarloHomeRuns) ? roundToThree(monteCarloHomeRuns) : null,
        awayScoreAtLeastOneProb: Number.isFinite(awayScoreAtLeastOneProb) ? roundToThree(awayScoreAtLeastOneProb) : null,
        homeScoreAtLeastOneProb: Number.isFinite(homeScoreAtLeastOneProb) ? roundToThree(homeScoreAtLeastOneProb) : null,
        monteCarloTotalOver85Prob: Number.isFinite(monteCarloTotalOver85Prob)
          ? roundToThree(monteCarloTotalOver85Prob)
          : null,
        saberExpectedAwayRuns: Number.isFinite(saberExpectedAwayRuns) ? roundToThree(saberExpectedAwayRuns) : null,
        saberExpectedHomeRuns: Number.isFinite(saberExpectedHomeRuns) ? roundToThree(saberExpectedHomeRuns) : null,
      },
    };
  });
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/teams/pythagorean", async (req, res) => {
  const requestedLeague = String(req.query.league || "kbo").trim().toLowerCase();
  if (requestedLeague !== "kbo") {
    res.status(400).json({ error: "KBO-only service: league must be kbo." });
    return;
  }
  const league = "kbo";

  const rawExponent = req.query.exponent;
  const exponent =
    rawExponent === undefined ? DEFAULT_EXPONENT : toFiniteNumber(rawExponent);

  if (exponent === null || exponent < 0.1 || exponent > 10) {
    res.status(400).json({ error: "exponent must be between 0.1 and 10." });
    return;
  }

  const season = new Date().getFullYear();
  const cacheKey = `${league}:${season}:${exponent}`;
  const cached = cachedPayloadByKey.get(cacheKey);
  if (cached && now() - cached.cachedAt < CACHE_TTL_MS) {
    res.json(cached.payload);
    return;
  }

  try {
    const rows = await loadTeamRowsByLeague(league, exponent);

    const payload = {
      league,
      source: {
        hitter: KBO_HITTER_URL,
        pitcher: KBO_PITCHER_URL,
      },
      season,
      exponent,
      teamCount: rows.length,
      updatedAt: new Date().toISOString(),
      rows,
    };

    cachedPayloadByKey.set(cacheKey, {
      payload,
      cachedAt: now(),
    });
    res.json(payload);
  } catch (error) {
    console.error(`Failed to load ${league.toUpperCase()} records`, error);
    const isFormatError = league === "kbo" && error.message.includes("Upstream KBO format changed");
    const statusCode = isFormatError ? 502 : 500;
    res.status(statusCode).json({ error: `Failed to load ${league.toUpperCase()} records.` });
  }
});

app.get("/api/predictions/gameday", async (req, res) => {
  const requestedLeague = String(req.query.league || "kbo").trim().toLowerCase();
  if (requestedLeague !== "kbo") {
    res.status(400).json({ error: "KBO-only service: league must be kbo." });
    return;
  }
  const league = "kbo";

  const asOfTimestamp = new Date().toISOString();
  const date =
    typeof req.query.date === "string" && /^\d{8}$/.test(req.query.date)
      ? req.query.date
      : formatDateYYYYMMDDInTimeZone(new Date(), "Asia/Seoul");
  const rawHomeAdvantage = req.query.homeAdvantage;
  const homeAdvantage =
    rawHomeAdvantage === undefined ? 0.03 : toFiniteNumber(rawHomeAdvantage);
  const includeFinished = String(req.query.includeFinished || "false") === "true";

  if (homeAdvantage === null || homeAdvantage < -0.2 || homeAdvantage > 0.2) {
    res.status(400).json({ error: "homeAdvantage must be between -0.2 and 0.2." });
    return;
  }

  try {
    const season = Number(date.slice(0, 4)) || new Date().getFullYear();
    const teamRows = await loadTeamRowsByLeague(league, DEFAULT_EXPONENT);
    const modelCoefficients = await loadModelCoefficients(league);
    const saberTuningStatus = await loadSaberTuningStatus();
    let requestedDate = date;
    let fallbackUsed = false;
    let fallbackDepth = 0;
    const allowNextDateFallback = isAfterGameDateEnd(requestedDate, new Date());
    const todayText = formatDateYYYYMMDDInTimeZone(new Date(), "Asia/Seoul");
    const keepTodayGamesVisible = !includeFinished && requestedDate === todayText && !allowNextDateFallback;

    let { normalizedDate, predictions } = await buildPredictionsForDate({
      date: requestedDate,
      teamRows,
      homeAdvantage,
      includeFinished,
      includeLiveGames: keepTodayGamesVisible,
      modelCoefficients,
    });

    if (!includeFinished && predictions.length === 0 && allowNextDateFallback) {
      let cursorDate = normalizedDate.AFTER_G_DT;

      while (cursorDate && fallbackDepth < 7) {
        const result = await buildPredictionsForDate({
          date: cursorDate,
          teamRows,
          homeAdvantage,
          includeFinished,
          includeLiveGames: false,
          modelCoefficients,
        });

        fallbackDepth += 1;
        if (result.predictions.length > 0) {
          fallbackUsed = true;
          normalizedDate = result.normalizedDate;
          predictions = result.predictions;
          break;
        }

        if (!result.normalizedDate.AFTER_G_DT || result.normalizedDate.AFTER_G_DT === cursorDate) {
          break;
        }

        cursorDate = result.normalizedDate.AFTER_G_DT;
      }
    }

    try {
      await persistPredictionSnapshots({
        asOfTimestamp,
        date: normalizedDate.NOW_G_DT,
        league,
        predictions,
      });
    } catch (snapshotError) {
      console.error("Failed to persist prediction snapshots", snapshotError);
    }

    res.json({
      asOfTimestamp,
      league,
      modelVersion: modelCoefficients.version,
      modelTrainedAt: typeof modelCoefficients.trainedAt === "string" ? modelCoefficients.trainedAt : null,
      modelTrainingRange: modelCoefficients.trainingFromGameDate && modelCoefficients.trainingToGameDate
        ? {
          from: modelCoefficients.trainingFromGameDate,
          to: modelCoefficients.trainingToGameDate,
        }
        : null,
      modelLatestGameDate: typeof modelCoefficients.trainingToGameDate === "string"
        ? modelCoefficients.trainingToGameDate
        : null,
      saberTunedAt: saberTuningStatus.tunedAt,
      saberTuningRange: saberTuningStatus.rangeFrom && saberTuningStatus.rangeTo
        ? {
          from: saberTuningStatus.rangeFrom,
          to: saberTuningStatus.rangeTo,
        }
        : null,
      saberTuningSampleSize: saberTuningStatus.sampleSize,
      requestedDate,
      date: normalizedDate.NOW_G_DT,
      dateText: normalizedDate.NOW_G_DT_TEXT,
      gameCount: predictions.length,
      homeAdvantage,
      includeFinished,
      fallbackUsed,
      fallbackDepth,
      source: {
        gameCenter: "https://www.koreabaseball.com/Schedule/GameCenter/Main.aspx",
        hitter: KBO_HITTER_URL,
        pitcher: KBO_PITCHER_URL,
        hitterPlayerAdvanced: KBO_PLAYER_HITTER_ADVANCED_URL,
        pitcherPlayerBasic: KBO_PLAYER_PITCHER_BASIC_URL,
      },
      predictions,
    });
  } catch (error) {
    console.error("Failed to load game-day predictions", error);
    res.status(500).json({ error: `Failed to load ${league.toUpperCase()} game-day predictions.` });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`KBO pythagorean app is running at http://localhost:${PORT}`);
  });
}

module.exports = app;
