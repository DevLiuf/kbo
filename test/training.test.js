const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { promisify } = require("util");
const execFile = promisify(require("child_process").execFile);
const { FEATURE_NAMES, linearScore, calibratedProbability, validateExample } = require("../lib/logistic");
const { buildExamples } = require("../scripts/build-training-examples");
const { trainModel } = require("../scripts/train-logistic");
const { evaluateModel } = require("../scripts/eval-logistic");
const { parseScore, resultFromGame } = require("../scripts/fetch-results");
const script = (name) => path.join(__dirname, "..", "scripts", name);

function features(overrides = {}) {
  return { ...Object.fromEntries(FEATURE_NAMES.map((name) => [name, 0])), ...overrides };
}

function snapshot(gameDate, key, overrides = {}) {
  const iso = `${gameDate.slice(0, 4)}-${gameDate.slice(4, 6)}-${gameDate.slice(6, 8)}`;
  return { gameKey: key, gameDate, gameState: "1", featureSchemaVersion: 2,
    gameStartsAt: `${iso}T09:00:00.000Z`, asOfTimestamp: `${iso}T08:00:00.000Z`,
    features: features(), ...overrides };
}

function result(gameDate, key, homeScore = 5, awayScore = 2) {
  return { gameKey: key, gameId: key, gameDate, homeTeam: "HOME", awayTeam: "AWAY", completed: true, homeScore, awayScore };
}

