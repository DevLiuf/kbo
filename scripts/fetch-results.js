const { atomicWrite } = require("../lib/artifacts");
const path = require("path");

const { iterDates, parseArgs } = require("./ml-utils");
const { readRows, validateRange } = require("../lib/logistic");

const KBO_GAME_LIST_URL = "https://www.koreabaseball.com/ws/Main.asmx/GetKboGameList";
const KBO_SERIES_IDS = "0,1,3,4,5,6,7,8,9";

function hasGameCancellationFlag(game) {
  const cancelName = String(game.CANCEL_SC_NM || "").trim();
  if (!cancelName || cancelName === "정상경기") {
    return false;
  }

  const blockedKeywords = ["취소", "우천", "중지", "순연", "노게임"];
  return blockedKeywords.some((keyword) => cancelName.includes(keyword));
}

function makeGameIdentityKey(game) {
  const gameId = String(game.G_ID || "").trim();
  if (gameId) {
    return gameId;
  }

  return [
    game.G_DT,
    game.G_TM,
    game.AWAY_ID || game.AWAY_NM,
    game.HOME_ID || game.HOME_NM,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("-");
}

async function fetchKboDay(date) {
  const response = await fetch(KBO_GAME_LIST_URL, {
    signal: AbortSignal.timeout(8000),
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      Referer: "https://www.koreabaseball.com/Schedule/GameCenter/Main.aspx",
    },
    body: new URLSearchParams({
      leId: "1",
      srId: KBO_SERIES_IDS,
      date,
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`failed ${date}: ${response.status}`);
  }

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`KBO result JSON parse failed for ${date}: ${text.slice(0, 80)}`);
  }
  if (!json || !Array.isArray(json.game)) throw new Error(`Invalid KBO result response schema for ${date}`);
  return json.game;
}

function parseScore(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function resultFromGame(game, date) {
  const homeScore = parseScore(game.B_SCORE_CN);
  const awayScore = parseScore(game.T_SCORE_CN);
  const completed = String(game.GAME_STATE_SC) === "3" && !hasGameCancellationFlag(game)
    && homeScore !== null && awayScore !== null;
  return {
    league: "kbo", gameId: game.G_ID, gameKey: makeGameIdentityKey(game), gameDate: game.G_DT || date,
    homeTeam: game.HOME_NM, awayTeam: game.AWAY_NM, gameState: String(game.GAME_STATE_SC),
    cancelStatus: game.CANCEL_SC_NM, homeScore, awayScore, completed,
    winner: completed && homeScore !== awayScore ? (homeScore > awayScore ? game.HOME_NM : game.AWAY_NM) : null,
  };
}

function mergeResults(existing, fetched) {
  const byKey = new Map();
  for (const row of [...existing, ...fetched]) {
    const key = String(row.gameKey || row.gameId || "").trim();
    if (!key) throw new Error("Result is missing gameKey");
    byKey.set(key, { ...row, gameKey: key });
  }
  return [...byKey.values()].sort((a, b) => String(a.gameDate).localeCompare(String(b.gameDate))
    || a.gameKey.localeCompare(b.gameKey));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const from = args.from;
  const to = args.to || from;
  const output = args.output || path.join(process.cwd(), "data", "game_results.kbo.ndjson");

  if (!from || !/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) {
    throw new Error("Usage: node scripts/fetch-results.js --from=YYYYMMDD [--to=YYYYMMDD] [--output=path]");
  }
  validateRange(from, to);

  const rows = [];
  for (const date of iterDates(from, to)) {
    const games = await fetchKboDay(date);
    for (const game of games) {
      rows.push(resultFromGame(game, date));
    }
  }
  const merged = mergeResults(await readRows(output, true), rows);

  const content = merged.map((row) => JSON.stringify(row)).join("\n") + (merged.length ? "\n" : "");
  await atomicWrite(output, content);
  console.log(`merged ${rows.length} fetched KBO rows (${merged.length} total) into ${output}`);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { parseScore, resultFromGame, mergeResults, main };
