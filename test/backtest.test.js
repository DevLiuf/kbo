const test = require("node:test");
const assert = require("node:assert/strict");
const { joinArchivedPredictions, finiteNumber, loadBacktestRows } = require("../lib/backtest");
const { MODEL_TYPE } = require("../lib/score-model");
const { snapshot: countSnapshot, result: countResult } = require("./count-fixtures");
function snapshot(overrides = {}) {
  return countSnapshot("20260901", "game1", { status: "ready", modelType: MODEL_TYPE,
    predictedWinner: "HOME", predictedAwayScore: 3, predictedHomeScore: 5, expectedAwayRuns: 3.5, expectedHomeRuns: 5.5,
    homeWinProbability: 0.7, awayWinProbability: 0.3, tieAfterNineProbability: 0.1, ...overrides });
}
function result(overrides = {}) { return { ...countResult("20260901", "game1", 5, 3), ...overrides }; }

test("draws retain count score evaluation but never count as decisive hits or losses", () => {
  const [row] = joinArchivedPredictions([snapshot()], [result({ awayScore: 4, homeScore: 4 })]);
  assert.equal(row.predictionHit, null);
  assert.equal(row.actualWinner, null);
  assert.equal(row.isDraw, true);
  assert.equal(row.actualAwayScore, 4);
  assert.equal(row.expectedAwayRuns, 3.5);
});

test("missing, fractional and incomplete outcomes are not interpreted as zero-run games", () => {
  for (const missing of [null, undefined, "", "  ", false, "bad"]) {
    assert.equal(finiteNumber(missing), null);
    assert.deepEqual(joinArchivedPredictions([snapshot()], [result({ awayScore: missing })]), []);
  }
  assert.deepEqual(joinArchivedPredictions([snapshot()], [result({ awayScore: 1.5 })]), []);
  assert.deepEqual(joinArchivedPredictions([snapshot()], [result({ completed: false })]), []);
  const [row] = joinArchivedPredictions([snapshot()], [result({ awayScore: 0, homeScore: 1 })]);
  assert.equal(row.actualAwayScore, 0);
  assert.equal(row.predictionHit, true);
});

test("only latest ready schema3 pregame count predictions join completed outcomes", () => {
  const early = snapshot({ asOfTimestamp: "2026-09-01T07:30:00Z", homeWinProbability: 0.6, awayWinProbability: 0.4 });
  const latest = snapshot({ homeWinProbability: 0.75, awayWinProbability: 0.25 });
  const invalid = [snapshot({ featureSchemaVersion: 2 }), snapshot({ gameState: "3" }), snapshot({ modelInputs: null }),
    snapshot({ lineupConfirmed: false }), snapshot({ status: "unavailable" }), snapshot({ modelType: "other" }),
    snapshot({ asOfTimestamp: "2026-09-01T09:00:00Z" }), snapshot({ homeWinProbability: 0.9 }), snapshot({ expectedHomeRuns: null })];
  assert.deepEqual(joinArchivedPredictions(invalid, [result()]), []);
  const [row] = joinArchivedPredictions([early, latest, ...invalid], [result()]);
  assert.equal(row.homeWinProbability, 0.75);
  assert.equal(row.asOfTimestamp, latest.asOfTimestamp);
  assert.deepEqual(joinArchivedPredictions([latest], [result({ league: "other" })]), []);
  assert.deepEqual(joinArchivedPredictions([latest], [result({ gameDate: "20260902" })]), []);
  assert.deepEqual(joinArchivedPredictions([latest], [result()], { from: "20260902", to: "20260903" }), []);
});

test("remote historical recomputation is rejected before any local archive reads", async () => {
  await assert.rejects(loadBacktestRows({ baseUrl: "http://localhost:3000" }));
});
