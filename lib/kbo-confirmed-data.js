const cheerio = require("cheerio");

const BASE = "https://www.koreabaseball.com";
const SERIES = "0,1,3,4,5,6,7,8,9";
const TEAMS = Object.freeze({ HT: "KIA", LG: "LG", OB: "두산", SS: "삼성", LT: "롯데", KT: "KT", SK: "SSG", NC: "NC", WO: "키움", HH: "한화" });
const PRIORS = Object.freeze({ hitterPriorPA: 100, pitcherPriorOuts: 60, parkPriorGames: 10 });
const contexts = new WeakMap();
const BOX_HEADERS = ["선수명", "등판", "결과", "승", "패", "세", "이닝", "타자", "투구수", "타수", "피안타", "홈런", "4사구", "삼진", "실점", "자책", "평균자책점"];
const BOX_COUNTS = { tbf: "타자", pitches: "투구수", ab: "타수", hits: "피안타", homeRuns: "홈런", walksAndHbp: "4사구", strikeouts: "삼진", runs: "실점", earnedRuns: "자책" };

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function text(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}
function count(value, label, code = "RECORD_INVALID") {
  const raw = text(value).replace(/,/g, "");
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) fail(code, `${label}: 유효한 정수 기록이 없어요.`);
  return Number(raw);
}
function positive(value, label) {
  if (!Number.isFinite(value) || value <= 0) fail("SKILL_UNAVAILABLE", `${label}: 양수인 관측 지표를 계산할 수 없어요.`);
  return value;
}
function inningsToOuts(value) {
  const raw = text(value);
  let match = /^(?:(\d+)\s+)?([12])\/3$/.exec(raw);
  if (!match) match = /^(\d+)(?:\.([012]))?$/.exec(raw);
  if (!match) fail("INNINGS_INVALID", `이닝 기록이 올바르지 않아요: ${raw || "없음"}`);
  const outs = Number(match[1] || 0) * 3 + Number(match[2] || 0);
  if (!Number.isSafeInteger(outs)) fail("INNINGS_INVALID", "이닝 기록 범위가 올바르지 않아요.");
  return outs;
}
function dateKey(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(date).replace(/-/g, "");
}
function calendarDate(value) {
  const raw = text(value);
  if (!/^\d{8}$/.test(raw)) fail("GAME_METADATA_INVALID", "경기 날짜가 올바르지 않아요.");
  const date = new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10).replace(/-/g, "") !== raw) fail("GAME_METADATA_INVALID", "경기 날짜가 올바르지 않아요.");
  return date;
}
function shiftDate(value, days) {
  const date = calendarDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}
