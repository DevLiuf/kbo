const test = require("node:test");
const assert = require("node:assert/strict");
const { MODEL_TYPE, predictGame, expectedRuns, validateModel, evaluateRows, poissonMass } = require("../lib/score-model");
const { isPregameSnapshot } = require("../lib/prediction-contract");

function model(overrides = {}) {
  return { modelType: MODEL_TYPE, featureSchemaVersion: 3, version: "fixture-count", intercept: 0,
    coefficients: { lineupOps: 1, pitchingFip: 1, bullpenWorkload: 0.1, park: 1, home: 0 }, ...overrides };
}
function inputs(overrides = {}) {
  const side = { lineupOpsRatio: 1, pitchingFipRatio: 1, bullpenWorkload: 0, parkRunFactor: 1 };
  return { leagueRunsPerGame: 4.5, away: { ...side, home: 0 }, home: { ...side, home: 1 },
    dataAsOf: "2026-04-01T08:00:00Z", ...overrides };
}

test("equal baseball inputs have no automatic home or lineup-announcement advantage", () => {
  const prediction = predictGame(model(), inputs());
  assert.ok(Math.abs(prediction.homeWinProbability - 0.5) < 1e-12);
  assert.equal(prediction.expectedHomeRuns, prediction.expectedAwayRuns);
  assert.ok(prediction.tieAfterNineProbability > 0 && prediction.tieAfterNineProbability < 0.5);
});

test("batting, opponent pitching, workload and park act on the scoring side without duplicate team differences", () => {
  const base = inputs();
  const changed = inputs({ home: { ...base.home, lineupOpsRatio: 1.2, pitchingFipRatio: 0.8, bullpenWorkload: 2, parkRunFactor: 1.1 } });
  assert.ok(Math.abs(expectedRuns(model(), changed, "home") - 4.5 * 1.2 * 0.8 * Math.exp(0.2) * 1.1) < 1e-12);
  assert.equal(expectedRuns(model(), changed, "away"), expectedRuns(model(), base, "away"));
  const strongerPitcher = inputs({ home: { ...base.home, pitchingFipRatio: 0.7 } });
  assert.ok(predictGame(model(), strongerPitcher).homeWinProbability < 0.5);
});

test("representative score can tie while expected runs and conditional winner favor one side", () => {
  const base = inputs({ leagueRunsPerGame: 4.2 });
  base.home.lineupOpsRatio = 4.8 / 4.2;
  const prediction = predictGame(model(), base);
  assert.equal(prediction.predictedAwayScore, 4);
  assert.equal(prediction.predictedHomeScore, 4);
  assert.ok(prediction.homeWinProbability > 0.5);
  assert.ok(Math.abs(prediction.expectedRunDiff - 0.6) < 1e-12);
});

test("Poisson support retains meaningful high-run mass instead of truncating at baseball display scores", () => {
  const masses = poissonMass(40);
  const mean = masses.reduce((sum, p, count) => sum + p * count, 0);
  const tail = masses.slice(41).reduce((sum, p) => sum + p, 0);
  assert.ok(Math.abs(mean - 40) < 1e-8);
  assert.ok(tail > 0.4 && tail < 0.5);
});

test("draw games affect score fit but never become away-win labels", () => {
  const rows = [
    { gameDate: "20260401", modelInputs: inputs(), homeScore: 4, awayScore: 4 },
    { gameDate: "20260402", modelInputs: inputs(), homeScore: 5, awayScore: 3 },
  ];
  const metrics = evaluateRows(model(), rows);
  assert.equal(metrics.samples, 2);
  assert.equal(metrics.drawGames, 1);
  assert.equal(metrics.decisiveGames, 1);
  assert.equal(metrics.brier, 0.25);
  assert.ok(Math.abs(metrics.logLoss - Math.log(2)) < 1e-12);
  assert.equal(metrics.mae, 0.75);
  const drawsOnly = evaluateRows(model(), rows.slice(0, 1));
  assert.equal(drawsOnly.logLoss, null);
  assert.equal(drawsOnly.accuracy, null);
  assert.ok(Number.isFinite(drawsOnly.poissonNll));
});

test("invalid or reverse skill effects and extreme home bias cannot load as a new model", () => {
  const badSkill = model(); badSkill.coefficients.pitchingFip = -0.1;
  const badHome = model(); badHome.coefficients.home = 0.31;
  assert.equal(validateModel(badSkill), false);
  assert.equal(validateModel(badHome), false);
  assert.equal(validateModel({ ...model(), modelType: "old-logistic" }), false);
  const missing = inputs(); missing.away.lineupOpsRatio = null;
  assert.throws(() => predictGame(model(), missing), /Invalid confirmed/);
});

test("first-model inputs can be archived without a forecast, but only after genuine lineup confirmation and before start", () => {
  const row = { featureSchemaVersion: 3, gameState: "1", mode: "post_lineup", lineupConfirmed: true,
    gameDate: "20260401", gameStartsAt: "2026-04-01T09:00:00Z", asOfTimestamp: "2026-04-01T08:30:00Z",
    modelInputs: inputs(), status: "unavailable", unavailableCode: "MODEL_NOT_TRAINED" };
  assert.equal(isPregameSnapshot(row), true);
  assert.equal(isPregameSnapshot({ ...row, lineupConfirmed: false }), false);
  assert.equal(isPregameSnapshot({ ...row, asOfTimestamp: row.gameStartsAt }), false);
  assert.equal(isPregameSnapshot({ ...row, gameState: "2" }), false);
  assert.equal(isPregameSnapshot({ ...row, modelInputs: { ...inputs(), dataAsOf: "2026-04-01T08:31:00Z" } }), false);
});
