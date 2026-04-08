const fs = require("fs/promises");
const path = require("path");

const { iterDates, parseArgs } = require("./ml-utils");

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
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "User-Agent": "Mozilla/5.0 (compatible; kbo-ml-fetch/1.0)",
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

  const json = await response.json();
  return Array.isArray(json.game) ? json.game : [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const from = args.from;
  const to = args.to || from;
  const output = args.output || path.join(process.cwd(), "data", "game_results.kbo.ndjson");

  if (!from || !/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) {
    throw new Error("Usage: node scripts/fetch-results.js --from=YYYYMMDD [--to=YYYYMMDD] [--output=path]");
  }

  const rows = [];
  for (const date of iterDates(from, to)) {
    const games = await fetchKboDay(date);
    for (const game of games) {
      const homeScore = Number(game.B_SCORE_CN);
      const awayScore = Number(game.T_SCORE_CN);
      const completed =
        String(game.GAME_STATE_SC) === "3"
        && !hasGameCancellationFlag(game)
        && Number.isFinite(homeScore)
        && Number.isFinite(awayScore);

      rows.push({
        league: "kbo",
        gameId: game.G_ID,
        gameKey: makeGameIdentityKey(game),
        gameDate: game.G_DT,
        homeTeam: game.HOME_NM,
        awayTeam: game.AWAY_NM,
        gameState: game.GAME_STATE_SC,
        cancelStatus: game.CANCEL_SC_NM,
        homeScore,
        awayScore,
        completed,
        winner: completed ? (homeScore > awayScore ? game.HOME_NM : game.AWAY_NM) : null,
      });
    }
  }

  await fs.mkdir(path.dirname(output), { recursive: true });
  const content = rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
  await fs.writeFile(output, content, "utf8");
  console.log(`wrote ${rows.length} KBO rows to ${output}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
