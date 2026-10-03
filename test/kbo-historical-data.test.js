const test = require("node:test");
const assert = require("node:assert/strict");
const { parseHistoricalBox, parseBattingEvent, replayHistoricalGames, hitterIdentity } = require("../lib/kbo-historical-data");
const { isPregameSnapshot } = require("../lib/prediction-contract");

const HEADERS = ["선수명", "등판", "결과", "승", "패", "세", "이닝", "타자", "투구수", "타수", "피안타", "홈런", "4사구", "삼진", "실점", "자책", "평균자책점"];
const cell = (Text, extra = {}) => ({ Text: String(Text), ...extra });
const wrap = (values) => ({ row: values.map((value) => cell(value)) });
const NOW = new Date("2026-04-20T12:00:00.000Z");
function game(date, overrides = {}) {
  return { LE_ID: 1, SR_ID: 0, SEASON_ID: 2026, G_DT: date, G_ID: `${date}HTLG0`, G_TM: "18:30", HEADER_NO: 0, S_NM: "잠실", AWAY_ID: "HT", HOME_ID: "LG", AWAY_NM: "KIA", HOME_NM: "LG", T_PIT_P_ID: 111, T_PIT_P_NM: "원정선발", B_PIT_P_ID: 222, B_PIT_P_NM: "홈선발", GAME_STATE_SC: "3", CANCEL_SC_ID: "0", CANCEL_SC_NM: "정상경기", GAME_SC_ID: 0, GAME_INN_NO: 9, GAME_RESULT_CK: 1, SCORE_CK: "1", T_SCORE_CN: "3", B_SCORE_CN: "3", ...overrides };
}
function pitcher(name) {
  return { headers: [wrap(HEADERS)], rows: [wrap([name, "선발", "", 0, 0, 0, 6, 24, 70, 24, 6, 0, 0, 6, 2, 2, "3.00"]), wrap(["구원", "7.1", "", 0, 0, 0, 3, 12, 40, 12, 3, 0, 0, 3, 1, 1, "3.00"])], tfoot: [{ row: [cell("TOTAL", { ColSpan: "6" }), ...[9, 36, 110, 36, 9, 0, 0, 9, 3, 3, "3.00"].map((value) => cell(value))] }] };
}
function hitters(prefix) {
  const positions = ["중", "유", "一", "좌", "三", "우", "포", "二", "지"];
  return { table1: { rows: positions.map((position, index) => wrap([index + 1, position, `${prefix}${index + 1}`])) }, table2: { headers: [wrap([1, 2, 3, 4, 5, 6, 7, 8, 9])], rows: positions.map(() => wrap(["좌안", "삼진", "유땅", "중비", "&nbsp;", "&nbsp;", "&nbsp;", "&nbsp;", "&nbsp;"])) }, table3: { rows: positions.map((_, index) => wrap([4, 1, index === 0 ? 3 : 0, index === 0 ? 3 : 0, ".999"])), tfoot: [wrap([36, 9, 3, 3, ".999"])] } };
}
function payload() { return { code: "100", arrPitcher: [{ table: pitcher("원정선발") }, { table: pitcher("홈선발") }], arrHitter: [hitters("원정"), hitters("홈")] }; }
function record(date, overrides = {}) {
  const official = game(date, overrides), box = parseHistoricalBox(payload(), official);
  for (const [side, base] of [["away", 1000], ["home", 2000]]) for (const row of box[`${side}Hitting`].hitters) row.identity = { playerId: String(base + row.order), name: row.name };
  return { game: official, box, lineups: { awayLineup: box.awayHitting.initialLineup, homeLineup: box.homeHitting.initialLineup } };
}
function replay(records, from = "20260402", to = "20260404") { return replayHistoricalGames(records, { from, to, now: NOW }); }

test("unknown official event and missing inning/count rows reject rather than silently zero-filling", () => {
  assert.throws(() => parseBattingEvent("새로운결과"), (error) => error.code === "HISTORICAL_EVENT_UNKNOWN");
  for (const corrupt of [
    (box) => { box.arrHitter[0].table2.rows[0].row[0].Text = "미확인안타"; },
    (box) => { box.arrHitter[0].table2.rows[0].row.pop(); },
    (box) => { delete box.arrHitter[0].table2.rows[0].row[8].Text; },
    (box) => { box.arrHitter[0].table3.rows[0].row[0].Text = ""; },
    (box) => { box.arrHitter[0].table3.tfoot = []; },
    (box) => { box.arrPitcher[0].table.rows.pop(); },
  ]) { const box = payload(); corrupt(box); assert.throws(() => parseHistoricalBox(box, game("20260401"))); }
});