function startsAt(game) {
  const raw = text(game.G_TM);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) fail("GAME_TIME_UNAVAILABLE", "공식 경기 시작 시간이 없어요.");
  calendarDate(game.G_DT);
  return new Date(`${game.G_DT.slice(0, 4)}-${game.G_DT.slice(4, 6)}-${game.G_DT.slice(6)}T${raw}:00+09:00`);
}
function requestKeys(game) {
  return { leId: text(game.LE_ID), srId: text(game.SR_ID), seasonId: text(game.SEASON_ID), gameId: text(game.G_ID) };
}
function validateGame(game, season, date) {
  if (!game || typeof game !== "object" || Array.isArray(game)) fail("GAME_METADATA_INVALID", "공식 경기 정보가 없어요.");
  for (const key of ["LE_ID", "SR_ID", "SEASON_ID", "G_ID", "G_DT", "AWAY_ID", "HOME_ID", "GAME_STATE_SC"]) {
    if (!text(game[key])) fail("GAME_METADATA_INVALID", `공식 경기 정보 ${key}가 없어요.`);
  }
  if (text(game.LE_ID) !== "1" || text(game.SR_ID) !== "0" || text(game.SEASON_ID) !== String(season) || game.G_DT !== date || !TEAMS[game.AWAY_ID] || !TEAMS[game.HOME_ID] || game.AWAY_ID === game.HOME_ID) fail("GAME_METADATA_INVALID", "현재 KBO 정규시즌 경기 정보와 일치하지 않아요.");
  if (!text(game.G_ID).startsWith(date) || !["1", "2", "3", "4", "5"].includes(text(game.GAME_STATE_SC))) fail("GAME_METADATA_INVALID", "공식 경기 ID 또는 상태가 올바르지 않아요.");
}
function eligibleGame(game, now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("AS_OF_INVALID", "조회 시각이 올바르지 않아요.");
  const date = dateKey(now);
  validateGame(game, date.slice(0, 4), date);
  if (text(game.GAME_STATE_SC) !== "1" || startsAt(game) <= now) fail("GAME_STARTED", "시작 전 경기만 현재 기록으로 예측할 수 있어요.");
  if (text(game.CANCEL_SC_ID) !== "0" || text(game.GAME_SC_ID) !== "0") fail("GAME_INELIGIBLE", "정상 정규시즌 경기만 예측할 수 있어요.");
}
function jsonGrid(raw, code) {
  let grid = raw;
  if (typeof raw === "string") {
    try { grid = JSON.parse(raw); } catch { fail(code, "공식 기록 표를 해석할 수 없어요."); }
  }
  if (!grid || typeof grid !== "object" || !Array.isArray(grid.rows)) fail(code, "공식 기록 표 행이 없어요.");
  return grid;
}
function parseConfirmedLineups(payload, game) {
  if (payload?.[0]?.[0]?.LINEUP_CK !== true) fail("LINEUP_UNCONFIRMED", "공식 선발 라인업 확정을 기다리고 있어요.");
  if (!Array.isArray(payload) || payload.length !== 5) fail("LINEUP_INVALID", "공식 라인업 응답 형식이 올바르지 않아요.");
  const result = {};
  for (let i = 0; i < 2; i += 1) {
    const meta = payload[i + 1]?.[0];
    const id = text(meta?.T_ID);
    const side = id === game.AWAY_ID ? "awayLineup" : id === game.HOME_ID ? "homeLineup" : null;
    if (!side || result[side] || text(meta.G_ID) !== text(game.G_ID) || text(meta.SEASON_ID) !== text(game.SEASON_ID) || text(meta.LE_ID) !== "1" || text(meta.SR_ID) !== "0") fail("LINEUP_IDENTITY_INVALID", "공식 라인업의 경기·팀 정보가 일치하지 않아요.");
    const grid = jsonGrid(payload[i + 3]?.[0], "LINEUP_INVALID");
    if (grid.rows.length !== 9) fail("LINEUP_INCOMPLETE", "양 팀 모두 1~9번 타자가 확정되어야 해요.");
    const rows = grid.rows.map((wrapper) => {
      const row = wrapper?.row;
      if (!Array.isArray(row) || row.length !== 4) fail("LINEUP_INVALID", "라인업 타자 행 형식이 올바르지 않아요.");
      const order = count(row[0]?.Text, "타순", "LINEUP_INVALID");
      const position = text(row[1]?.Text);
      const name = text(row[2]?.Text);
      if (!["포수", "1루수", "2루수", "3루수", "유격수", "좌익수", "중견수", "우익수", "지명타자"].includes(position) || !name || order < 1 || order > 9) fail("LINEUP_INVALID", "라인업 타순·이름·포지션이 올바르지 않아요.");
      const warText = text(row[3]?.Text);
      const war = /^-?\d+(?:\.\d+)?$/.test(warText) ? Number(warText) : null;
      return { order, position, name, war };
    }).sort((a, b) => a.order - b.order);
    if (rows.some((row, index) => row.order !== index + 1) || new Set(rows.map((row) => row.name)).size !== 9) fail("LINEUP_INCOMPLETE", "중복 없이 1~9번 타자가 확정되어야 해요.");
    result[side] = rows;
  }
  if (!result.awayLineup || !result.homeLineup) fail("LINEUP_INCOMPLETE", "양 팀 라인업이 모두 필요해요.");
  return result;
}
function htmlPage(html) {
  if (typeof html !== "string" || !html.trim()) fail("RECORD_UNAVAILABLE", "공식 선수·팀 기록이 비어 있어요.");
  const $ = cheerio.load(html);
  if (/에러\s*\|\s*KBO/.test($("title").text())) fail("RECORD_UNAVAILABLE", "공식 기록 페이지가 오류를 반환했어요.");
  return $;
}
function selectedSeason($, season) {
  const year = $("select[id$='ddlYear'], select[id$='ddlSeason']").find("option:selected");
  const series = $("select[id$='ddlSeries']").find("option:selected");
  if (year.length !== 1 || text(year.val()) !== String(season) || series.length !== 1 || text(series.val()) !== "0") fail("RECORD_SEASON_INVALID", "현재 연도 정규시즌 기록을 확인할 수 없어요.");
}
function identity($, playerId, name, page, season) {
  const actualName = text($("[id$='playerProfile_lblName']").text());
  const action = $("form").first().attr("action");
  let url;
  try { url = new URL(action, `${BASE}/Record/Player/${page}`); } catch { fail("PLAYER_IDENTITY_INVALID", "선수 기록 ID가 없어요."); }
  if (url.searchParams.get("playerId") !== String(playerId) || actualName !== name || !url.pathname.endsWith(`/${page}`)) fail("PLAYER_IDENTITY_INVALID", "선수 ID 또는 이름이 공식 기록과 일치하지 않아요.");
  if (page.endsWith("Basic.aspx") && !$("h6").toArray().some((el) => text($(el).text()) === `${season} 성적`)) fail("RECORD_SEASON_INVALID", "선수의 현재 시즌 기록이 없어요.");
}
function tableRows($, needed) {
  const tables = $("table").toArray().filter((table) => {
    const headers = $(table).find("thead th").toArray().map((el) => text($(el).text()));
    return needed.every((header) => headers.includes(header));
  });
  if (tables.length !== 1) fail("RECORD_SCHEMA_INVALID", `공식 기록 표 ${needed.join("/")}를 확인할 수 없어요.`);
  const table = tables[0];
  const headers = $(table).find("thead th").toArray().map((el) => text($(el).text()));
  return $(table).find("tbody tr").toArray().map((row) => {
    const cells = $(row).find("td").toArray();
    if (cells.length !== headers.length) fail("RECORD_SCHEMA_INVALID", "공식 기록 표 열이 일치하지 않아요.");
    return Object.fromEntries(cells.map((cell, index) => [headers[index], text($(cell).text())]));
  });
}
function oneRow($, needed) {
  const rows = tableRows($, needed);
  if (rows.length !== 1) fail("RECORD_UNAVAILABLE", "선수의 현재 시즌 전체 기록을 확인할 수 없어요.");
  return rows[0];
}
function hitterCounts(a, b) {
  const result = {};
  for (const key of ["PA", "AB", "H", "TB", "SF"]) result[key.toLowerCase()] = count(a[key], key);
  result.bb = count(b.BB, "BB");
  result.hbp = count(b.HBP, "HBP");
  if (result.h > result.ab || result.tb < result.h || result.tb > 4 * result.h || result.pa < result.ab + result.bb + result.hbp + result.sf) fail("RECORD_INVALID", "타자 누적 기록의 합계가 일치하지 않아요.");
  if (result.ab <= 0 || result.ab + result.bb + result.hbp + result.sf <= 0) fail("HITTER_SAMPLE_UNAVAILABLE", "OPS를 계산할 실제 타격 표본이 없어요.");
  result.obp = (result.h + result.bb + result.hbp) / (result.ab + result.bb + result.hbp + result.sf);
  result.slg = result.tb / result.ab;
  result.ops = result.obp + result.slg;
  return result;
}
function parseHitter(html, { playerId, name, team, season }) {
  const $ = htmlPage(html);
  identity($, playerId, name, "HitterDetail/Basic.aspx", season);
  const a = oneRow($, ["팀명", "PA", "AB", "H", "TB", "SF"]);
  const b = oneRow($, ["BB", "HBP", "OBP", "SLG", "OPS"]);
  if (a["팀명"] !== team) fail("PLAYER_TEAM_INVALID", `${name}의 현재 팀 기록이 일치하지 않아요.`);
  return { playerId: String(playerId), name, team, season: Number(season), ...hitterCounts(a, b) };
}
function parseLeague(hitterBasic1, hitterBasic2, pitcherBasic1, season) {
  function teams(html, columns) {
    const $ = htmlPage(html);
    selectedSeason($, season);
    const rows = new Map();
    const table = $("table").toArray().filter((node) => columns.every((id) => $(node).find(`tbody td[data-id='${id}']`).length));
    if (table.length !== 1) fail("LEAGUE_SCHEMA_INVALID", "공식 리그 전체 기록 표가 없어요.");
    for (const row of $(table[0]).find("tbody tr").toArray()) {
      const name = text($(row).find("td").eq(1).text());
      if (!Object.values(TEAMS).includes(name) || rows.has(name)) fail("LEAGUE_INCOMPLETE", "리그 팀 기록이 중복되거나 누락되었어요.");
      const values = {};
      for (const id of columns) {
        const cell = $(row).find(`td[data-id='${id}']`);
        if (cell.length !== 1) fail("LEAGUE_INCOMPLETE", `리그 ${name}의 ${id} 기록이 없어요.`);
        values[id] = id === "INN2_CN" ? inningsToOuts(cell.text()) : count(cell.text(), `${name} ${id}`);
      }
      rows.set(name, values);
    }
    if (rows.size !== 10) fail("LEAGUE_INCOMPLETE", "10개 팀의 공식 리그 기록이 모두 필요해요.");
    return rows;
  }
  const a = teams(hitterBasic1, ["GAME_CN", "PA_CN", "AB_CN", "RUN_CN", "HIT_CN", "TB_CN", "SF_CN"]);
  const b = teams(hitterBasic2, ["BB_CN", "HP_CN"]);
  const p = teams(pitcherBasic1, ["GAME_CN", "INN2_CN", "HIT_CN", "HR_CN", "BB_CN", "HP_CN", "KK_CN", "R_CN", "ER_CN"]);
  const htot = { pa: 0, ab: 0, h: 0, tb: 0, sf: 0, bb: 0, hbp: 0, games: 0, runs: 0 };
  const ptot = { games: 0, outs: 0, hits: 0, homeRuns: 0, bb: 0, hbp: 0, strikeouts: 0, runs: 0, earnedRuns: 0 };
  for (const [team, row] of a) {
    const extra = b.get(team);
    const hitter = hitterCounts({ PA: row.PA_CN, AB: row.AB_CN, H: row.HIT_CN, TB: row.TB_CN, SF: row.SF_CN }, { BB: extra.BB_CN, HBP: extra.HP_CN });
    for (const key of ["pa", "ab", "h", "tb", "sf", "bb", "hbp"]) htot[key] += hitter[key];
    htot.games += row.GAME_CN;
    htot.runs += row.RUN_CN;
    const pr = p.get(team);
    if (pr.GAME_CN !== row.GAME_CN) fail("LEAGUE_RECONCILIATION_FAILED", "타격·투구의 팀 경기 수가 일치하지 않아요.");
    const fields = { games: "GAME_CN", outs: "INN2_CN", hits: "HIT_CN", homeRuns: "HR_CN", bb: "BB_CN", hbp: "HP_CN", strikeouts: "KK_CN", runs: "R_CN", earnedRuns: "ER_CN" };
    for (const [key, id] of Object.entries(fields)) ptot[key] += pr[id];
  }
  if (htot.h !== ptot.hits || htot.bb !== ptot.bb || htot.hbp !== ptot.hbp || htot.runs !== ptot.runs || htot.games <= 0 || htot.games % 2 || ptot.outs <= 0) fail("LEAGUE_RECONCILIATION_FAILED", "리그 타격·투구 누적 합계를 확인할 수 없어요.");
  const ops = hitterCounts({ PA: htot.pa, AB: htot.ab, H: htot.h, TB: htot.tb, SF: htot.sf }, { BB: htot.bb, HBP: htot.hbp }).ops;
  const era = positive(ptot.earnedRuns * 27 / ptot.outs, "리그 ERA");
  const fipConstant = era - (13 * ptot.homeRuns + 3 * (ptot.bb + ptot.hbp) - 2 * ptot.strikeouts) * 3 / ptot.outs;
  return { season: Number(season), ops: positive(ops, "리그 OPS"), era, fip: era, runsPerGame: positive(htot.runs / htot.games, "리그 팀 경기당 득점"), fipConstant, counts: { hitting: htot, pitching: ptot }, source: "official current-season Team Hitter Basic1/Basic2 and Pitcher Basic1" };
}
function sumRows(rows, keys = ["outs", "tbf", "hits", "homeRuns", "bb", "hbp", "strikeouts", "runs", "earnedRuns"]) {
  const total = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const row of rows) for (const key of Object.keys(total)) if (row[key] !== undefined) total[key] += row[key];
  return total;
}
function fipFor(counts, league) {
  const walks = counts.walksAndHbp === undefined ? counts.bb + counts.hbp : counts.walksAndHbp;
  const numerator = 13 * counts.homeRuns + 3 * walks - 2 * counts.strikeouts;
  const rawFip = counts.outs > 0 ? numerator * 3 / counts.outs + league.fipConstant : null;
  // Twenty observed-league innings stabilize a small sample, not missing data.
  const fip = (numerator * 3 + counts.outs * league.fipConstant + PRIORS.pitcherPriorOuts * league.fip) / (counts.outs + PRIORS.pitcherPriorOuts);
  return { rawFip, fip: positive(fip, "FIP"), priorOuts: PRIORS.pitcherPriorOuts, priorFip: league.fip };
}
function parseStarter(basicHtml, dailyHtml, { playerId, name, team, season, gameDate }, league) {
  const $ = htmlPage(basicHtml);
  identity($, playerId, name, "PitcherDetail/Basic.aspx", season);
  const a = oneRow($, ["팀명", "G", "IP", "H", "HR", "TBF"]);
  const b = oneRow($, ["BB", "SO", "R", "ER", "WHIP", "QS"]);
  if (a["팀명"] !== team) fail("PLAYER_TEAM_INVALID", `${name}의 현재 팀 기록이 일치하지 않아요.`);
  const daily = htmlPage(dailyHtml);
  identity(daily, playerId, name, "PitcherDetail/Daily.aspx", season);
  selectedSeason(daily, season);
  const rows = [];
  const tables = daily("table").toArray().filter((node) => daily(node).find("thead th").toArray().some((el) => text(daily(el).text()) === "구분"));
  if (!tables.length) fail("STARTER_LOG_INCOMPLETE", "선발투수의 전체 월별 등판 기록이 없어요.");
  for (const table of tables) {
    const headers = daily(table).find("thead th").toArray().map((el) => text(daily(el).text()));
    if (!/^\d{1,2}월$/.test(headers[0]) || !["상대", "구분", "TBF", "IP", "H", "HR", "BB", "HBP", "SO", "R", "ER"].every((key) => headers.includes(key))) fail("STARTER_LOG_INVALID", "월별 등판 기록 형식이 올바르지 않아요.");
    for (const tr of daily(table).find("tbody tr").toArray()) {
      const cells = daily(tr).find("td").toArray().map((el) => text(daily(el).text()));
      if (cells.length !== headers.length || !/^\d{2}\.\d{2}$/.test(cells[0])) fail("STARTER_LOG_INVALID", "등판 날짜·기록이 올바르지 않아요.");
      const date = `${season}${cells[0].replace(".", "")}`;
      calendarDate(date);
      if (Number(cells[0].slice(0, 2)) !== Number(headers[0].replace("월", "")) || date >= gameDate) fail("STARTER_LOG_CUTOFF_INVALID", "당일·미래 등판 기록은 시점이 확인되지 않아 사용할 수 없어요.");
      const values = Object.fromEntries(headers.map((key, index) => [key, cells[index]]));
      if (!["선발", "구원"].includes(values["구분"])) fail("STARTER_ROLE_INVALID", "실제 선발·구원 역할을 확인할 수 없어요.");
      const row = { date, role: values["구분"], opponent: values["상대"], outs: inningsToOuts(values.IP) };
      for (const [key, header] of Object.entries({ tbf: "TBF", hits: "H", homeRuns: "HR", bb: "BB", hbp: "HBP", strikeouts: "SO", runs: "R", earnedRuns: "ER" })) row[key] = count(values[header], header);
      if (!Object.values(TEAMS).includes(row.opponent) || row.earnedRuns > row.runs || row.homeRuns > row.hits || row.strikeouts > row.tbf || row.hits + row.bb + row.hbp > row.tbf) fail("STARTER_LOG_INVALID", "등판 상대·투구 기록의 범위가 올바르지 않아요.");
      rows.push(row);
    }
  }
  const total = sumRows(rows);
  for (const [key, value] of Object.entries({ outs: inningsToOuts(a.IP), tbf: count(a.TBF, "TBF"), hits: count(a.H, "H"), homeRuns: count(a.HR, "HR"), bb: count(b.BB, "BB"), strikeouts: count(b.SO, "SO"), runs: count(b.R, "R"), earnedRuns: count(b.ER, "ER") })) {
    if (total[key] !== value) fail("STARTER_LOG_INCOMPLETE", `${name}의 전체 등판 ${key} 합계가 시즌 기록과 다르므로 사용할 수 없어요.`);
  }
  if (rows.length !== count(a.G, "G")) fail("STARTER_LOG_INCOMPLETE", "전체 등판 수가 시즌 기록과 일치하지 않아요.");
  const starts = rows.filter((row) => row.role === "선발").sort((x, y) => x.date.localeCompare(y.date));
  if (!starts.length) fail("STARTER_SAMPLE_UNAVAILABLE", "관측된 실제 선발 등판 기록이 없어요.");
  const sample = sumRows(starts);
  const recentStarts = starts.slice(-5);
  const expectedInnings = recentStarts.reduce((sum, row) => sum + row.outs, 0) / (3 * recentStarts.length);
  if (expectedInnings < 0 || expectedInnings > 9) fail("STARTER_LOG_INVALID", "최근 선발 이닝 기록이 올바르지 않아요.");
  return { playerId: String(playerId), name, team, season: Number(season), ...sample, ...fipFor(sample, league), expectedInnings, starts: starts.length, appearances: rows.length, recentStarts, sampleScope: "current-season observed starts; expected innings from last five starts" };
}
function parsePitcherBox(raw) {
  const grid = jsonGrid(raw, "BOXSCORE_INVALID");
  const headers = grid.headers?.[0]?.row?.map((cell) => text(cell?.Text));
  if (!headers || headers.length !== BOX_HEADERS.length || new Set(headers).size !== headers.length || !BOX_HEADERS.every((key) => headers.includes(key))) fail("BOXSCORE_SCHEMA_INVALID", "공식 투수 박스스코어의 동적 열을 확인할 수 없어요.");
  if (!grid.rows.length || grid.tfoot?.length !== 1) fail("BOXSCORE_INCOMPLETE", "완료 경기의 투수 기록·합계가 없어요.");
  const rows = grid.rows.map((wrapper, index) => {
    if (!Array.isArray(wrapper?.row) || wrapper.row.length !== headers.length) fail("BOXSCORE_INCOMPLETE", "투수 박스스코어 행이 불완전해요.");
    const values = Object.fromEntries(headers.map((key, i) => [key, wrapper.row[i]?.Text]));
    const name = text(values["선수명"]);
    const marker = text(values["등판"]);
    if (!name || (index === 0 ? marker !== "선발" : !/^\d+\.\d+$/.test(marker))) fail("BOXSCORE_ROLE_INVALID", "선발·구원 등판 구분을 확인할 수 없어요.");
    const row = { name, role: index === 0 ? "선발" : "구원", entry: marker, outs: inningsToOuts(values["이닝"]) };
    for (const [key, header] of Object.entries(BOX_COUNTS)) row[key] = count(values[header], header, "BOXSCORE_INCOMPLETE");
    if (row.earnedRuns > row.runs || row.homeRuns > row.hits || row.hits > row.ab || row.strikeouts > row.tbf || row.ab + row.walksAndHbp > row.tbf) fail("BOXSCORE_INVALID", "투수 박스스코어의 기록 범위가 올바르지 않아요.");
    return row;
  });
  const foot = grid.tfoot[0]?.row;
  if (!Array.isArray(foot) || foot.length !== 12 || text(foot[0]?.Text) !== "TOTAL" || text(foot[0]?.ColSpan) !== "6") fail("BOXSCORE_TOTAL_INVALID", "투수 합계 표 형식이 올바르지 않아요.");
  const columns = ["outs", "tbf", "pitches", "ab", "hits", "homeRuns", "walksAndHbp", "strikeouts", "runs", "earnedRuns"];
  const totals = sumRows(rows, columns);
  columns.forEach((key, index) => {
    const value = key === "outs" ? inningsToOuts(foot[index + 1]?.Text) : count(foot[index + 1]?.Text, key, "BOXSCORE_TOTAL_INVALID");
    // Team earned runs need not sum to individual pitcher ER (scoring rule 9.16).
    if (key === "earnedRuns") {
      if (value > totals.runs) fail("BOXSCORE_TOTAL_INVALID", "팀 자책점이 실점보다 많아요.");
      totals.earnedRuns = value;
    } else if (totals[key] !== value) fail("BOXSCORE_RECONCILIATION_FAILED", `투수 ${key} 합계와 모든 등판 행이 일치하지 않아요.`);
  });
  if (totals.outs < 12 || totals.pitches <= 0) fail("BOXSCORE_INCOMPLETE", "완료 경기의 실제 투구 기록이 부족해요.");
  return { rows, totals, relief: sumRows(rows.filter((row) => row.role === "구원"), columns), reliefAppearances: rows.length - 1 };
}
function completedGame(game, season, date) {
  validateGame(game, season, date);
  if (text(game.GAME_STATE_SC) !== "3" || text(game.CANCEL_SC_ID) !== "0" || text(game.GAME_SC_ID) !== "0" || text(game.GAME_RESULT_CK) !== "1" || text(game.SCORE_CK) !== "1" || !text(game.S_NM)) fail("COMPLETED_GAME_INVALID", "정상 종료된 정규시즌 경기 기록이 아니에요.");
  if (count(game.GAME_INN_NO, "종료 이닝", "COMPLETED_GAME_INVALID") < 5) fail("COMPLETED_GAME_INVALID", "정상 완료 경기의 이닝을 확인할 수 없어요.");
  return { awayScore: count(game.T_SCORE_CN, "원정 득점", "COMPLETED_GAME_INVALID"), homeScore: count(game.B_SCORE_CN, "홈 득점", "COMPLETED_GAME_INVALID") };
}
function parseBoxscore(payload, game) {
  const scores = completedGame(game, game.SEASON_ID, game.G_DT);
  if (text(payload?.code) !== "100" || !Array.isArray(payload.arrPitcher) || payload.arrPitcher.length !== 2) fail("BOXSCORE_INCOMPLETE", `${game.G_ID} 완료 경기의 투수 기록이 준비되지 않았어요.`);
  const away = parsePitcherBox(payload.arrPitcher[0]?.table);
  const home = parsePitcherBox(payload.arrPitcher[1]?.table);
  if (away.totals.runs !== scores.homeScore || home.totals.runs !== scores.awayScore || away.rows[0].name !== text(game.T_PIT_P_NM) || home.rows[0].name !== text(game.B_PIT_P_NM)) fail("BOXSCORE_IDENTITY_INVALID", "박스스코어 득점·선발투수가 경기 정보와 다르므로 사용할 수 없어요.");
  return { gameId: game.G_ID, date: game.G_DT, stadium: game.S_NM, awayTeamId: game.AWAY_ID, homeTeamId: game.HOME_ID, ...scores, away, home };
}
function contextFor(fetcher, concurrency) {
  let context = contexts.get(fetcher);
  if (context) return context;
  let active = 0;
  const queue = [];
  context = { cache: new Map(), pending: new Map(), async request(path, payload) {
    if (active >= concurrency) await new Promise((resolve) => queue.push(resolve));
    else active += 1;
    try {
      const response = await fetcher(`${BASE}${path}`, {
        method: payload ? "POST" : "GET", headers: { "User-Agent": "Mozilla/5.0", Accept: payload ? "application/json" : "text/html", Referer: `${BASE}/Schedule/GameCenter/Main.aspx`, ...(payload ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" } : {}) },
        ...(payload ? { body: new URLSearchParams(payload).toString() } : {}), signal: AbortSignal.timeout(15000),
      });
      if (!response?.ok) fail("UPSTREAM_HTTP_ERROR", `공식 기록 조회 실패 (${response?.status ?? "응답 없음"})`);
      try { return payload ? await response.json() : await response.text(); } catch { fail("UPSTREAM_SCHEMA_INVALID", "공식 기록 응답을 읽을 수 없어요."); }
    } catch (error) {
      if (error.code) throw error;
      fail("UPSTREAM_UNAVAILABLE", `공식 기록 조회가 중단되었어요: ${error.message}`);
    } finally {
      const next = queue.shift();
      if (next) next();
      else active -= 1;
    }
  } };
  contexts.set(fetcher, context);
  return context;
}
async function cached(context, key, ttl, load) {
  const entry = context.cache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.value;
  if (context.pending.has(key)) return context.pending.get(key);
  const pending = (async () => {
    const value = await load();
    if (context.cache.size >= 512) context.cache.delete(context.cache.keys().next().value);
    context.cache.set(key, { value, expiresAt: Date.now() + ttl });
    return value;
  })();
  context.pending.set(key, pending);
  try { return await pending; } finally { context.pending.delete(key); }
}
async function loadDate(context, date, season, currentDate) {
  return cached(context, `date:${season}:${currentDate}:${date}`, date === currentDate ? 0 : 60000, async () => {
    const payload = await context.request("/ws/Main.asmx/GetKboGameList", { leId: "1", srId: SERIES, date });
    if (text(payload?.code) !== "100" || !Array.isArray(payload.game)) fail("DATE_INCOMPLETE", `${date}의 공식 경기 배열을 확인할 수 없어요.`);
    const ids = new Set();
    for (const game of payload.game) {
      if (!game || !text(game.G_ID) || game.G_DT !== date || text(game.SEASON_ID) !== String(season) || !/^\d+$/.test(text(game.LE_ID)) || !/^\d+$/.test(text(game.SR_ID)) || ids.has(game.G_ID)) fail("DATE_INCOMPLETE", `${date} 경기 정보가 누락·중복되었어요.`);
      ids.add(game.G_ID);
      if (text(game.LE_ID) === "1" && text(game.SR_ID) === "0") validateGame(game, season, date);
    }
    return payload.game.filter((game) => text(game.LE_ID) === "1" && text(game.SR_ID) === "0");
  });
}
async function loadBox(context, game, currentDate) {
  return cached(context, `box:${game.SEASON_ID}:${currentDate}:${game.G_ID}:${game.T_SCORE_CN}:${game.B_SCORE_CN}`, 60000, async () => parseBoxscore(await context.request("/ws/Schedule.asmx/GetBoxScoreScroll", requestKeys(game)), game));
}
async function loadWindow(context, game) {
  const from = shiftDate(game.G_DT, -14);
  const to = shiftDate(game.G_DT, -1);
  return cached(context, `window:${game.SEASON_ID}:${game.G_DT}:${from}:${to}`, 60000, async () => {
    const dates = Array.from({ length: 14 }, (_, i) => shiftDate(from, i));
    const lists = await Promise.all(dates.map((date) => loadDate(context, date, game.SEASON_ID, game.G_DT)));
    const completed = [];
    for (const list of lists) for (const prior of list) {
      if (["1", "2", "5"].includes(text(prior.GAME_STATE_SC))) fail("DATE_INCOMPLETE", `${prior.G_DT}에 종료 여부가 확인되지 않은 경기가 있어요.`);
      if (/서스펜|suspend/i.test(text(prior.CANCEL_SC_NM))) fail("WORKLOAD_DATE_UNPROVEN", "서스펜디드 경기의 실제 투구 날짜를 확인할 수 없어요.");
      if (text(prior.GAME_STATE_SC) === "3") { completedGame(prior, game.SEASON_ID, prior.G_DT); completed.push(prior); }
    }
    const boxes = await Promise.all(completed.map((prior) => loadBox(context, prior, game.G_DT)));
    return { from, to, days: 14, dates, completedGames: boxes.length, boxes };
  });
}
async function sameDayWorkloads(context, game, currentGames, now) {
  const relevant = currentGames.filter((other) => other.G_ID !== game.G_ID && [other.AWAY_ID, other.HOME_ID].some((id) => id === game.AWAY_ID || id === game.HOME_ID));
  if (count(game.HEADER_NO, "더블헤더 번호", "GAME_METADATA_INVALID") > 1 && !relevant.some((other) => text(other.GAME_STATE_SC) === "3")) fail("DOUBLEHEADER_TIMING_UNPROVEN", "더블헤더 앞 경기의 종료·투구 시점을 확인할 수 없어요.");
  const result = [];
  for (const prior of relevant) {
    if (text(prior.GAME_STATE_SC) === "4") continue;
    if (text(prior.GAME_STATE_SC) !== "3") {
      if (startsAt(prior) < startsAt(game)) fail("DOUBLEHEADER_TIMING_UNPROVEN", "같은 날 앞 경기의 실제 투구가 완료되지 않았어요.");
      continue;
    }
    completedGame(prior, game.SEASON_ID, game.G_DT);
    const board = await context.request("/ws/Schedule.asmx/GetScoreBoardScroll", requestKeys(prior));
    const end = text(board?.END_TM);
    const start = text(board?.START_TM);
    if (text(board?.code) !== "100" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) fail("DOUBLEHEADER_TIMING_UNPROVEN", "같은 날 완료 경기의 공식 시작·종료 시각을 확인할 수 없어요.");
    const endTime = startsAt({ ...prior, G_TM: end });
    if (endTime <= startsAt({ ...prior, G_TM: start }) || endTime >= startsAt(game) || endTime > now) fail("DOUBLEHEADER_TIMING_UNPROVEN", "같은 날 앞 경기의 종료 시점이 현재 경기보다 이른지 확인할 수 없어요.");
    result.push(await loadBox(context, prior, game.G_DT));
  }
  return result;
}
function bullpenFor(teamId, window, sameDay, league, gameDate) {
  const samples = [];
  const workloadByDate = {};
  let games = 0;
  let appearances = 0;
  for (const box of [...window.boxes, ...sameDay]) {
    const side = box.awayTeamId === teamId ? box.away : box.homeTeamId === teamId ? box.home : null;
    if (!side) continue;
    if (box.date < gameDate) { samples.push(side.relief); games += 1; appearances += side.reliefAppearances; }
    const age = (calendarDate(gameDate) - calendarDate(box.date)) / 86400000;
    if (age >= 0 && age <= 3) workloadByDate[box.date] = (workloadByDate[box.date] || 0) + side.relief.pitches;
  }
  if (!games) fail("BULLPEN_SAMPLE_UNAVAILABLE", `${TEAMS[teamId]}의 최근 완료 경기 표본이 없어요.`);
  const total = sumRows(samples, ["outs", ...Object.keys(BOX_COUNTS)]);
  if (!appearances) fail("BULLPEN_SAMPLE_UNAVAILABLE", `${TEAMS[teamId]}의 실제 구원 등판 표본이 없어요.`);
  const pitches3d = Object.values(workloadByDate).reduce((sum, value) => sum + value, 0);
  const workload = Object.entries(workloadByDate).reduce((sum, [date, pitches]) => {
    const age = (calendarDate(gameDate) - calendarDate(date)) / 86400000;
    return sum + pitches * [1, 1, 0.5, 0.25][age] / 100;
  }, 0);
  return { ...total, ...fipFor(total, league), workload, pitches3d, workloadByDate, games, appearances, window: { from: window.from, to: window.to, days: window.days }, sampleScope: "all true relief appearances in a proven complete 14-calendar-day window", sameDayGames: sameDay.filter((box) => box.awayTeamId === teamId || box.homeTeamId === teamId).map((box) => box.gameId) };
}
function parkFor(stadium, window) {
  if (!text(stadium)) fail("PARK_UNAVAILABLE", "공식 구장 이름이 없어요.");
  const samples = window.boxes.filter((box) => box.stadium === stadium);
  const leagueRuns = window.boxes.reduce((sum, box) => sum + box.awayScore + box.homeScore, 0);
  if (!samples.length || !window.boxes.length || leagueRuns <= 0) fail("PARK_SAMPLE_UNAVAILABLE", `${stadium} 구장의 같은 기간 실제 득점 표본이 없어요.`);
  const runs = samples.reduce((sum, box) => sum + box.awayScore + box.homeScore, 0);
  const baseline = leagueRuns / window.boxes.length;
  const factor = (runs + baseline * PRIORS.parkPriorGames) / ((samples.length + PRIORS.parkPriorGames) * baseline);
  return { stadium, factor: positive(factor, "구장 득점 환경"), games: samples.length, runs, leagueGames: window.boxes.length, leagueRuns, priorGames: PRIORS.parkPriorGames, window: { from: window.from, to: window.to }, sampleScope: "observed stadium total runs versus the same complete league window" };
}
async function collectConfirmedInputs(game, { now = new Date(), fetch: fetcher = global.fetch, concurrency = 6 } = {}) {
  eligibleGame(game, now);
  if (typeof fetcher !== "function" || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) fail("COLLECTOR_OPTIONS_INVALID", "조회 함수·동시 조회 수(1~6)가 올바르지 않아요.");
  const context = contextFor(fetcher, concurrency);
  const season = text(game.SEASON_ID);
  const currentGames = await loadDate(context, game.G_DT, season, game.G_DT);
  const current = currentGames.find((row) => row.G_ID === game.G_ID);
  if (!current) fail("GAME_METADATA_INVALID", "현재 공식 일정에 해당 경기가 없어요.");
  eligibleGame(current, now);
  for (const key of ["AWAY_ID", "HOME_ID", "SEASON_ID", "G_TM", "S_NM", "T_PIT_P_ID", "B_PIT_P_ID", "T_PIT_P_NM", "B_PIT_P_NM"]) if (text(current[key]) !== text(game[key])) fail("GAME_METADATA_CHANGED", "공식 경기·선발 정보가 변경되었어요.");
  const lineups = parseConfirmedLineups(await context.request("/ws/Schedule.asmx/GetLineUpAnalysis", { ...requestKeys(current), groupSc: "SEASON" }), current);
  const league = await cached(context, `league:${season}:${game.G_DT}`, 60000, async () => {
    const pages = await Promise.all(["Hitter/Basic1", "Hitter/Basic2", "Pitcher/Basic1"].map((path) => context.request(`/Record/Team/${path}.aspx`)));
    return parseLeague(...pages, season);
  });
  async function hitters(rows, teamId) {
    const enriched = await Promise.all(rows.map(async (row) => {
      const profile = await cached(context, `hitter:${season}:${game.G_DT}:${teamId}:${row.name}`, 60000, async () => {
        const search = await context.request("/ws/Controls.asmx/GetSearchPlayer", { name: row.name });
        if (text(search?.code) !== "100" || !Array.isArray(search.now)) fail("PLAYER_SEARCH_INVALID", "현재 선수 검색 응답을 확인할 수 없어요.");
        const candidates = search.now.filter((candidate) => text(candidate.P_NM) === row.name && text(candidate.T_ID) === teamId && text(candidate.T_NM) === TEAMS[teamId] && ["포수", "내야수", "외야수", "지명타자"].includes(text(candidate.POS_NO)));
        if (candidates.length !== 1) fail("PLAYER_IDENTITY_AMBIGUOUS", `${TEAMS[teamId]} ${row.name}의 유일한 현재 타자 ID를 확인할 수 없어요.`);
        const candidate = candidates[0];
        const id = String(count(candidate.P_ID, "선수 ID", "PLAYER_IDENTITY_INVALID"));
        let link;
        try { link = new URL(candidate.P_LINK, BASE); } catch { fail("PLAYER_IDENTITY_INVALID", "현재 선수 기록 링크가 없어요."); }
        if (link.origin !== BASE || link.pathname !== "/Record/Player/HitterDetail/Basic.aspx" || link.searchParams.get("playerId") !== id) fail("PLAYER_IDENTITY_INVALID", "현재 선수 검색 ID와 기록 링크가 달라요.");
        return parseHitter(await context.request(`${link.pathname}${link.search}`), { playerId: id, name: row.name, team: TEAMS[teamId], season });
      });
      return { ...row, ...profile, adjustedOps: (profile.ops * profile.pa + league.ops * PRIORS.hitterPriorPA) / (profile.pa + PRIORS.hitterPriorPA), priorPA: PRIORS.hitterPriorPA, priorOps: league.ops };
    }));
    if (new Set(enriched.map((row) => row.playerId)).size !== 9) fail("LINEUP_IDENTITY_INVALID", "라인업 선수 ID가 중복되어 있어요.");
    return enriched;
  }
  async function starter(idValue, nameValue, teamId) {
    const id = String(count(idValue, "선발투수 ID", "STARTER_IDENTITY_INVALID"));
    const name = text(nameValue);
    if (!name || ["미정", "-", "TBD"].includes(name)) fail("STARTER_UNANNOUNCED", "공식 선발투수가 발표되지 않았어요.");
    return cached(context, `starter:${season}:${game.G_DT}:${teamId}:${id}:${name}`, 60000, async () => {
      const pages = await Promise.all(["Basic", "Daily"].map((page) => context.request(`/Record/Player/PitcherDetail/${page}.aspx?playerId=${id}`)));
      return parseStarter(...pages, { playerId: id, name, team: TEAMS[teamId], season, gameDate: game.G_DT }, league);
    });
  }
  const [awayLineup, homeLineup, awayStarter, homeStarter, window, sameDay] = await Promise.all([
    hitters(lineups.awayLineup, game.AWAY_ID), hitters(lineups.homeLineup, game.HOME_ID), starter(game.T_PIT_P_ID, game.T_PIT_P_NM, game.AWAY_ID), starter(game.B_PIT_P_ID, game.B_PIT_P_NM, game.HOME_ID), loadWindow(context, game), sameDayWorkloads(context, game, currentGames, now),
  ]);
  const awayBullpen = bullpenFor(game.AWAY_ID, window, sameDay, league, game.G_DT);
  const homeBullpen = bullpenFor(game.HOME_ID, window, sameDay, league, game.G_DT);
  const park = parkFor(game.S_NM, window);
  // The first batting slots receive greater opportunity weight, independent of WAR.
  const lineupOps = (rows) => rows.reduce((sum, row) => sum + (10 - row.order) * row.adjustedOps, 0) / 45;
  const awayOps = positive(lineupOps(awayLineup), "원정 라인업 OPS");
  const homeOps = positive(lineupOps(homeLineup), "홈 라인업 OPS");
  const diagnostics = { league, away: { lineupOps: awayOps, starter: awayStarter, bullpen: awayBullpen }, home: { lineupOps: homeOps, starter: homeStarter, bullpen: homeBullpen }, park, shrinkage: { ...PRIORS, hitterPrior: "observed league OPS", pitcherPrior: "observed league FIP (= exact league ERA by measured constant)", parkPrior: "same-window measured league total runs per game", lineupOrderWeights: [9, 8, 7, 6, 5, 4, 3, 2, 1], workloadDayWeights: { 0: 1, 1: 1, 2: 0.5, 3: 0.25 } }, window: { from: window.from, to: window.to, days: 14, completedGames: window.completedGames, dates: window.dates }, sources: { lineup: "GetLineUpAnalysis LINEUP_CK===true", hitters: "GetSearchPlayer current exact team+name and ID-targeted HitterDetail/Basic", starters: "ID-targeted PitcherDetail/Basic reconciled to all Daily monthly appearance rows", bullpen: "GetKboGameList + GetBoxScoreScroll completed normal regular-season games" } };
  function side(ops, opposingStarter, opposingBullpen, home) {
    return { lineupOpsRatio: ops / league.ops, pitchingFipRatio: positive((opposingStarter.fip * opposingStarter.expectedInnings + opposingBullpen.fip * (9 - opposingStarter.expectedInnings)) / (9 * league.era), "상대 투구 FIP 비율"), bullpenWorkload: opposingBullpen.workload, parkRunFactor: park.factor, home };
  }
  // Recheck the real clock after I/O: a pre-start request must not become a live prediction.
  const completedAt = arguments[1]?.now === undefined ? new Date() : now;
  eligibleGame(current, completedAt);
  const modelInputs = { leagueRunsPerGame: league.runsPerGame, away: side(awayOps, homeStarter, homeBullpen, 0), home: side(homeOps, awayStarter, awayBullpen, 1), diagnostics, dataAsOf: completedAt.toISOString() };
  return { modelInputs, awayLineup, homeLineup, awayStarter, homeStarter, lineupConfirmed: true, diagnostics };
}

module.exports = { collectConfirmedInputs, parseConfirmedLineups, parseHitter, parseLeague, parseStarter, parsePitcherBox, parseBoxscore, inningsToOuts, bullpenFor, parkFor };