function examples() {
  const snapshots = [];
  const results = [];
  for (const date of ["20260401", "20260402", "20260403", "20260404"]) {
    for (let i = 0; i < 4; i += 1) {
      const key = `${date}-${i}`;
      const homeWin = i % 2 === 0;
      snapshots.push(snapshot(date, key, { features: features({ defenseDiff: homeWin ? 1.23456789 : -1.23456789,
        lineupWarDiff: homeWin ? 0.77777777 : -0.77777777 }) }));
      results.push(result(date, key, homeWin ? 5 : 2, homeWin ? 2 : 5));
    }
  }
  return buildExamples(snapshots, results).examples;
}

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kbo-training-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeRows(file, rows) {
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

test("score parsing distinguishes missing values and zero, with no winner for draws", () => {
  for (const missing of [null, undefined, "", "  ", false, NaN, Infinity]) assert.equal(parseScore(missing), null);
  assert.equal(parseScore("0"), 0);
  assert.equal(parseScore(0), 0);
  const game = { G_ID: "draw", GAME_STATE_SC: "3", B_SCORE_CN: "0", T_SCORE_CN: "0", HOME_NM: "HOME", AWAY_NM: "AWAY" };
  assert.equal(resultFromGame(game, "20260401").winner, null);
  assert.equal(resultFromGame(game, "20260401").completed, true);
  assert.equal(resultFromGame({ ...game, B_SCORE_CN: null }, "20260401").completed, false);
});

test("fetch CLI merges incremental games without deleting older dates", async (t) => {
  const directory = await temporary(t);
  const output = path.join(directory, "results.ndjson");
  await writeRows(output, [result("20260401", "old"), result("20260402", "updated", 1, 3)]);
  const preload = path.join(directory, "fetch-fixture.cjs");
  await fs.writeFile(preload, `global.fetch = async () => ({ok: true, text: async () => JSON.stringify({game: [
    {G_ID:'updated',G_DT:'20260402',GAME_STATE_SC:'3',B_SCORE_CN:'4',T_SCORE_CN:'4',HOME_NM:'HOME',AWAY_NM:'AWAY'},
    {G_ID:'missing',G_DT:'20260402',GAME_STATE_SC:'3',B_SCORE_CN:null,T_SCORE_CN:'',HOME_NM:'HOME',AWAY_NM:'AWAY'}]})});`);
  await execFile(process.execPath, ["--require", preload, script("fetch-results.js"), "--from=20260402", `--output=${output}`], { cwd: directory });
  const rows = (await fs.readFile(output, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.find((row) => row.gameKey === "old"), result("20260401", "old"));
  assert.equal(rows.find((row) => row.gameKey === "updated").winner, null);
  assert.equal(rows.find((row) => row.gameKey === "updated").homeScore, 4);
  assert.equal(rows.find((row) => row.gameKey === "missing").completed, false);
});

test("builder chooses last strictly pre-start schema2 snapshot and preserves unrounded raw features", () => {
  const original = snapshot("20260401", "game", { features: features({ defenseDiff: -1.234567890123,
    runCreationResidualDiff: 0.9876543210123, powerContactMixDiff: -0.333333333333, lineupSignal: 0.375, lineupWarDiff: -0.123456789 }) });
  const latest = { ...original, asOfTimestamp: "2026-04-01T08:59:59.999Z" };
  const postStart = { ...original, asOfTimestamp: original.gameStartsAt, features: features({ defenseDiff: 99 }) };
  const old = snapshot("20260401", "old", { featureSchemaVersion: 1 });
  const live = snapshot("20260401", "live", { gameState: "2" });
  const { examples: rows, summary } = buildExamples([original, latest, postStart, old, live],
    [result("20260401", "game"), result("20260401", "old"), result("20260401", "live")]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].asOfTimestamp, latest.asOfTimestamp);
  for (const name of FEATURE_NAMES) assert.equal(rows[0][name], latest.features[name]);
  assert.equal(rows[0].featureSchemaVersion, 2);
  assert.equal(rows[0].gameStartsAt, original.gameStartsAt);
  assert.equal(summary.exclusions.invalidSnapshot, 3);
  assert.equal(summary.exclusions.missingPregameSnapshot, 2);
});

test("builder excludes draws, nonfinite scores and out-of-range results", () => {
  const snapshots = ["draw", "missing", "before", "decisive"].map((key) => snapshot("20260402", key));
  const built = buildExamples(snapshots, [result("20260402", "draw", 3, 3), result("20260402", "missing", null, 2),
    result("20260401", "before"), result("20260402", "decisive", 2, 5)], { from: "20260402", to: "20260402" });
  assert.deepEqual(built.examples.map((row) => [row.gameKey, row.labelHomeWin]), [["decisive", 0]]);
  assert.equal(built.summary.exclusions.draw, 1);
  assert.equal(built.summary.exclusions.invalidScore, 1);
  assert.equal(built.summary.exclusions.outOfRange, 1);
});

test("train/calibration/test dates are disjoint and test changes cannot alter fitted model", () => {
  const rows = examples();
  const model = trainModel(rows, { epochs: 40 });
  assert.deepEqual(model.trainingRange, { from: "20260401", to: "20260402" });
  assert.deepEqual(model.calibrationRange, { from: "20260403", to: "20260403" });
  assert.deepEqual(model.validationRange, { from: "20260404", to: "20260404" });
  const altered = rows.map((row) => row.gameDate === "20260404"
    ? { ...row, defenseDiff: 100, labelHomeWin: 1 - row.labelHomeWin, homeScore: row.awayScore, awayScore: row.homeScore } : row);
  const next = trainModel(altered, { epochs: 40 });
  for (const name of [...FEATURE_NAMES, "intercept", "plattA", "plattB", "temperature"]) assert.equal(next[name], model[name]);
  assert.notEqual(next.metrics.validation.logLoss, model.metrics.validation.logLoss);
  assert.equal(model.metrics.validation.samples, 4);
  assert.equal(model.calibrationSamples, 4);
  assert.ok(model.defenseDiff > 0);
  assert.ok(model.lineupWarDiff > 0);
  assert.ok(calibratedProbability(model, features({ defenseDiff: 1 })) > calibratedProbability(model, features({ defenseDiff: -1 })));
});

test("calibration labels cannot change learned feature coefficients", () => {
  const rows = examples();
  const model = trainModel(rows, { epochs: 40 });
  const changed = rows.map((row) => row.gameDate === "20260403"
    ? { ...row, labelHomeWin: 1 - row.labelHomeWin, homeScore: row.awayScore, awayScore: row.homeScore } : row);
  const next = trainModel(changed, { epochs: 40 });
  for (const name of [...FEATURE_NAMES, "intercept"]) assert.equal(next[name], model[name]);
  assert.notEqual(next.plattA, model.plattA);
});

test("training refuses row splits, invalid labels/schema and inadequate calibration", () => {
  const rows = examples();
  assert.throws(() => trainModel(rows.filter((row) => row.gameDate === "20260401")), /Insufficient dates/);
  assert.throws(() => trainModel(rows, { holdoutDays: 3, calibrationDays: 1 }), /Insufficient dates/);
  assert.throws(() => trainModel(rows.map((row) => row.gameDate === "20260403"
    ? { ...row, labelHomeWin: 1, homeScore: 5, awayScore: 2 } : row)), /both labels/);
  assert.throws(() => trainModel([{ ...rows[0], featureSchemaVersion: 1 }, ...rows.slice(1)]), /Invalid schema/);
  assert.throws(() => trainModel([{ ...rows[0], labelHomeWin: null }, ...rows.slice(1)]), /Invalid schema/);
  assert.throws(() => trainModel(rows, { from: "20260230" }), /valid YYYYMMDD/);
  assert.throws(() => trainModel([{ ...rows[0], gameDate: "20260230" }, ...rows.slice(1)], { from: "20260401" }), /Invalid labeled example gameDate/);
  assert.equal(validateExample({ ...rows[0], asOfTimestamp: rows[0].gameStartsAt }), false);
  assert.equal(validateExample({ ...rows[0], homeScore: rows[0].awayScore }), false);
});

test("evaluation defaults to final test dates and uses the same calibrated math", () => {
  const rows = examples();
  const model = trainModel(rows, { epochs: 30 });
  const report = evaluateModel(model, rows);
  assert.equal(report.samples, 4);
  assert.deepEqual(report.range, model.validationRange);
  assert.equal(report.logLoss, model.metrics.validation.logLoss);
  assert.equal(report.brier, model.metrics.validation.brier);
  const testRow = rows.find((row) => row.gameDate === model.validationRange.from);
  const expected = 1 / (1 + Math.exp(-(model.plattA * linearScore(model, testRow) + model.plattB) / model.temperature));
  assert.equal(calibratedProbability(model, testRow), expected);
  assert.throws(() => evaluateModel(model, [{ ...testRow, labelHomeWin: null }]), /Invalid schema/);
  assert.equal(evaluateModel(model, rows, { from: "20260401", to: "20260401" }).samples, 4);
});

test("failed training CLI never replaces an existing model", async (t) => {
  const directory = await temporary(t);
  const input = path.join(directory, "examples.ndjson");
  const output = path.join(directory, "model.json");
  await writeRows(input, examples().filter((row) => row.gameDate === "20260401"));
  await fs.writeFile(output, "existing-model-bytes\n");
  await assert.rejects(execFile(process.execPath, [script("train-logistic.js"), `--input=${input}`, `--output=${output}`, "--epochs=2"], { cwd: directory }), /Insufficient dates/);
  assert.equal(await fs.readFile(output, "utf8"), "existing-model-bytes\n");
});

test("offline walk-forward scores only future stored games without modifying active artifacts", async (t) => {
  const directory = await temporary(t);
  const input = path.join(directory, "examples.ndjson");
  const data = path.join(directory, "data");
  const outDir = path.join(directory, "backtests");
  await fs.mkdir(data);
  const model = path.join(data, "model_coefficients.kbo.json");
  const activeBytes = "active-model-must-not-change\n";
  await fs.writeFile(model, activeBytes);
  await writeRows(input, examples());
  const inputBytes = await fs.readFile(input, "utf8");
  const preload = path.join(directory, "network-forbidden.cjs");
  await fs.writeFile(preload, "global.fetch = () => { throw new Error('Network forbidden in offline evaluation'); }; require('http').get = require('https').get = global.fetch;");
  await execFile(process.execPath, ["--require", preload, script("walk-forward-eval.js"), "--from=20260404", "--to=20260404",
    `--input=${input}`, `--outDir=${outDir}`, "--minExamples=8", "--epochs=20"], { cwd: directory });
  const report = JSON.parse(await fs.readFile(path.join(outDir, "walk_forward_20260404_20260404.summary.json"), "utf8"));
  assert.equal(report.overall.games, 4);
  assert.equal(report.skippedEvalDays.length, 0);
  assert.equal(report.perDay[0].trainTo, "20260403");
  assert.ok(report.perDay[0].validationRange.to < "20260404");
  assert.equal(await fs.readFile(model, "utf8"), activeBytes);
  assert.equal(await fs.readFile(input, "utf8"), inputBytes);
});

test("malformed upstream result schema fails without replacing the result archive", async (t) => {
  const directory = await temporary(t);
  const output = path.join(directory, "results.ndjson");
  await writeRows(output, [result("20260401", "old")]);
  const previous = await fs.readFile(output, "utf8");
  const preload = path.join(directory, "invalid-result-response.cjs");
  await fs.writeFile(preload, "global.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ error: 'maintenance' }) });");
  await assert.rejects(execFile(process.execPath, ["--require", preload, script("fetch-results.js"),
    "--from=20260402", `--output=${output}`], { cwd: directory }), /Invalid KBO result response schema/);
  assert.equal(await fs.readFile(output, "utf8"), previous);
});
