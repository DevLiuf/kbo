const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const execFile = require("util").promisify(require("child_process").execFile);
const { isPregameSnapshot, isHistoricalTrainingSnapshot, isTrainingSnapshot } = require("../lib/prediction-contract");
const { buildExamples } = require("../scripts/build-training-examples");
const { eligibleExamples, validateExample } = require("../scripts/score-training-utils");
const { trainModel } = require("../scripts/train-score-model");
const { MODEL_TYPE, predictGame } = require("../lib/score-model");
const { joinArchivedPredictions } = require("../lib/backtest");
const { ndjson, shiftDate } = require("../lib/artifacts");
const { snapshot, result, archive } = require("./count-fixtures");

function historicalSnapshot(date = "20260401", key = "historical", overrides = {}) {
  const live = snapshot(date, key);
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const inputsCutoffAt = new Date(`${iso}T00:00:00+09:00`).toISOString();
  const lineup = (side) => Array.from({ length: 9 }, (_, index) => ({ order: index + 1, name: `${side}-${index + 1}`, position: "DH" }));
  return { ...live, gameState: "3", mode: "historical_reconstruction", dataOrigin: "historical_reconstruction",
    asOfTimestamp: "2026-10-02T12:00:00.000Z", reconstructedAt: "2026-10-02T12:00:00.000Z",
    sourceThroughDate: shiftDate(date, -1), inputsCutoffAt,
    modelInputs: { ...live.modelInputs, dataAsOf: inputsCutoffAt },
    awayLineup: lineup("away"), homeLineup: lineup("home"), ...overrides };
}

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kbo-historical-training-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("historical training requires prior-day cutoff, actual reconstruction provenance and nine initial slots", () => {
  const row = historicalSnapshot();
  assert.equal(isHistoricalTrainingSnapshot(row), true);
  assert.equal(isTrainingSnapshot(row), true);
  assert.equal(isPregameSnapshot(row), false);
  const invalid = [
    { dataOrigin: undefined }, { mode: "post_lineup" }, { featureSchemaVersion: 2 },
    { gameState: "1" }, { trainingEligible: false }, { lineupConfirmed: false },
    { gameId: "different" }, { gameDate: "20260230" },
    { awayTeam: undefined }, { homeTeam: " " },
    { sourceThroughDate: "20260401" }, { sourceThroughDate: "20261002" }, { sourceThroughDate: "20260230" },
    { inputsCutoffAt: "2026-04-01T00:00:00.000Z", modelInputs: { ...row.modelInputs, dataAsOf: "2026-04-01T00:00:00.000Z" } },
    { modelInputs: { ...row.modelInputs, dataAsOf: row.asOfTimestamp } },
    { modelInputs: { ...row.modelInputs, home: { ...row.modelInputs.home, pitchingFipRatio: 0 } } },
    { gameStartsAt: "2026-04-02T09:00:00.000Z" },
    { asOfTimestamp: row.gameStartsAt, reconstructedAt: row.gameStartsAt },
    { asOfTimestamp: "2026-04-01T08:00:00.000Z", reconstructedAt: "2026-04-01T08:00:00.000Z" },
    { asOfTimestamp: "2099-01-01T00:00:00.000Z", reconstructedAt: "2099-01-01T00:00:00.000Z" },
    { asOfTimestamp: "2026-02-30T12:00:00.000Z", reconstructedAt: "2026-02-30T12:00:00.000Z" },
    { asOfTimestamp: "2026-10-02T12:00:00", reconstructedAt: "2026-10-02T12:00:00" },
    { reconstructedAt: "2026-10-02T12:00:01.000Z" },
    { awayLineup: row.awayLineup.slice(0, 8) },
    { homeLineup: row.homeLineup.map((slot, index) => index === 8 ? { ...slot, order: 8 } : slot) },
    { awayLineup: row.awayLineup.map((slot, index) => index === 8 ? { ...slot, name: row.awayLineup[0].name } : slot) },
  ];
  for (const overrides of invalid) {
    assert.equal(isHistoricalTrainingSnapshot({ ...row, ...overrides }), false, JSON.stringify(overrides));
  }
});

