const fs = require("fs/promises");
const path = require("path");
const { parseConfirmedLineups, parseBoxscore, bullpenFor, parkFor } = require("./kbo-confirmed-data");
const { atomicWrite, assertDateRange, shiftDate, sha256 } = require("./artifacts");
const { resultFromGame } = require("../scripts/fetch-results");

const BASE = "https://www.koreabaseball.com";
const SERIES = "0,1,3,4,5,6,7,8,9";
const TEAMS = { HT: "KIA", LG: "LG", OB: "두산", SS: "삼성", LT: "롯데", KT: "KT", SK: "SSG", NC: "NC", WO: "키움", HH: "한화" };
const HITTER_KEYS = ["pa", "ab", "h", "tb", "sf", "bb", "hbp"];
const PITCHER_KEYS = ["outs", "tbf", "pitches", "ab", "hits", "homeRuns", "walksAndHbp", "strikeouts", "runs", "earnedRuns"];
const POSITIONS = { 포: "포수", 一: "1루수", 二: "2루수", 三: "3루수", 유: "유격수", 좌: "좌익수", 중: "중견수", 우: "우익수", 지: "지명타자" };
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
const text = (value) => value == null ? "" : String(value).trim();
function count(value) {
  if (!/^\d+$/.test(text(value)) || !Number.isSafeInteger(Number(value))) fail("HISTORICAL_BOX_INCOMPLETE", `Invalid official count: ${value}`);
  return Number(value);
}
function grid(raw) {
  let value;
  try { value = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { fail("HISTORICAL_BOX_INCOMPLETE", "Invalid official batting grid JSON"); }
  if (!value || !Array.isArray(value.rows)) fail("HISTORICAL_BOX_INCOMPLETE", "Missing official batting grid rows");
  return value;
}
function total(keys) { return Object.fromEntries(keys.map((key) => [key, 0])); }
function add(target, source, keys) { for (const key of keys) target[key] += source[key]; return target; }
function positive(value, label) { if (!Number.isFinite(value) || value <= 0) fail("HISTORICAL_SAMPLE_UNAVAILABLE", `No positive observed ${label}`); return value; }
function dayISO(date) { return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`; }
function seoulDate(now) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(now).replace(/-/g, ""); }
function dates(from, to) { const rows = []; for (let date = from; date <= to; date = shiftDate(date, 1)) rows.push(date); return rows; }
function keys(game) { return { leId: text(game.LE_ID), srId: text(game.SR_ID), seasonId: text(game.SEASON_ID), gameId: game.G_ID }; }

// Only official batting-result abbreviations are accepted. Each is a PA, including
// sacrifice/error/choice results; a blank substitution cell is not a PA.
function parseBattingEvent(value) {
  const event = text(value);
  const result = total([...HITTER_KEYS, "homeRuns", "strikeouts", "sh", "interference"]);
  if (event === "4구" || event === "고4") { result.pa = 1; result.bb = 1; }
  else if (event === "사구") { result.pa = 1; result.hbp = 1; }
  else if (event === "타방") { result.pa = 1; result.interference = 1; }
  else if (/^[1-3유투포좌중우]+희(?:번|실|선)$/.test(event)) { result.pa = 1; result.sh = 1; }
  else if (/^[좌중우]+희(?:비|실)$/.test(event)) { result.pa = 1; result.sf = 1; }
  else if (/^[1-3유투포좌중우]+(?:안|2|3|홈)$/.test(event)) {
    result.pa = 1; result.ab = 1; result.h = 1;
    result.tb = event.endsWith("홈") ? 4 : event.endsWith("3") ? 3 : event.endsWith("2") ? 2 : 1;
    result.homeRuns = result.tb === 4 ? 1 : 0;
  } else if (event === "삼진" || event === "스낫" || event === "낫아웃") { result.pa = 1; result.ab = 1; result.strikeouts = 1; }
  else if (event === "야선" || /^[1-3유투포좌중우]+(?:땅|비|직|파|병|삼중|실|번)$/.test(event)) { result.pa = 1; result.ab = 1; }
  else fail("HISTORICAL_EVENT_UNKNOWN", `Unknown official batting event: ${event || "empty"}`);
  return result;
}
function eventsFromCell(value) {
  const raw = text(value);
  if (["", "&nbsp;", "\u00a0"].includes(raw)) return [];
  // Official multiple-PA cells use <br />/ between results, not a slash in a result.
  const parts = raw.split(/<br\s*\/?\s*>\s*\/\s*/i);
  if (parts.some((part) => !part.trim() || /[<>/]/.test(part))) fail("HISTORICAL_EVENT_UNKNOWN", `Unknown official event cell: ${raw}`);
  return parts.map(parseBattingEvent);
}
function parseHitterBox(raw, opposingPitchers, score) {
  const identity = grid(raw?.table1), events = grid(raw?.table2), statistics = grid(raw?.table3);
  const headers = events.headers?.[0]?.row?.map((cell) => text(cell?.Text));
  if (!headers?.length || headers.some((value, index) => value !== String(index + 1)) || identity.rows.length !== events.rows.length || identity.rows.length !== statistics.rows.length || identity.rows.length < 9 || statistics.tfoot?.length !== 1) fail("HISTORICAL_BOX_INCOMPLETE", "Batting box rows/innings/totals are incomplete");
  const seenOrders = new Set(), initialLineup = [], hitters = [];
  const totals = total([...HITTER_KEYS, "homeRuns", "strikeouts", "sh", "interference", "runs", "rbi"]);
  for (let index = 0; index < identity.rows.length; index += 1) {
    const row = identity.rows[index]?.row, cells = statistics.rows[index]?.row, inningCells = events.rows[index]?.row;
    if (row?.length !== 3 || cells?.length !== 5 || inningCells?.length !== headers.length) fail("HISTORICAL_BOX_INCOMPLETE", "Batting box row width is incomplete");
    const order = count(row[0]?.Text), name = text(row[2]?.Text), position = text(row[1]?.Text);
    if (order < 1 || order > 9 || !name) fail("HISTORICAL_BOX_IDENTITY_INVALID", "Invalid official batter order/name");
    if (!seenOrders.has(order)) {
      if (order !== seenOrders.size + 1 || !POSITIONS[position[0]]) fail("HISTORICAL_INITIAL_LINEUP_INVALID", "Cannot prove initial batting slots/positions");
      seenOrders.add(order); initialLineup.push({ order, name, position: POSITIONS[position[0]] });
    } else if (order !== seenOrders.size) fail("HISTORICAL_INITIAL_LINEUP_INVALID", "Substitution rows are not grouped by batting slot");
    const counts = total([...HITTER_KEYS, "homeRuns", "strikeouts", "sh", "interference"]);
    for (const cell of inningCells) {
      if (typeof cell?.Text !== "string") fail("HISTORICAL_BOX_INCOMPLETE", "Missing explicit official inning event cell");
      for (const event of eventsFromCell(cell.Text)) add(counts, event, Object.keys(counts));
    }
    if (counts.ab !== count(cells[0]?.Text) || counts.h !== count(cells[1]?.Text)) fail("HISTORICAL_EVENT_RECONCILIATION_FAILED", `${name} PA events do not reconcile with official AB/H`);
    const hitter = { name, order, ...counts, rbi: count(cells[2]?.Text), runs: count(cells[3]?.Text) };
    // cells[4] is final-season AVG and intentionally never read.
    hitters.push(hitter); add(totals, hitter, Object.keys(totals));
  }
  const foot = statistics.tfoot[0]?.row;
  if (seenOrders.size !== 9 || foot?.length !== 5 || ["ab", "h", "rbi", "runs"].some((key, i) => totals[key] !== count(foot[i]?.Text))) fail("HISTORICAL_BOX_INCOMPLETE", "Batting totals or initial slots do not reconcile");
  const pitcher = opposingPitchers.totals;
  if (totals.ab !== pitcher.ab || totals.h !== pitcher.hits || totals.runs !== score || totals.homeRuns !== pitcher.homeRuns || totals.bb + totals.hbp !== pitcher.walksAndHbp || totals.strikeouts !== pitcher.strikeouts || totals.pa !== pitcher.tbf) fail("HISTORICAL_EVENT_RECONCILIATION_FAILED", "Batting events do not reconcile with opposing pitchers and final score");
  return { hitters, totals, initialLineup };
}
function parseHistoricalBox(payload, game) {
  const box = parseBoxscore(payload, game);
  if (!Array.isArray(payload.arrHitter) || payload.arrHitter.length !== 2) fail("HISTORICAL_BOX_INCOMPLETE", "Missing both official batting boxes");
  return { ...box, awayHitting: parseHitterBox(payload.arrHitter[0], box.home, box.awayScore), homeHitting: parseHitterBox(payload.arrHitter[1], box.away, box.homeScore) };
}
function parseDate(payload, date, season) {
  if (text(payload?.code) !== "100" || !Array.isArray(payload.game)) fail("HISTORICAL_DATE_INCOMPLETE", `Missing official date ${date}`);
  const seen = new Set();
  for (const game of payload.game) {
    if (!game || game.G_DT !== date || text(game.SEASON_ID) !== season || !text(game.G_ID).startsWith(date) || seen.has(game.G_ID) || !/^\d+$/.test(text(game.LE_ID)) || !/^\d+$/.test(text(game.SR_ID))) fail("HISTORICAL_DATE_INCOMPLETE", `Invalid official date identity ${date}`);
    seen.add(game.G_ID);
    if (text(game.LE_ID) === "1" && text(game.SR_ID) === "0" && (!TEAMS[game.AWAY_ID] || !TEAMS[game.HOME_ID] || game.AWAY_ID === game.HOME_ID || !["1", "2", "3", "4", "5"].includes(text(game.GAME_STATE_SC)))) fail("HISTORICAL_DATE_INCOMPLETE", `Invalid official regular season game ${date}`);
  }
  return payload.game.filter((game) => text(game.LE_ID) === "1" && text(game.SR_ID) === "0");
}
function hitterIdentity(payload, name) {
  if (text(payload?.code) !== "100" || !Array.isArray(payload.now) || !Array.isArray(payload.retire)) fail("HISTORICAL_IDENTITY_INCOMPLETE", `Invalid official player search ${name}`);
  const candidates = [...payload.now, ...payload.retire].filter((row) => text(row.P_NM) === name && ["포수", "내야수", "외야수", "지명타자"].includes(text(row.POS_NO)));
  const ids = new Set();
  for (const row of candidates) {
    const id = text(row.P_ID), link = new URL(row.P_LINK, BASE);
    if (!/^\d+$/.test(id) || link.origin !== BASE || link.searchParams.get("playerId") !== id || !["/Record/Player/HitterDetail/Basic.aspx", "/Record/Retire/Hitter.aspx", "/Futures/Player/HitterDetail.aspx"].includes(link.pathname)) fail("HISTORICAL_IDENTITY_INCOMPLETE", `Invalid official hitter identity ${name}`);
    ids.add(id);
  }
  // Team is intentionally not used: the current roster cannot establish a past team.
  return ids.size === 1 ? { playerId: [...ids][0], name, source: "official exact-name unique hitter ID across active and retired search; historical team from game box" } : { name, exclusion: "PLAYER_IDENTITY_AMBIGUOUS" };
}

async function mapBounded(rows, concurrency, operation) {
  const result = new Array(rows.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(rows.length, concurrency) }, async () => { while (cursor < rows.length) { const index = cursor++; result[index] = await operation(rows[index], index); } }));
  return result;
}
async function collectHistoricalInputs({ from, to, cacheDir = path.join(process.cwd(), "data", "historical-cache"), timeoutMs = 15000, concurrency = 6, fetch: fetcher = global.fetch, now = new Date() } = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || typeof fetcher !== "function" || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6 || !Number.isInteger(timeoutMs) || timeoutMs < 1) fail("HISTORICAL_OPTIONS_INVALID", "Invalid historical collector options");
  const yesterday = shiftDate(seoulDate(now), -1);
  to = to || yesterday;
  const season = text(from || to).slice(0, 4);
  assertDateRange(`${season}0101`, to);
  if (to.slice(0, 4) !== season || to > yesterday) fail("HISTORICAL_OPTIONS_INVALID", "Historical range must stay within one season and end before today");
  const stats = { requests: 0, cacheHits: 0 };
  async function load(kind, id, endpoint, request, audit) {
    const file = path.join(cacheDir, season, kind, `${sha256(id)}.json`);
    function audited(payload) {
      try { return audit(payload); } catch (error) { error.message = `${kind} ${id} (${endpoint}): ${error.message}`; throw error; }
    }
    let cached;
    try { cached = JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") fail("HISTORICAL_CACHE_INVALID", `Invalid existing cache ${file}: ${error.message}`); }
    if (cached) {
      if (cached.version !== 1 || cached.sourceUrl !== `${BASE}${endpoint}` || JSON.stringify(cached.request) !== JSON.stringify(request) || cached.digest !== sha256(JSON.stringify(cached.payload))) fail("HISTORICAL_CACHE_INVALID", `Cache provenance mismatch ${file}`);
      const parsed = audited(cached.payload); stats.cacheHits += 1; return parsed;
    }
    const response = await fetcher(`${BASE}${endpoint}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "User-Agent": "Mozilla/5.0", Accept: "application/json", "X-Requested-With": "XMLHttpRequest", Referer: `${BASE}/Schedule/GameCenter/Main.aspx` }, body: new URLSearchParams(request).toString(), signal: AbortSignal.timeout(timeoutMs) });
    if (!response?.ok) fail("HISTORICAL_HTTP_ERROR", `Official ${endpoint} ${id}: HTTP ${response?.status}`);
    let payload; try { payload = await response.json(); } catch { fail("HISTORICAL_RESPONSE_INVALID", `Unparseable official ${endpoint} ${id}`); }
    const parsed = audited(payload);
    await atomicWrite(file, JSON.stringify({ version: 1, sourceUrl: `${BASE}${endpoint}`, request, fetchedAt: new Date().toISOString(), digest: sha256(JSON.stringify(payload)), payload }));
    stats.requests += 1; return parsed;
  }
  const openingDate = await load("opening", season, "/ws/Main.asmx/GetKboGameDate", { leId: "1", srId: "0", date: `${season}0101` }, (payload) => {
    if (text(payload?.code) !== "100" || text(payload.NOW_G_DT).slice(0, 4) !== season) fail("HISTORICAL_OPENING_INVALID", "Official season opening unavailable");
    assertDateRange(payload.NOW_G_DT, payload.NOW_G_DT); return payload.NOW_G_DT;
  });
  from = from || openingDate; assertDateRange(from, to);
  if (from < openingDate) from = openingDate;
  const lists = await mapBounded(dates(openingDate, to), concurrency, (date) => load("dates", date, "/ws/Main.asmx/GetKboGameList", { leId: "1", srId: SERIES, date }, (payload) => parseDate(payload, date, season)));
  const records = lists.flat().map((game) => ({ game }));
  await mapBounded(records, concurrency, async (record) => {
    const { game } = record;
    // Completed doubleheaders still feed future season totals even though their
    // own target predictions are excluded. Unsupported completed metadata fails
    // the shared box audit rather than silently omitting a regular-season game.
    if (text(game.GAME_STATE_SC) !== "3" || /서스펜|suspend/i.test(text(game.CANCEL_SC_NM))) return;
    record.box = await load("boxes", `${game.G_ID}:${game.T_SCORE_CN}:${game.B_SCORE_CN}`, "/ws/Schedule.asmx/GetBoxScoreScroll", keys(game), (payload) => parseHistoricalBox(payload, game));
    if (game.G_DT >= from) {
      if (["away", "home"].some((side) => new Set(record.box[`${side}Hitting`].initialLineup.map((row) => row.name)).size !== 9)) {
        record.lineups = { exclusion: "PLAYER_IDENTITY_AMBIGUOUS" };
        return;
      }
      record.lineups = await load("lineups", game.G_ID, "/ws/Schedule.asmx/GetLineUpAnalysis", { ...keys(game), groupSc: "SEASON" }, (payload) => {
        if (payload?.[0]?.[0]?.LINEUP_CK === false) return { exclusion: "LINEUP_UNCONFIRMED" };
        const parsed = parseConfirmedLineups(payload, game);
        for (const side of ["away", "home"]) {
          const initial = record.box[`${side}Hitting`].initialLineup;
          if (parsed[`${side}Lineup`].some((row, index) => row.name !== initial[index].name || row.position !== initial[index].position)) fail("HISTORICAL_INITIAL_LINEUP_INVALID", `Official initial lineup disagrees with box ${game.G_ID}`);
          parsed[`${side}Lineup`] = initial;
        }
        return parsed;
      });
    }
  });
  const names = [...new Set(records.flatMap((record) => record.box ? [...record.box.awayHitting.hitters, ...record.box.homeHitting.hitters].map((row) => row.name) : []))];
  const identities = new Map(await mapBounded(names, concurrency, async (name) => [name, await load("identities", name, "/ws/Controls.asmx/GetSearchPlayer", { name }, (payload) => hitterIdentity(payload, name))]));
  for (const record of records) if (record.box) for (const side of ["away", "home"]) for (const row of record.box[`${side}Hitting`].hitters) row.identity = identities.get(row.name);
  const reconstructedAt = arguments[0]?.now === undefined ? new Date() : now;
  const replay = replayHistoricalGames(records, { from, to, now: reconstructedAt });
  replay.summary = { ...replay.summary, openingDate, sourceFrom: openingDate, sourceTo: to, source: "official KBO regular-season date lists, audited complete batting/pitching boxes, initial lineup analysis, unique active+retired hitter identities", cacheDir, ...stats };
  return replay;
}

