const test = require("node:test");
const assert = require("node:assert/strict");
const { isPregameSnapshot } = require("../lib/prediction-contract");
const { blendSaberRuns, validateSaberSettings } = require("../lib/saber");

const snapshot = {
  featureSchemaVersion: 2,
  gameState: "1",
  gameDate: "20260401",
  asOfTimestamp: "2026-03-31T23:59:59.999Z",
  gameStartsAt: "2026-04-01T00:00:00.000Z",
  features: { offenseDiff: 0.1234 },
};

test("only scheduled snapshots strictly before the Seoul game start are eligible", () => {
  assert.equal(isPregameSnapshot(snapshot), true);
  assert.equal(isPregameSnapshot({ ...snapshot, asOfTimestamp: snapshot.gameStartsAt }), false);
  assert.equal(isPregameSnapshot({ ...snapshot, asOfTimestamp: "2026-04-01T00:00:00.001Z" }), false);
  assert.equal(isPregameSnapshot({ ...snapshot, gameState: "2" }), false);
  assert.equal(isPregameSnapshot({ ...snapshot, gameDate: "20260331" }), false);
  assert.equal(isPregameSnapshot({ ...snapshot, featureSchemaVersion: undefined }), false);
  assert.equal(isPregameSnapshot({ ...snapshot, gameStartsAt: null }), false);
});

test("saber blend uses the pre-blend baseline and rejects untrusted components", () => {
  const settings = { baseWeight: 0.5, markovWeight: 0.3, monteWeight: 0.2, clampThreshold: 2.5 };
  assert.equal(blendSaberRuns(5, 3, 4, settings), 4.2);
  assert.equal(blendSaberRuns(5, 8, 4, settings), 4.8);
  assert.equal(blendSaberRuns(5, null, null, settings), 5);
  assert.equal(blendSaberRuns(0, 0, 0, settings), 1.2);
  assert.equal(blendSaberRuns(20, 20, 20, settings), 10.5);
});

test("invalid tuning weights cannot become applied settings", () => {
  const invalid = { baseWeight: 0.7, markovWeight: 0.25, monteWeight: 0.1, clampThreshold: 3 };
  assert.equal(validateSaberSettings(invalid), false);
  assert.throws(() => blendSaberRuns(5, 3, 4, invalid), /Invalid saber/);
});