test("historical markers cannot forge an issued pregame snapshot even with pregame timing and mode", () => {
  const live = snapshot("20260401", "game");
  assert.equal(isPregameSnapshot(live), true);
  assert.equal(isPregameSnapshot({ ...live, dataOrigin: "historical_reconstruction" }), false);
  assert.equal(isPregameSnapshot({ ...live, reconstructedAt: "2026-10-02T12:00:00.000Z" }), false);
  assert.equal(isPregameSnapshot({ ...live, inputsCutoffAt: "2026-03-31T15:00:00.000Z" }), false);
  assert.equal(isPregameSnapshot({ ...live, sourceThroughDate: "20260331" }), false);
  assert.equal(isPregameSnapshot({ ...live, reconstructedAt: undefined }), false);
  assert.equal(isTrainingSnapshot({ ...historicalSnapshot(), mode: "post_lineup", gameState: "1",
    asOfTimestamp: live.asOfTimestamp }), false);
});

test("mixed archives prefer the latest live snapshot regardless of reconstruction time and preserve historical provenance", () => {
  const early = snapshot("20260401", "shared");
  const live = snapshot("20260401", "shared", { asOfTimestamp: "2026-04-01T08:59:00.000Z" });
  const historical = historicalSnapshot("20260401", "historical");
  const older = historicalSnapshot("20260401", "historical", {
    asOfTimestamp: "2026-10-01T12:00:00.000Z", reconstructedAt: "2026-10-01T12:00:00.000Z",
  });
  const rows = [historicalSnapshot("20260401", "shared"), older, historical,
    historicalSnapshot("20260401", "invalid", { sourceThroughDate: "20260401" })];
  const outcomes = [result("20260401", "shared"), result("20260401", "historical", 0, 0), result("20260401", "invalid")];
  const built = buildExamples([early, live], outcomes, { historical: rows });
  assert.deepEqual(built.examples.map((row) => row.gameKey), ["historical", "shared"]);
  const [reconstructed, issued] = built.examples;
  assert.equal(issued.mode, "post_lineup");
  assert.equal(issued.asOfTimestamp, live.asOfTimestamp);
  assert.deepEqual(issued.modelInputs, live.modelInputs);
  for (const field of ["dataOrigin", "reconstructedAt", "inputsCutoffAt", "sourceThroughDate", "awayLineup", "homeLineup", "modelInputs"]) {
    assert.deepEqual(reconstructed[field], historical[field]);
  }
  assert.equal(reconstructed.homeScore, 0);
  assert.equal(reconstructed.awayScore, 0);
  assert.equal(isPregameSnapshot(reconstructed), false);
  assert.equal(validateExample(reconstructed), true);
  assert.deepEqual(eligibleExamples(built.examples), built.examples);
  assert.throws(() => eligibleExamples([{ ...reconstructed, sourceThroughDate: reconstructed.gameDate }]));
  assert.equal(built.summary.historicalInputs, 4);
  assert.equal(built.summary.historicalExamples, 1);
  assert.equal(built.summary.liveExamples, 1);
  assert.equal(built.summary.exclusions.invalidHistoricalSnapshot, 1);
});

test("training joins historical outcomes only when official game IDs and dates match", () => {
  const historical = [historicalSnapshot("20260401", "date-mismatch"), historicalSnapshot("20260401", "id-mismatch"),
    historicalSnapshot("20260401", "unmatched")];
  const built = buildExamples([], [result("20260402", "date-mismatch"),
    { ...result("20260401", "id-mismatch"), gameId: "other" }], { historical });
  assert.deepEqual(built.examples, []);
  assert.equal(built.summary.exclusions.dateMismatch, 1);
  assert.equal(built.summary.exclusions.idMismatch, 1);
});

test("the existing count model fits validated historical games without a live pregame archive", () => {
  const fixtures = archive();
  const historical = fixtures.snapshots.map((live) => {
    const row = historicalSnapshot(live.gameDate, live.gameKey);
    return { ...row, modelInputs: { ...live.modelInputs, dataAsOf: row.inputsCutoffAt } };
  });
  const { examples } = buildExamples([], fixtures.results, { historical });
  const model = trainModel(examples, { epochs: 200, holdoutDays: 1 });
  assert.deepEqual(model.trainingRange, { from: "20260401", to: "20260405" });
  assert.deepEqual(model.validationRange, { from: "20260406", to: "20260406" });
  assert.equal(model.validationIndependent, true);
  const prediction = predictGame(model, examples[0].modelInputs);
  assert.ok(prediction.expectedHomeRuns > prediction.expectedAwayRuns);
});