test("batting event totals audit official AB, hits, strikeouts, walks and pitcher BF", () => {
  const box = payload(); box.arrHitter[0].table2.rows[0].row[0].Text = "좌홈";
  assert.throws(() => parseHistoricalBox(box, game("20260401")), (error) => error.code === "HISTORICAL_EVENT_RECONCILIATION_FAILED");
  const parsed = parseHistoricalBox(payload(), game("20260401"));
  assert.equal(parsed.awayHitting.totals.pa, 36);
  assert.equal(parsed.awayHitting.totals.tb, 9);
  assert.equal(parsed.awayHitting.totals.strikeouts, 9);
  const triple = payload(); triple.arrHitter[0].table2.rows[0].row[2].Text = "3삼중";
  assert.deepEqual(parseHistoricalBox(triple, game("20260401")).awayHitting.totals, parsed.awayHitting.totals);
});

test("initial lineup retains first slot occupant, never later replacement or final AVG", () => {
  const box = payload(), side = box.arrHitter[0];
  side.table1.rows.splice(1, 0, wrap([1, "주중", "대주자"]));
  side.table2.rows.splice(1, 0, wrap(Array(9).fill("&nbsp;")));
  side.table3.rows.splice(1, 0, wrap([0, 0, 0, 0, "1.000"]));
  const parsed = parseHistoricalBox(box, game("20260401"));
  assert.equal(parsed.awayHitting.initialLineup[0].name, "원정1");
  assert.equal(parsed.awayHitting.hitters[1].pa, 0);
  assert.equal(parsed.awayHitting.hitters[0].ops, undefined);
  side.table3.rows[0].row[4].Text = "not-a-current-stat";
  assert.deepEqual(parseHistoricalBox(box, game("20260401")), parsed);
});

test("same-team namesakes keep league totals auditable without inventing individual IDs", () => {
  const box = payload(), side = box.arrHitter[0];
  side.table1.rows.splice(1, 0, wrap([1, "주중", "원정2"]));
  side.table2.rows.splice(1, 0, wrap(Array(9).fill("&nbsp;")));
  side.table3.rows.splice(1, 0, wrap([0, 0, 0, 0, ".000"]));
  const parsed = parseHistoricalBox(box, game("20260401"));
  assert.equal(parsed.awayHitting.totals.ab, 36);
  assert.equal(parsed.awayHitting.hitters.filter((row) => row.name === "원정2").length, 2);
  assert.equal(parsed.awayHitting.initialLineup[1].name, "원정2");
});

test("future rows and target outcome cannot change target inputs; target outcome remains only a label", () => {
  const records = [record("20260401"), record("20260402"), record("20260403"), record("20260404")];
  const baseline = replay(records);
  const changed = structuredClone(records);
  changed[2].game.T_SCORE_CN = "12"; changed[2].box.awayScore = 12;
  changed[2].box.awayHitting.totals.runs = 12; changed[2].box.awayHitting.hitters[0].runs = 12;
  changed[2].box.home.totals.runs = 12; changed[2].box.home.totals.earnedRuns = 12;
  changed[2].box.home.rows[0].runs = 11; changed[2].box.home.rows[0].earnedRuns = 11;
  changed[3].box.awayHitting.hitters[0].tb = 100;
  const alternate = replay(changed);
  for (const date of ["20260402", "20260403"]) assert.deepEqual(alternate.snapshots.find((row) => row.gameDate === date), baseline.snapshots.find((row) => row.gameDate === date));
  assert.equal(alternate.results.find((row) => row.gameDate === "20260403").awayScore, 12);
  const target = baseline.snapshots.find((row) => row.gameDate === "20260403");
  assert.equal(target.awayLineup[0].ab, 8);
  assert.equal(target.sourceThroughDate, "20260402");
  assert.equal(target.modelInputs.diagnostics.league.counts.hitting.games, 4);
  assert.equal(target.modelInputs.dataAsOf, "2026-04-02T15:00:00.000Z");
});

test("same-date games are all reconstructed before accumulation and doubleheaders are excluded", () => {
  const first = record("20260401"), dh1 = record("20260402", { G_ID: "20260402HTLG1", HEADER_NO: 1 }), dh2 = record("20260402", { G_ID: "20260402HTLG2", HEADER_NO: 2 });
  const result = replay([first, dh2, dh1], "20260402", "20260402");
  assert.equal(result.snapshots.length, 0);
  assert.equal(result.summary.reasons.DOUBLEHEADER_TIMING_UNPROVEN, 2);
});