function opsFor(counts) {
  if (!counts || counts.ab <= 0 || counts.ab + counts.bb + counts.hbp + counts.sf <= 0) fail("HITTER_SAMPLE_UNAVAILABLE", "No prior official batting sample");
  const obp = (counts.h + counts.bb + counts.hbp) / (counts.ab + counts.bb + counts.hbp + counts.sf), slg = counts.tb / counts.ab;
  return { ...counts, obp, slg, ops: obp + slg };
}
function leagueFor(hitting, pitching, teamCounts, season) {
  const ops = positive(opsFor(hitting).ops, "league OPS");
  if (hitting.h !== pitching.hits || hitting.bb + hitting.hbp !== pitching.walksAndHbp || hitting.runs !== pitching.runs || hitting.games !== pitching.games || hitting.games <= 0 || hitting.games % 2 || pitching.outs <= 0) fail("HISTORICAL_LEAGUE_RECONCILIATION_FAILED", "Prior replay league totals do not reconcile");
  const era = positive(pitching.earnedRuns * 27 / pitching.outs, "league ERA"), fipConstant = era - (13 * pitching.homeRuns + 3 * pitching.walksAndHbp - 2 * pitching.strikeouts) * 3 / pitching.outs;
  return { season: Number(season), ops, era, fip: era, fipConstant, runsPerGame: positive(hitting.runs / hitting.games, "league runs"), counts: { hitting: { ...hitting }, pitching: { ...pitching }, teams: structuredClone(teamCounts) }, source: "season-to-date completed normal official boxes strictly before target calendar date" };
}
function starterFor(game, side, starts, league) {
  const id = text(game[side === "away" ? "T_PIT_P_ID" : "B_PIT_P_ID"]), name = text(game[side === "away" ? "T_PIT_P_NM" : "B_PIT_P_NM"]);
  if (!/^\d+$/.test(id) || !name) fail("STARTER_IDENTITY_INVALID", "Missing actual official starter ID/name");
  const rows = starts.get(id) || [];
  if (!rows.length) fail("STARTER_SAMPLE_UNAVAILABLE", `No prior actual starts: ${name}`);
  if (rows.some((row) => row.name !== name)) fail("STARTER_IDENTITY_INVALID", "Historical starter ID/name mismatch");
  const sample = total(PITCHER_KEYS); for (const row of rows) add(sample, row, PITCHER_KEYS);
  const numerator = 13 * sample.homeRuns + 3 * sample.walksAndHbp - 2 * sample.strikeouts;
  const fip = positive((numerator * 3 + sample.outs * league.fipConstant + 60 * league.fip) / (sample.outs + 60), "starter FIP");
  const recentStarts = rows.slice(-5).map((row) => ({ ...row }));
  const expectedInnings = recentStarts.reduce((sum, row) => sum + row.outs, 0) / (3 * recentStarts.length);
  if (expectedInnings < 0 || expectedInnings > 9) fail("STARTER_SAMPLE_INVALID", "Invalid actual last-five-start expected innings");
  return { playerId: id, name, team: TEAMS[side === "away" ? game.AWAY_ID : game.HOME_ID], season: Number(game.SEASON_ID), ...sample, rawFip: sample.outs > 0 ? numerator * 3 / sample.outs + league.fipConstant : null, fip, priorOuts: 60, priorFip: league.fip, starts: rows.length, recentStarts, expectedInnings, sampleScope: "prior official starter-ID appearances in actual starting role only; expected innings from last five starts" };
}
function replayHistoricalGames(records, { from, to, now = new Date() } = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("HISTORICAL_OPTIONS_INVALID", "Invalid replay clock");
  const ordered = [...records].sort((a, b) => a.game.G_DT.localeCompare(b.game.G_DT) || a.game.G_ID.localeCompare(b.game.G_ID));
  if (!ordered.length) return { snapshots: [], results: [], summary: { eligible: 0, excluded: 0, exclusions: [] } };
  from = from || ordered[0].game.G_DT; to = to || ordered.at(-1).game.G_DT; assertDateRange(from, to);
  const season = from.slice(0, 4);
  if (to.slice(0, 4) !== season || ordered.some((record) => text(record.game.SEASON_ID) !== season)) fail("HISTORICAL_OPTIONS_INVALID", "Replay requires one season");
  const seen = new Set(); for (const record of ordered) { if (seen.has(record.game.G_ID)) fail("HISTORICAL_DATE_INCOMPLETE", "Duplicate replay game"); seen.add(record.game.G_ID); }
  const hitting = total([...HITTER_KEYS, "games", "runs"]), pitching = total([...PITCHER_KEYS, "games"]);
  const teamCounts = Object.fromEntries(Object.keys(TEAMS).map((id) => [id, { games: 0, runs: 0 }]));
  const hitters = new Map(), starts = new Map(), boxes = [], uncertain = [], snapshots = [], results = [], exclusions = [];
  let sourceThroughDate = null, index = 0;
  while (index < ordered.length) {
    const date = ordered[index].game.G_DT, group = [];
    while (index < ordered.length && ordered[index].game.G_DT === date) group.push(ordered[index++]);
    if (date > to) break;
    const windowFrom = shiftDate(date, -14);
    while (boxes.length && boxes[0].date < windowFrom) boxes.shift();
    const window = { from: windowFrom, to: shiftDate(date, -1), days: 14, dates: dates(windowFrom, shiftDate(date, -1)), boxes, completedGames: boxes.length };
    const teamGames = new Map(); for (const record of group) if (text(record.game.GAME_STATE_SC) !== "4") for (const id of [record.game.AWAY_ID, record.game.HOME_ID]) teamGames.set(id, (teamGames.get(id) || 0) + 1);
    // Reconstruct every game on the date before accumulating any outcome on that date.
    for (const record of group) {
      const { game, box, lineups } = record;
      if (date < from) continue;
      results.push(resultFromGame(game, date));
      if (text(game.GAME_STATE_SC) !== "3") { exclusions.push({ gameId: game.G_ID, gameDate: date, reason: "NOT_COMPLETED_NORMAL_GAME" }); continue; }
      try {
        if (!box) fail("WORKLOAD_DATE_UNPROVEN", "Non-normal or suspended completion cannot be dated safely");
        if (teamGames.get(game.AWAY_ID) > 1 || teamGames.get(game.HOME_ID) > 1 || Number(game.HEADER_NO) > 0) fail("DOUBLEHEADER_TIMING_UNPROVEN", "Same-date team workloads intentionally excluded");
        if (uncertain.some((row) => row.date >= windowFrom)) fail("WORKLOAD_DATE_UNPROVEN", "Incomplete/suspended game within prior 14 days");
        if (uncertain.length) fail("HISTORICAL_CUMULATIVE_INCOMPLETE", `Unproven prior game prevents complete season totals: ${uncertain[0].gameId}`);
        if (!lineups || lineups.exclusion) fail(lineups?.exclusion || "LINEUP_UNCONFIRMED", "Initial lineup source unavailable");
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text(game.G_TM))) fail("GAME_TIME_UNAVAILABLE", "Official scheduled start unavailable");
        const gameStartsAt = new Date(`${dayISO(date)}T${game.G_TM}:00+09:00`).toISOString();
        if (new Date(gameStartsAt) >= now) fail("HISTORICAL_OPTIONS_INVALID", "Reconstruction must occur after scheduled game");
        const league = leagueFor(hitting, pitching, teamCounts, season);
        function lineup(side) {
          const initial = box[`${side}Hitting`].initialLineup;
          if (lineups[`${side}Lineup`]?.length !== 9 || lineups[`${side}Lineup`].some((row, i) => row.name !== initial[i].name || row.order !== i + 1)) fail("HISTORICAL_INITIAL_LINEUP_INVALID", "Initial lineup corroboration failed");
          return initial.map((row) => {
            const identity = box[`${side}Hitting`].hitters.find((hitter) => hitter.name === row.name)?.identity;
            if (!identity?.playerId || identity.exclusion) fail("PLAYER_IDENTITY_AMBIGUOUS", `Unproven hitter identity ${row.name}`);
            const sample = opsFor(hitters.get(identity.playerId));
            return { ...row, playerId: identity.playerId, team: TEAMS[side === "away" ? game.AWAY_ID : game.HOME_ID], season: Number(season), ...sample, adjustedOps: (sample.ops * sample.pa + league.ops * 100) / (sample.pa + 100), priorPA: 100, priorOps: league.ops };
          });
        }
        const awayLineup = lineup("away"), homeLineup = lineup("home"), awayStarter = starterFor(game, "away", starts, league), homeStarter = starterFor(game, "home", starts, league);
        const awayBullpen = bullpenFor(game.AWAY_ID, window, [], league, date), homeBullpen = bullpenFor(game.HOME_ID, window, [], league, date), park = parkFor(game.S_NM, window);
        const lineupOps = (rows) => rows.reduce((sum, row) => sum + (10 - row.order) * row.adjustedOps, 0) / 45;
        const awayOps = lineupOps(awayLineup), homeOps = lineupOps(homeLineup);
        const diagnostics = { league, away: { lineupOps: awayOps, starter: awayStarter, bullpen: awayBullpen }, home: { lineupOps: homeOps, starter: homeStarter, bullpen: homeBullpen }, park, shrinkage: { hitterPriorPA: 100, pitcherPriorOuts: 60, parkPriorGames: 10, lineupOrderWeights: [9, 8, 7, 6, 5, 4, 3, 2, 1], workloadDayWeights: { 0: 1, 1: 1, 2: 0.5, 3: 0.25 } }, window: { from: window.from, to: window.to, days: 14, completedGames: boxes.length }, sources: { statistics: "audited official boxes replayed strictly before game date; never current-season final AVG/WAR or Basic pages", lineup: "first batting-slot rows corroborated with official GetLineUpAnalysis", starter: "actual first pitching row joined to official scheduled starter ID", identity: "unique active+retired exact-name hitter search, independent of current team", sourceThroughDate } };
        const sideInputs = (ops, opposingStarter, opposingBullpen, home) => ({ lineupOpsRatio: positive(ops / league.ops, "lineup OPS ratio"), pitchingFipRatio: positive((opposingStarter.fip * opposingStarter.expectedInnings + opposingBullpen.fip * (9 - opposingStarter.expectedInnings)) / (9 * league.era), "opposing FIP ratio"), bullpenWorkload: opposingBullpen.workload, parkRunFactor: park.factor, home });
        const inputsCutoffAt = new Date(`${dayISO(date)}T00:00:00+09:00`).toISOString(), reconstructedAt = now.toISOString();
        const modelInputs = { leagueRunsPerGame: league.runsPerGame, away: sideInputs(awayOps, homeStarter, homeBullpen, 0), home: sideInputs(homeOps, awayStarter, awayBullpen, 1), diagnostics, dataAsOf: inputsCutoffAt };
        snapshots.push({ league: "kbo", gameId: game.G_ID, gameKey: game.G_ID, gameDate: date, gameStartsAt, gameState: "3", featureSchemaVersion: 3, mode: "historical_reconstruction", dataOrigin: "historical_reconstruction", trainingEligible: true, lineupConfirmed: true, asOfTimestamp: reconstructedAt, reconstructedAt, inputsCutoffAt, sourceThroughDate, awayTeam: TEAMS[game.AWAY_ID], homeTeam: TEAMS[game.HOME_ID], awayLineup, homeLineup, awayStarter, homeStarter, modelInputs });
      } catch (error) {
        if (!["HISTORICAL_SAMPLE_UNAVAILABLE", "HITTER_SAMPLE_UNAVAILABLE", "STARTER_SAMPLE_UNAVAILABLE", "BULLPEN_SAMPLE_UNAVAILABLE", "PARK_SAMPLE_UNAVAILABLE", "WORKLOAD_DATE_UNPROVEN", "HISTORICAL_CUMULATIVE_INCOMPLETE", "DOUBLEHEADER_TIMING_UNPROVEN", "LINEUP_UNCONFIRMED", "PLAYER_IDENTITY_AMBIGUOUS", "STARTER_IDENTITY_INVALID", "GAME_TIME_UNAVAILABLE"].includes(error.code)) throw error;
        exclusions.push({ gameId: game.G_ID, gameDate: date, reason: error.code, detail: error.message });
      }
    }
    for (const { game, box } of group) {
      if (!box) {
        if (text(game.GAME_STATE_SC) !== "4") uncertain.push({ date, gameId: game.G_ID });
        continue;
      }
      for (const side of ["away", "home"]) {
        const batting = box[`${side}Hitting`], pitchers = box[side], teamId = side === "away" ? game.AWAY_ID : game.HOME_ID;
        add(hitting, batting.totals, HITTER_KEYS); hitting.runs += batting.totals.runs; hitting.games += 1;
        add(pitching, pitchers.totals, PITCHER_KEYS); pitching.games += 1;
        teamCounts[teamId].games += 1; teamCounts[teamId].runs += batting.totals.runs;
        for (const row of batting.hitters) if (row.identity?.playerId && !row.identity.exclusion) {
          const sample = hitters.get(row.identity.playerId) || total(HITTER_KEYS); add(sample, row, HITTER_KEYS); hitters.set(row.identity.playerId, sample);
        }
        const id = text(game[side === "away" ? "T_PIT_P_ID" : "B_PIT_P_ID"]);
        if (/^\d+$/.test(id)) { const rows = starts.get(id) || []; rows.push({ ...pitchers.rows[0], date, gameId: game.G_ID }); starts.set(id, rows); }
      }
      boxes.push(box); sourceThroughDate = date;
    }
  }
  const reasons = {}; for (const exclusion of exclusions) reasons[exclusion.reason] = (reasons[exclusion.reason] || 0) + 1;
  return { snapshots, results, summary: { mode: "historical_reconstruction", from, to, reconstructedAt: now.toISOString(), eligible: snapshots.length, excluded: exclusions.length, reasons, exclusions } };
}

module.exports = { collectHistoricalInputs, replayHistoricalGames, parseHistoricalBox, parseHitterBox, parseBattingEvent, hitterIdentity };