test("historical training never joins the original-issued prediction backtest or displaces its live row", () => {
  const prediction = { status: "ready", modelType: MODEL_TYPE, predictedWinner: "HOME",
    predictedAwayScore: 3, predictedHomeScore: 5, expectedAwayRuns: 3.5, expectedHomeRuns: 5.5,
    homeWinProbability: 0.7, awayWinProbability: 0.3, tieAfterNineProbability: 0.1 };
  const live = snapshot("20260401", "game", prediction);
  const retrospective = historicalSnapshot("20260401", "game", prediction);
  const outcomes = [result("20260401", "game")];
  assert.deepEqual(joinArchivedPredictions([retrospective], outcomes), []);
  assert.deepEqual(joinArchivedPredictions([live, retrospective], outcomes), joinArchivedPredictions([live], outcomes));
  assert.deepEqual(joinArchivedPredictions([{ ...retrospective, mode: "post_lineup", gameState: "1",
    asOfTimestamp: live.asOfTimestamp }], outcomes), []);
});

test("builder CLI treats an absent default historical archive as optional but explicit missing paths fail atomically", async (t) => {
  const directory = await temporary(t);
  const snapshotsPath = path.join(directory, "snapshots.ndjson");
  const resultsPath = path.join(directory, "results.ndjson");
  const outputPath = path.join(directory, "examples.ndjson");
  await fs.writeFile(snapshotsPath, ndjson([snapshot("20260401", "live")]));
  await fs.writeFile(resultsPath, ndjson([result("20260401", "live")]));
  const args = [path.join(__dirname, "..", "scripts", "build-training-examples.js"),
    `--snapshots=${snapshotsPath}`, `--results=${resultsPath}`, `--output=${outputPath}`];
  const { stdout } = await execFile(process.execPath, args, { cwd: directory });
  assert.equal(JSON.parse(stdout).historicalInputs, 0);
  const previous = await fs.readFile(outputPath, "utf8");
  assert.deepEqual(previous.trim().split("\n").map(JSON.parse).map((row) => row.gameKey), ["live"]);
  await assert.rejects(execFile(process.execPath, [...args, `--historical=${path.join(directory, "missing.ndjson")}`], { cwd: directory }));
  assert.equal(await fs.readFile(outputPath, "utf8"), previous);
});

test("builder CLI bootstraps without a live archive and loads default or explicit historical inputs", async (t) => {
  const directory = await temporary(t);
  await fs.mkdir(path.join(directory, "data"));
  const resultsPath = path.join(directory, "results.ndjson");
  const outputPath = path.join(directory, "examples.ndjson");
  await fs.writeFile(resultsPath, ndjson([result("20260401", "default"), result("20260401", "explicit")]));
  await fs.writeFile(path.join(directory, "data", "historical_inputs.kbo.ndjson"), ndjson([historicalSnapshot("20260401", "default")]));
  const explicitPath = path.join(directory, "alternative.ndjson");
  await fs.writeFile(explicitPath, ndjson([historicalSnapshot("20260401", "explicit")]));
  const args = [path.join(__dirname, "..", "scripts", "build-training-examples.js"),
    `--results=${resultsPath}`, `--output=${outputPath}`];
  await execFile(process.execPath, args, { cwd: directory });
  const defaultRows = (await fs.readFile(outputPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(defaultRows.map((row) => row.gameKey), ["default"]);
  const { stdout } = await execFile(process.execPath, [...args, `--historical=${explicitPath}`], { cwd: directory });
  assert.equal(JSON.parse(stdout).historicalExamples, 1);
  const explicitRows = (await fs.readFile(outputPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(explicitRows.map((row) => row.gameKey), ["explicit"]);
  assert.equal(explicitRows[0].dataOrigin, "historical_reconstruction");
  const previous = await fs.readFile(outputPath, "utf8");
  await assert.rejects(execFile(process.execPath, [...args, `--snapshots=${path.join(directory, "missing.ndjson")}`], { cwd: directory }));
  assert.equal(await fs.readFile(outputPath, "utf8"), previous);
});