test("starter role sample and last-five expected innings use observed starts only", () => {
  const records = [1, 2, 3, 4, 5, 6, 7].map((day) => record(`2026040${day}`));
  for (let i = 0; i < 6; i += 1) {
    records[i].box.away.rows[0].outs = 3 * (i + 1);
    records[i].box.away.rows[1].outs = 27 - records[i].box.away.rows[0].outs;
  }
  const result = replay(records, "20260407", "20260407").snapshots[0];
  assert.equal(result.awayStarter.starts, 6);
  assert.equal(result.awayStarter.outs, 63);
  assert.equal(result.awayStarter.expectedInnings, 4);
  assert.equal(result.awayStarter.recentStarts[0].date, "20260402");
  assert.equal(result.modelInputs.diagnostics.away.bullpen.pitches3d, 120);
});

test("historical provenance is training-only, and no prior sample is invented", () => {
  const result = replay([record("20260401"), record("20260402")], "20260401", "20260402");
  assert.equal(result.summary.reasons.HITTER_SAMPLE_UNAVAILABLE, 1);
  const row = result.snapshots[0];
  assert.equal(row.mode, "historical_reconstruction");
  assert.equal(row.dataOrigin, "historical_reconstruction");
  assert.equal(row.asOfTimestamp, NOW.toISOString());
  assert.equal(isPregameSnapshot(row), false);
});

test("an observed hitless batting sample retains zero OPS and uses live-equivalent league shrinkage", () => {
  const prior = record("20260401");
  prior.box.awayHitting.hitters[0].h = 0;
  prior.box.awayHitting.hitters[0].tb = 0;
  prior.box.awayHitting.totals.h -= 1;
  prior.box.awayHitting.totals.tb -= 1;
  prior.box.home.totals.hits -= 1;
  prior.box.home.rows[0].hits -= 1;
  const row = replay([prior, record("20260402")], "20260402", "20260402").snapshots[0];
  assert.equal(row.awayLineup[0].ops, 0);
  assert.equal(row.awayLineup[0].adjustedOps, row.modelInputs.diagnostics.league.ops * 100 / 104);
});

test("incomplete/suspended prior workload excludes targets rather than treating absent pitches as zero", () => {
  const unresolved = { game: game("20260402", { GAME_STATE_SC: "5", CANCEL_SC_NM: "서스펜디드" }) };
  const result = replay([record("20260401"), unresolved, record("20260403")], "20260403", "20260403");
  assert.equal(result.snapshots.length, 0);
  assert.equal(result.summary.exclusions[0].reason, "WORKLOAD_DATE_UNPROVEN");
});

test("unproven prior games still exclude cumulative features after the bullpen window expires", () => {
  const unresolved = { game: game("20260402", { GAME_STATE_SC: "5", CANCEL_SC_NM: "서스펜디드" }) };
  const result = replayHistoricalGames([record("20260401"), unresolved, record("20260419")], { from: "20260419", to: "20260419", now: NOW });
  assert.equal(result.snapshots.length, 0);
  assert.equal(result.summary.exclusions[0].reason, "HISTORICAL_CUMULATIVE_INCOMPLETE");
});

test("completed doubleheaders accumulate into subsequent league/player/bullpen totals", () => {
  const records = [record("20260401"), record("20260402", { G_ID: "20260402HTLG1", HEADER_NO: 1 }), record("20260402", { G_ID: "20260402HTLG2", HEADER_NO: 2 }), record("20260403")];
  const result = replay(records, "20260403", "20260403").snapshots[0];
  assert.equal(result.modelInputs.diagnostics.league.counts.hitting.games, 6);
  assert.equal(result.modelInputs.diagnostics.league.counts.teams.HT.games, 3);
  assert.equal(result.awayLineup[0].ab, 12);
  assert.equal(result.modelInputs.diagnostics.away.bullpen.pitches3d, 120);
});

test("historical hitter ID ignores current roster team, but never merges ambiguous names", () => {
  const candidate = (id, team) => ({ P_ID: id, P_NM: "이적타자", POS_NO: "내야수", T_ID: team, P_LINK: `/Record/Player/HitterDetail/Basic.aspx?playerId=${id}` });
  assert.equal(hitterIdentity({ code: "100", now: [candidate(99, "LG")], retire: [] }, "이적타자").playerId, "99");
  assert.equal(hitterIdentity({ code: "100", now: [candidate(99, "LG"), candidate(100, "HT")], retire: [] }, "이적타자").exclusion, "PLAYER_IDENTITY_AMBIGUOUS");
  const futures = candidate(101, "LT"); futures.P_LINK = "/Futures/Player/HitterDetail.aspx?playerId=101";
  assert.equal(hitterIdentity({ code: "100", now: [futures], retire: [] }, "이적타자").playerId, "101");
});
