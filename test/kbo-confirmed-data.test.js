const test = require("node:test");
const assert = require("node:assert/strict");
const {
  collectConfirmedInputs, parseConfirmedLineups, parseHitter, parseLeague, parseStarter,
  parsePitcherBox, parseBoxscore, inningsToOuts, bullpenFor, parkFor,
} = require("../lib/kbo-confirmed-data");

const NOW = new Date("2026-10-03T08:00:00.000Z");
const TEAM_NAMES = ["KIA", "LG", "두산", "삼성", "롯데", "KT", "SSG", "NC", "키움", "한화"];
const HEADERS = ["선수명", "등판", "결과", "승", "패", "세", "이닝", "타자", "투구수", "타수", "피안타", "홈런", "4사구", "삼진", "실점", "자책", "평균자책점"];
const clone = (value) => structuredClone(value);
const coded = (code) => (error) => error.code === code;
const cell = (Text, extra = {}) => ({ Text: String(Text), ...extra });
const wrap = (values) => ({ row: values.map((value) => cell(value)) });
function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
}
function seasonSelect() {
  return '<select id="ddlYear"><option value="2026" selected>2026</option></select><select id="ddlSeries"><option value="0" selected>정규시즌</option></select>';
}
function table(headers, rows) {
  return `<table><thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${value}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
function profilePrefix(id, name, page) {
  return `<form action="./${page}.aspx?playerId=${id}"></form><span id="playerProfile_lblName">${name}</span><h6>2026 성적</h6>`;
}
function hitterHtml(id, name, team, overrides = {}) {
  const stats = { pa: 115, ab: 100, h: 30, tb: 50, sf: 2, bb: 10, hbp: 3, ...overrides };
  return profilePrefix(id, name, "Basic") + table(["팀명", "PA", "AB", "H", "TB", "SF"], [[team, stats.pa, stats.ab, stats.h, stats.tb, stats.sf]]) + table(["BB", "HBP", "OBP", "SLG", "OPS"], [[stats.bb, stats.hbp, "0.374", "0.500", "0.874"]]);
}
function leaguePages() {
  function source(columns, values) {
    return seasonSelect() + `<table><tbody>${TEAM_NAMES.map((team, index) => `<tr><td>${index + 1}</td><td>${team}</td>${columns.map((id, i) => `<td data-id="${id}">${values[i]}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }
  return [
    source(["GAME_CN", "PA_CN", "AB_CN", "RUN_CN", "HIT_CN", "TB_CN", "SF_CN"], [20, 115, 100, 100, 30, 50, 2]),
    source(["BB_CN", "HP_CN"], [10, 3]),
    source(["GAME_CN", "INN2_CN", "HIT_CN", "HR_CN", "BB_CN", "HP_CN", "KK_CN", "R_CN", "ER_CN"], [20, 180, 30, 5, 10, 3, 60, 100, 80]),
  ];
}
function starterPages(id, name, team) {
  // Six starts grow from one to six innings; a four-walk relief appearance must
  // reconcile to the full season without contaminating starter skill or IP/G.
  const rows = [1, 5, 10, 15, 20, 28].map((day, index) => [
    `09.${String(day).padStart(2, "0")}`, "NC", "선발", "", "3.00", (index + 1) * 3 + 5,
    index + 1, 2, index < 2 ? 1 : 0, 1, index === 0 ? 1 : 0, 2, 1, 1, "3.00",
  ]);
  rows.push(["09.30", "NC", "구원", "", "0.00", 6, 1, 1, 0, 4, 1, 0, 0, 0, "3.00"]);
  const basic = profilePrefix(id, name, "Basic") + table(["팀명", "G", "IP", "H", "HR", "TBF"], [[team, 7, 22, 13, 2, 99]]) + table(["BB", "SO", "R", "ER", "WHIP", "QS"], [[10, 12, 6, 6, "1.00", 0]]);
  const daily = profilePrefix(id, name, "Daily") + seasonSelect() + table(["9월", "상대", "구분", "결과", "ERA1", "TBF", "IP", "H", "HR", "BB", "HBP", "SO", "R", "ER", "ERA2"], rows);
  return { basic, daily };
}
function game(date = "20261003", overrides = {}) {
  return { LE_ID: 1, SR_ID: 0, SEASON_ID: 2026, G_DT: date, G_ID: `${date}HTLG0`, G_TM: "18:30", HEADER_NO: 0, S_NM: "잠실", AWAY_ID: "HT", HOME_ID: "LG", AWAY_NM: "KIA", HOME_NM: "LG", T_PIT_P_ID: 54640, T_PIT_P_NM: "네일", B_PIT_P_ID: 56103, B_PIT_P_NM: "카라스코", GAME_STATE_SC: "1", CANCEL_SC_ID: "0", GAME_SC_ID: 0, GAME_RESULT_CK: 0, SCORE_CK: "0", ...overrides };
}
function completed(date = "20261001", overrides = {}) {
  return game(date, { GAME_STATE_SC: "3", GAME_INN_NO: 9, GAME_RESULT_CK: 1, SCORE_CK: "1", T_SCORE_CN: "5", B_SCORE_CN: "5", ...overrides });
}
function lineupPayload(target) {
  const meta = (id) => [{ T_ID: id, G_ID: target.G_ID, LE_ID: 1, SR_ID: 0, SEASON_ID: 2026 }];
  const grid = (prefix) => JSON.stringify({ rows: Array.from({ length: 9 }, (_, i) => wrap([i + 1, ["중견수", "유격수", "1루수", "좌익수", "3루수", "우익수", "포수", "2루수", "지명타자"][i], `${prefix}${i + 1}`, "1.25"])) });
  return [[{ LINEUP_CK: true }], meta("LG"), meta("HT"), [grid("홈타자")], [grid("원정타자")]];
}
function pitcherGrid(starter) {
  // These observed source shapes deliberately include 0, 1/3 and 2/3 IP.
  return {
    headers: [wrap(HEADERS)],
    rows: [
      wrap([starter, "선발", "", 0, 0, 0, 7, 30, 85, 28, 5, 1, 2, 5, 3, 3, "3.86"]),
      wrap(["영이닝투수", "8.9", "", 0, 0, 0, 0, 2, 11, 0, 0, 0, 2, 0, 1, 1, "-"]),
      wrap(["한아웃투수", "8.1", "", 0, 0, 0, "1/3", 1, 7, 1, 0, 0, 0, 1, 0, 0, "0.00"]),
      wrap(["두아웃투수", "8.2", "", 0, 0, 0, "2/3", 3, 13, 2, 1, 0, 1, 1, 1, 1, "13.50"]),
      wrap(["마무리투수", "9.1", "", 0, 0, 0, 1, 3, 14, 3, 0, 0, 0, 1, 0, 0, "0.00"]),
    ],
    tfoot: [{ row: [cell("TOTAL", { ColSpan: "6" }), ...[9, 39, 130, 34, 6, 1, 5, 8, 5, 5, "5.00"].map((value) => cell(value))] }],
  };
}
function boxPayload() {
  return { code: "100", arrPitcher: [{ table: JSON.stringify(pitcherGrid("네일")) }, { table: JSON.stringify(pitcherGrid("카라스코")) }] };
}
function fixture() {
  const target = game();
  const routes = new Map();
  const lists = new Map([["20261003", { code: "100", game: [target] }]]);
  const boxes = new Map();
  for (let offset = 1; offset <= 14; offset += 1) {
    const d = new Date("2026-10-03T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - offset);
    const date = d.toISOString().slice(0, 10).replace(/-/g, "");
    const games = ["20261001", "20260930"].includes(date) ? [completed(date)] : [];
    lists.set(date, { code: "100", game: games });
    for (const prior of games) boxes.set(prior.G_ID, boxPayload());
  }
  leaguePages().forEach((html, i) => routes.set(`/Record/Team/${["Hitter/Basic1", "Hitter/Basic2", "Pitcher/Basic1"][i]}.aspx`, html));
  for (const [prefix, teamId, team, baseId] of [["원정타자", "HT", "KIA", 1000], ["홈타자", "LG", "LG", 2000]]) {
    for (let i = 1; i <= 9; i += 1) {
      const name = `${prefix}${i}`;
      const id = baseId + i;
      routes.set(`search:${name}`, { code: "100", now: [{ P_ID: id, P_NM: name, T_ID: teamId, T_NM: team, POS_NO: "내야수", P_LINK: `/Record/Player/HitterDetail/Basic.aspx?playerId=${id}` }] });
      routes.set(`/Record/Player/HitterDetail/Basic.aspx?playerId=${id}`, hitterHtml(id, name, team));
    }
  }
  for (const [id, name, team] of [[54640, "네일", "KIA"], [56103, "카라스코", "LG"]]) {
    const pages = starterPages(id, name, team);
    routes.set(`/Record/Player/PitcherDetail/Basic.aspx?playerId=${id}`, pages.basic);
    routes.set(`/Record/Player/PitcherDetail/Daily.aspx?playerId=${id}`, pages.daily);
  }
  const state = { target, routes, lists, boxes, lineup: lineupPayload(target), scoreboard: { code: "100", START_TM: "14:00", END_TM: "16:40" }, active: 0, maximumActive: 0, delay: false };
  state.fetch = async (url, options) => {
    state.active += 1;
    state.maximumActive = Math.max(state.maximumActive, state.active);
    try {
      if (state.delay) await new Promise((resolve) => setTimeout(resolve, 1));
      const parsed = new URL(url);
      const params = new URLSearchParams(options.body);
      let value;
      if (parsed.pathname === "/ws/Main.asmx/GetKboGameList") value = lists.get(params.get("date"));
      else if (parsed.pathname === "/ws/Schedule.asmx/GetLineUpAnalysis") value = state.lineup;
      else if (parsed.pathname === "/ws/Schedule.asmx/GetBoxScoreScroll") value = boxes.get(params.get("gameId"));
      else if (parsed.pathname === "/ws/Schedule.asmx/GetScoreBoardScroll") value = state.scoreboard;
      else if (parsed.pathname === "/ws/Controls.asmx/GetSearchPlayer") value = routes.get(`search:${params.get("name")}`);
      else value = routes.get(`${parsed.pathname}${parsed.search}`);
      if (value === undefined) throw new Error(`Unprovided official fixture: ${parsed.pathname}${parsed.search}`);
      return { ok: true, status: 200, async json() { return clone(value); }, async text() { return value; } };
    } finally { state.active -= 1; }
  };
  return state;
}
function collect(f) {
  return collectConfirmedInputs(f.target, { now: NOW, fetch: f.fetch });
}

test("only upstream boolean confirmation and complete distinct 1..9 lineups authorize collection", () => {
  const target = game();
  for (const flag of [false, null, undefined, 1, "1", "true"]) {
    const payload = lineupPayload(target);
    payload[0][0].LINEUP_CK = flag;
    assert.throws(() => parseConfirmedLineups(payload, target), coded("LINEUP_UNCONFIRMED"));
  }
  const good = parseConfirmedLineups(lineupPayload(target), target);
  assert.equal(good.awayLineup[0].name, "원정타자1");
  assert.equal(good.homeLineup[8].order, 9);
  for (const corrupt of [
    (grid) => grid.rows.pop(),
    (grid) => { grid.rows[8].row[0].Text = "8"; },
    (grid) => { grid.rows[8].row[2].Text = "원정타자1"; },
  ]) {
    const payload = lineupPayload(target);
    const grid = JSON.parse(payload[4][0]);
    corrupt(grid);
    payload[4][0] = JSON.stringify(grid);
    assert.throws(() => parseConfirmedLineups(payload, target), coded("LINEUP_INCOMPLETE"));
  }
  const wrongTeam = lineupPayload(target);
  wrongTeam[1][0].T_ID = "NC";
  assert.throws(() => parseConfirmedLineups(wrongTeam, target), coded("LINEUP_IDENTITY_INVALID"));
});

test("hitter OPS comes from exact counts and identity never falls back across team, ID or season", () => {
  const options = { playerId: "1001", name: "원정타자1", team: "KIA", season: "2026" };
  const hitter = parseHitter(hitterHtml(1001, "원정타자1", "KIA"), options);
  close(hitter.ops, 43 / 115 + 50 / 100);
  assert.equal(hitter.pa, 115);
  assert.throws(() => parseHitter(hitterHtml(1001, "원정타자1", "LG"), options), coded("PLAYER_TEAM_INVALID"));
  assert.throws(() => parseHitter(hitterHtml(10010, "원정타자1", "KIA"), options), coded("PLAYER_IDENTITY_INVALID"));
  assert.throws(() => parseHitter(hitterHtml(1001, "동명이인", "KIA"), options), coded("PLAYER_IDENTITY_INVALID"));
  assert.throws(() => parseHitter(hitterHtml(1001, "원정타자1", "KIA").replace("2026 성적", "2025 성적"), options), coded("RECORD_SEASON_INVALID"));
  for (const missing of ["", " ", null, undefined]) assert.throws(() => parseHitter(hitterHtml(1001, "원정타자1", "KIA", { bb: missing }), options), coded("RECORD_INVALID"));
  assert.throws(() => parseHitter("", options), coded("RECORD_UNAVAILABLE"));
  assert.throws(() => parseHitter(hitterHtml(1001, "원정타자1", "KIA", { pa: 100 }), options), coded("RECORD_INVALID"));
});

test("league rates use full joined counts, exact outs and team-game denominators", () => {
  const pages = leaguePages();
  const league = parseLeague(...pages, "2026");
  close(league.ops, 43 / 115 + 0.5);
  close(league.era, 4);
  close(league.runsPerGame, 5);
  close(league.fipConstant, 4 - (13 * 50 + 3 * 130 - 2 * 600) * 3 / 5400);
  const sortedDifferent = clone(pages);
  const rows = sortedDifferent[1].match(/<tr>.*?<\/tr>/g);
  sortedDifferent[1] = seasonSelect() + `<table><tbody>${rows.reverse().join("")}</tbody></table>`;
  close(parseLeague(...sortedDifferent, "2026").ops, league.ops);
  assert.throws(() => parseLeague(pages[0].replace(/<tr>.*?<\/tr>/, ""), pages[1], pages[2], "2026"), coded("LEAGUE_INCOMPLETE"));
  assert.throws(() => parseLeague(pages[0], pages[1], pages[2].replace('data-id="HIT_CN">30', 'data-id="HIT_CN">31'), "2026"), coded("LEAGUE_RECONCILIATION_FAILED"));
  assert.throws(() => parseLeague(pages[0].replace('value="2026" selected', 'value="2025" selected'), pages[1], pages[2], "2026"), coded("RECORD_SEASON_INVALID"));
});

test("starter season reconciles every appearance, then uses starts only and last-five-start innings", () => {
  const league = parseLeague(...leaguePages(), "2026");
  const pages = starterPages(54640, "네일", "KIA");
  const options = { playerId: "54640", name: "네일", team: "KIA", season: "2026", gameDate: "20261003" };
  const starter = parseStarter(pages.basic, pages.daily, options, league);
  assert.equal(starter.starts, 6);
  assert.equal(starter.appearances, 7);
  assert.equal(starter.outs, 63);
  assert.equal(starter.bb, 6);
  assert.equal(starter.hbp, 1);
  assert.equal(starter.expectedInnings, 4);
  close(starter.rawFip, (13 * 2 + 3 * 7 - 2 * 12) * 3 / 63 + league.fipConstant);
  assert.equal(starter.pitches, undefined);
  assert.throws(() => parseStarter(pages.basic, pages.daily.replace("<td>09.30</td>", "<td>10.03</td>"), options, league), coded("STARTER_LOG_CUTOFF_INVALID"));
  assert.throws(() => parseStarter(pages.basic, pages.daily.replace(/<tr><td>09\.30<\/td>.*?<\/tr>/, ""), options, league), coded("STARTER_LOG_INCOMPLETE"));
  assert.throws(() => parseStarter(pages.basic, pages.daily.replace('value="2026" selected', 'value="2025" selected'), options, league), coded("RECORD_SEASON_INVALID"));
  assert.throws(() => parseStarter(pages.basic.replace("<td>KIA</td>", "<td>LG</td>"), pages.daily, options, league), coded("PLAYER_TEAM_INVALID"));
  const improved = parseStarter(pages.basic.replace("<td>10</td><td>12</td>", "<td>10</td><td>18</td>"), pages.daily.replaceAll("<td>2</td><td>1</td><td>1</td><td>3.00</td>", "<td>3</td><td>1</td><td>1</td><td>3.00</td>"), options, league);
  assert.ok(improved.fip < starter.fip);
});

test("baseball fractional innings and zero-out appearances retain real walks and pitches", () => {
  for (const [value, outs] of [["0", 0], ["1/3", 1], ["2/3", 2], ["5 2/3", 17], ["5.1", 16]]) assert.equal(inningsToOuts(value), outs);
  for (const value of [null, "", " ", "3/3", "5.3", "5.5", false]) assert.throws(() => inningsToOuts(value), coded("INNINGS_INVALID"));
  const parsed = parsePitcherBox(pitcherGrid("네일"));
  assert.equal(parsed.relief.outs, 6);
  assert.equal(parsed.relief.pitches, 45);
  assert.equal(parsed.relief.walksAndHbp, 3);
  assert.equal(parsed.relief.bb, undefined);
  assert.equal(parsed.relief.hbp, undefined);
  assert.equal(parsed.rows[1].outs, 0);
  assert.equal(parsed.rows[1].walksAndHbp, 2);
  assert.equal(parsed.rows[1].pitches, 11);
  const shuffled = pitcherGrid("네일");
  for (const row of [shuffled.headers[0], ...shuffled.rows]) [row.row[7], row.row[8]] = [row.row[8], row.row[7]];
  assert.equal(parsePitcherBox(shuffled).relief.pitches, 45);
});

test("official team earned runs are independent of individual and bullpen earned runs", () => {
  const raw = pitcherGrid("네일");
  raw.tfoot[0].row[10].Text = "4";
  const parsed = parsePitcherBox(raw);
  assert.equal(parsed.totals.earnedRuns, 4);
  assert.equal(parsed.rows.reduce((sum, row) => sum + row.earnedRuns, 0), 5);
  assert.equal(parsed.relief.earnedRuns, 2);
  raw.tfoot[0].row[10].Text = "6";
  assert.throws(() => parsePitcherBox(raw), coded("BOXSCORE_TOTAL_INVALID"));
  raw.tfoot[0].row[10].Text = "";
  assert.throws(() => parsePitcherBox(raw), coded("BOXSCORE_TOTAL_INVALID"));
});

test("completed boxscores require every row, dynamic schema, totals and game identity", () => {
  const g = completed();
  const box = parseBoxscore(boxPayload(), g);
  assert.equal(box.away.totals.runs, 5);
  const corrupt = pitcherGrid("네일");
  corrupt.rows.pop();
  assert.throws(() => parsePitcherBox(corrupt), coded("BOXSCORE_RECONCILIATION_FAILED"));
  const missing = pitcherGrid("네일");
  missing.rows[1].row[12].Text = "";
  assert.throws(() => parsePitcherBox(missing), coded("BOXSCORE_INCOMPLETE"));
  assert.throws(() => parsePitcherBox({ ...pitcherGrid("네일"), tfoot: [] }), coded("BOXSCORE_INCOMPLETE"));
  const badRole = pitcherGrid("네일");
  badRole.rows[1].row[1].Text = "선발";
  assert.throws(() => parsePitcherBox(badRole), coded("BOXSCORE_ROLE_INVALID"));
  assert.throws(() => parseBoxscore({ code: "200", arrPitcher: [] }, g), coded("BOXSCORE_INCOMPLETE"));
  assert.throws(() => parseBoxscore(boxPayload(), { ...g, T_SCORE_CN: "6" }), coded("BOXSCORE_IDENTITY_INVALID"));
  assert.throws(() => parseBoxscore(boxPayload(), { ...g, GAME_STATE_SC: "2" }), coded("COMPLETED_GAME_INVALID"));
  assert.throws(() => parseBoxscore(boxPayload(), { ...g, CANCEL_SC_ID: "1" }), coded("COMPLETED_GAME_INVALID"));
});

test("full collector computes batting versus opposing pitching from a proven calendar window", async () => {
  const f = fixture();
  const result = await collect(f);
  const league = result.diagnostics.league;
  assert.equal(result.lineupConfirmed, true);
  assert.equal(result.awayLineup[0].playerId, "1001");
  assert.equal(result.homeLineup[8].playerId, "2009");
  close(result.modelInputs.away.lineupOpsRatio, 1);
  close(result.modelInputs.home.lineupOpsRatio, 1);
  assert.equal(result.modelInputs.leagueRunsPerGame, 5);
  assert.equal(result.diagnostics.window.from, "20260919");
  assert.equal(result.diagnostics.window.to, "20261002");
  assert.equal(result.diagnostics.window.completedGames, 2);
  assert.equal(result.diagnostics.away.bullpen.outs, 12);
  assert.equal(result.diagnostics.away.bullpen.pitches3d, 90);
  close(result.modelInputs.home.bullpenWorkload, 45 * 0.5 / 100 + 45 * 0.25 / 100);
  const starter = result.homeStarter;
  const bullpen = result.diagnostics.home.bullpen;
  close(result.modelInputs.away.pitchingFipRatio, (starter.fip * 4 + bullpen.fip * 5) / (9 * league.era));
  assert.equal(result.modelInputs.away.parkRunFactor, 1);
  assert.equal(result.modelInputs.dataAsOf, NOW.toISOString());
  const better = fixture();
  better.routes.set("/Record/Player/HitterDetail/Basic.aspx?playerId=1001", hitterHtml(1001, "원정타자1", "KIA", { h: 40, tb: 70 }));
  const improved = await collect(better);
  assert.ok(improved.modelInputs.away.lineupOpsRatio > result.modelInputs.away.lineupOpsRatio);
  assert.equal(improved.modelInputs.home.lineupOpsRatio, result.modelInputs.home.lineupOpsRatio);
});

test("wrong-team or ambiguous current search identities never borrow another player", async () => {
  for (const mutate of [
    (search) => { search.now[0].T_ID = "NC"; search.now[0].T_NM = "NC"; },
    (search) => { search.now.push({ ...search.now[0], P_ID: 99999 }); },
    (search) => { search.now[0].POS_NO = "투수"; },
    (search) => { search.now = null; },
  ]) {
    const f = fixture();
    const search = clone(f.routes.get("search:원정타자1"));
    mutate(search);
    f.routes.set("search:원정타자1", search);
    await assert.rejects(collect(f), (error) => ["PLAYER_IDENTITY_AMBIGUOUS", "PLAYER_SEARCH_INVALID"].includes(error.code));
  }
});

test("every calendar date and every completed boxscore must succeed; failure cannot authorize cached success", async () => {
  for (const value of [null, {}, { code: "100", game: null }, { code: "100" }]) {
    const f = fixture();
    f.lists.set("20261002", value);
    await assert.rejects(collect(f), coded("DATE_INCOMPLETE"));
  }
  const f = fixture();
  f.boxes.set("20261001HTLG0", { code: "200", arrPitcher: [] });
  await assert.rejects(collect(f), coded("BOXSCORE_INCOMPLETE"));
  f.boxes.set("20261001HTLG0", boxPayload());
  const recovered = await collect(f);
  assert.equal(recovered.diagnostics.away.bullpen.pitches3d, 90);
  const ongoing = fixture();
  ongoing.lists.set("20261002", { code: "100", game: [completed("20261002", { GAME_STATE_SC: "2" })] });
  await assert.rejects(collect(ongoing), coded("DATE_INCOMPLETE"));
});

test("started, historical, cancelled, and changed-current-metadata games are ineligible", async () => {
  for (const override of [{ GAME_STATE_SC: "2" }, { GAME_STATE_SC: "3" }, { G_TM: "16:00" }]) {
    const f = fixture();
    f.target = { ...f.target, ...override };
    await assert.rejects(collect(f), coded("GAME_STARTED"));
  }
  const past = fixture();
  past.target = game("20261002");
  await assert.rejects(collect(past), coded("GAME_METADATA_INVALID"));
  const cancelled = fixture();
  cancelled.target = { ...cancelled.target, CANCEL_SC_ID: "1" };
  await assert.rejects(collect(cancelled), coded("GAME_INELIGIBLE"));
  const changed = fixture();
  changed.lists.set("20261003", { code: "100", game: [{ ...changed.target, B_PIT_P_ID: 99999 }] });
  await assert.rejects(collect(changed), coded("GAME_METADATA_CHANGED"));
});

test("same-day doubleheader relief workloads require observed official completion timing", async () => {
  const f = fixture();
  f.target.HEADER_NO = 2;
  const prior = completed("20261003", { G_ID: "20261003HTLG1", HEADER_NO: 1, G_TM: "14:00" });
  f.lists.set("20261003", { code: "100", game: [prior, f.target] });
  f.boxes.set(prior.G_ID, boxPayload());
  const result = await collect(f);
  assert.equal(result.diagnostics.home.bullpen.pitches3d, 135);
  close(result.modelInputs.away.bullpenWorkload, 0.3375 + 0.45);
  assert.deepEqual(result.diagnostics.home.bullpen.sameDayGames, [prior.G_ID]);
  const unproven = fixture();
  unproven.target.HEADER_NO = 2;
  unproven.lists.set("20261003", { code: "100", game: [prior, unproven.target] });
  unproven.scoreboard.END_TM = "";
  await assert.rejects(collect(unproven), coded("DOUBLEHEADER_TIMING_UNPROVEN"));
  const absent = fixture();
  absent.target.HEADER_NO = 2;
  await assert.rejects(collect(absent), coded("DOUBLEHEADER_TIMING_UNPROVEN"));
});

test("stadium factors shrink measured runs in the same league window and never invent an absent sample", () => {
  const window = { from: "20260919", to: "20261002", boxes: [
    { stadium: "잠실", awayScore: 8, homeScore: 8 },
    { stadium: "대구", awayScore: 2, homeScore: 2 },
  ] };
  const park = parkFor("잠실", window);
  close(park.factor, (16 + 10 * 10) / (11 * 10));
  assert.ok(park.factor > 1);
  assert.throws(() => parkFor("수원", window), coded("PARK_SAMPLE_UNAVAILABLE"));
  assert.throws(() => parkFor("잠실", { ...window, boxes: [] }), coded("PARK_SAMPLE_UNAVAILABLE"));
});

test("measured relief walks worsen FIP while zero-out pitches increase same-day workload", () => {
  const league = parseLeague(...leaguePages(), "2026");
  const box = parseBoxscore(boxPayload(), completed());
  const window = { from: "20260919", to: "20261002", days: 14, boxes: [box] };
  const original = bullpenFor("HT", window, [], league, "20261003");
  const worseBox = clone(box);
  worseBox.away.relief.walksAndHbp += 2;
  const worse = bullpenFor("HT", { ...window, boxes: [worseBox] }, [], league, "20261003");
  assert.ok(worse.fip > original.fip);
  const sameDay = { ...clone(box), date: "20261003", gameId: "20261003HTLG1" };
  sameDay.away.relief.outs = 0;
  sameDay.away.relief.pitches = 11;
  const used = bullpenFor("HT", window, [sameDay], league, "20261003");
  close(used.workload - original.workload, 0.11);
});

test("concurrent collectors keep upstream requests within the six-slot boundary", async () => {
  const f = fixture();
  f.delay = true;
  const [first, second] = await Promise.all([collect(f), collect(f)]);
  assert.equal(first.diagnostics.away.bullpen.pitches3d, 90);
  assert.equal(second.diagnostics.home.bullpen.pitches3d, 90);
  assert.ok(f.maximumActive <= 6, `Observed ${f.maximumActive} simultaneous requests`);
});
