const test = require("node:test");
const assert = require("node:assert/strict");
const { joinArchivedPredictions, calcBetOutcome, finiteNumber, loadBacktestRows } = require("../lib/backtest");

function snapshot(overrides = {}) {
  return { league: "kbo", gameId: "game1", gameDate: "20260901", gameState: "1",
    featureSchemaVersion: 2, asOfTimestamp: "2026-09-01T08:00:00Z", gameStartsAt: "2026-09-01T09:00:00Z",
    features: { winPctDiff: 0.1, runDiffDiff: 0.2, recentWinPctDiff: 0.1, starterEraDiff: -0.5, bullpenEraDiff: 0.1, homeAdvantage: 1 },
    awayTeam: "원정", homeTeam: "홈", predictedWinner: "홈", predictedAwayScore: 3, predictedHomeScore: 5,
    homeWinProbability: 0.7, awayWinProbability: 0.3, ...overrides };
}
function result(overrides = {}) {
  return { league: "kbo", gameId: "game1", gameDate: "20260901", completed: true, awayScore: 3, homeScore: 5, ...overrides };
}

test("draw keeps score evaluation but refunds a simulated bet instead of recording a loss", () => {
  const [row] = joinArchivedPredictions([snapshot()], [result({ awayScore: 4, homeScore: 4 })]);
  assert.equal(row.predictionHit, null);
  assert.equal(row.actualWinner, null);
  assert.equal(row.actualAwayScore, 4);
  assert.equal(row.actualHomeScore, 4);
  assert.deepEqual(calcBetOutcome({ stakeUnits: 2, odds: 1.9, winnerHit: row.predictionHit, isDraw: row.isDraw }),
    { placed: true, void: true, payoutUnits: 2, profitUnits: 0 });
  assert.equal(calcBetOutcome({ stakeUnits: 2, odds: 1.9, winnerHit: false }).profitUnits, -2);
  assert.equal(calcBetOutcome({ stakeUnits: 2, odds: 1.9, winnerHit: true }).profitUnits, 1.7999999999999998);
});

test("missing scores and incomplete results are not evaluated as zero-run games", () => {
  for (const missing of [null, undefined, "", "  ", false, "bad"]) {
    assert.equal(finiteNumber(missing), null);
    assert.deepEqual(joinArchivedPredictions([snapshot()], [result({ awayScore: missing })]), []);
  }
  assert.deepEqual(joinArchivedPredictions([snapshot()], [result({ completed: false })]), []);
  const [row] = joinArchivedPredictions([snapshot()], [result({ awayScore: 0, homeScore: 1 })]);
  assert.equal(row.actualAwayScore, 0);
  assert.equal(row.predictionHit, true);
});

test("only latest eligible pregame snapshot is joined, never a historical or post-start recomputation", () => {
  const early = snapshot({ asOfTimestamp: "2026-09-01T07:00:00Z", homeWinProbability: 0.6 });
  const latest = snapshot({ homeWinProbability: 0.75 });
  const invalid = [snapshot({ featureSchemaVersion: 1 }), snapshot({ gameState: "3" }),
    snapshot({ features: null }), snapshot({ asOfTimestamp: "2026-09-01T09:00:00Z" }),
    snapshot({ asOfTimestamp: "2026-10-01T00:00:00Z" })];
  assert.deepEqual(joinArchivedPredictions(invalid, [result()]), []);
  const [row] = joinArchivedPredictions([early, latest, ...invalid], [result()]);
  assert.equal(row.homeWinProbability, 0.75);
  assert.equal(row.asOfTimestamp, latest.asOfTimestamp);
  assert.deepEqual(joinArchivedPredictions([latest], [result({ league: "other" })]), []);
  assert.deepEqual(joinArchivedPredictions([latest], [result()], { from: "20260902", to: "20260903" }), []);
});

test("removed remote baseUrl is rejected before reading any archive", async () => {
  await assert.rejects(loadBacktestRows({ baseUrl: "http://localhost:3000" }), /no longer supported/);
});
