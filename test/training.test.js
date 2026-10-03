const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const execFile = require("util").promisify(require("child_process").execFile);
const { INPUT_NAMES, predictGame } = require("../lib/score-model");
const { validateExample } = require("../scripts/score-training-utils");
const { buildExamples } = require("../scripts/build-training-examples");
const { trainModel } = require("../scripts/train-score-model");
const { evaluateModel } = require("../scripts/eval-score-model");
const { parseScore, resultFromGame } = require("../scripts/fetch-results");
const { snapshot, result, examples } = require("./count-fixtures");
const { ndjson } = require("../lib/artifacts");
const script = (name) => path.join(__dirname, "..", "scripts", name);
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kbo-training-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("score parsing distinguishes missing values from zero and completed draws", () => {
  for (const missing of [null, undefined, "", "  ", false, NaN, Infinity]) assert.equal(parseScore(missing), null);
  assert.equal(parseScore("0"), 0);
  const game = { G_ID: "draw", GAME_STATE_SC: "3", B_SCORE_CN: "0", T_SCORE_CN: "0", HOME_NM: "HOME", AWAY_NM: "AWAY" };
  assert.equal(resultFromGame(game, "20260401").winner, null);
  assert.equal(resultFromGame(game, "20260401").completed, true);
  assert.equal(resultFromGame({ ...game, B_SCORE_CN: null }, "20260401").completed, false);
});

test("builder retains bootstrap unavailable inputs and draws but excludes invalid observations", () => {
  const early = snapshot("20260401", "game");
  const latest = snapshot("20260401", "game", { asOfTimestamp: "2026-04-01T08:59:59.999Z" });
  latest.modelInputs = { ...latest.modelInputs, leagueRunsPerGame: 4.1234567890123 };
  const invalid = [snapshot("20260401", "old", { featureSchemaVersion: 2 }), snapshot("20260401", "unconfirmed", { lineupConfirmed: false }),
    snapshot("20260401", "late", { asOfTimestamp: early.gameStartsAt }), snapshot("20260401", "absent", { modelInputs: null })];
  const built = buildExamples([early, latest, ...invalid, snapshot("20260401", "draw"), snapshot("20260401", "fraction")],
    [result("20260401", "game"), result("20260401", "draw", 0, 0), result("20260401", "fraction", 1.5, 2), ...invalid.map((row) => result(row.gameDate, row.gameKey))]);
  assert.deepEqual(built.examples.map((row) => row.gameKey), ["draw", "game"]);
  const row = built.examples.find((row) => row.gameKey === "game");
  assert.equal(row.asOfTimestamp, latest.asOfTimestamp);
  assert.deepEqual(row.modelInputs, latest.modelInputs);
  assert.equal(built.examples.find((example) => example.gameKey === "draw").homeScore, 0);
  assert.equal(built.summary.exclusions.invalidScore, 1);
});

test("chronological holdout cannot alter fitted coefficients or training-only baseline", () => {
  const rows = examples();
  const model = trainModel(rows, { epochs: 200, holdoutDays: 1 });
  const changed = rows.map((row) => row.gameDate === "20260406" ? { ...row, homeScore: row.homeScore + 7, awayScore: row.awayScore + 2 } : row);
  const next = trainModel(changed, { epochs: 200, holdoutDays: 1 });
  assert.deepEqual(model.trainingRange, { from: "20260401", to: "20260405" });
  assert.deepEqual(model.validationRange, { from: "20260406", to: "20260406" });
  assert.equal(next.intercept, model.intercept);
  assert.deepEqual(next.coefficients, model.coefficients);
  assert.equal(next.baseline.leagueRate, model.baseline.leagueRate);
  assert.equal(next.baseline.homeWinShare, model.baseline.homeWinShare);
  assert.notEqual(next.metrics.validation.poissonNll, model.metrics.validation.poissonNll);
  assert.equal(model.validationIndependent, true);
  assert.equal(model.metrics.validation.drawGames, 2);
  assert.equal(model.metrics.validation.decisiveGames, 6);
  assert.ok(model.coefficients.lineupOps > 0);
  for (const name of INPUT_NAMES.filter((name) => name !== "home")) assert.ok(model.coefficients[name] >= 0);
  assert.ok(Math.abs(model.coefficients.home) <= 0.3);
  const high = predictGame(model, rows[0].modelInputs);
  assert.ok(high.expectedHomeRuns > high.expectedAwayRuns);
});

test("draw counts affect count fitting without becoming decisive outcomes", () => {
  const rows = examples();
  const model = trainModel(rows, { epochs: 200, holdoutDays: 1 });
  const altered = rows.map((row) => row.gameDate < "20260406" && row.homeScore === row.awayScore ? { ...row, homeScore: 9, awayScore: 9 } : row);
  const next = trainModel(altered, { epochs: 200, holdoutDays: 1 });
  assert.notEqual(next.intercept, model.intercept);
  assert.equal(next.metrics.validation.decisiveGames, 6);
});

test("training rejects insufficient dates, invalid count input, duplicate games and obsolete options", () => {
  const rows = examples();
  assert.throws(() => trainModel(rows.slice(0, 8), { minExamples: 1, holdoutDays: 1 }));
  assert.throws(() => trainModel([{ ...rows[0], homeScore: 1.5 }, ...rows.slice(1)]));
  assert.throws(() => trainModel([{ ...rows[0], modelInputs: null }, ...rows.slice(1)]));
  assert.throws(() => trainModel([rows[0], ...rows]));
  assert.throws(() => trainModel(rows, { from: "20260230" }));
  assert.throws(() => trainModel(rows, { calibrationDays: 1 }));
  assert.equal(validateExample({ ...rows[0], asOfTimestamp: rows[0].gameStartsAt }), false);
  assert.equal(validateExample(rows.find((row) => row.homeScore === row.awayScore)), true);
});

test("evaluation defaults to the independent holdout and excludes draws only from decisive metrics", () => {
  const rows = examples();
  const model = trainModel(rows, { epochs: 200, holdoutDays: 1 });
  assert.deepEqual(evaluateModel(model, rows), model.metrics.validation);
  assert.equal(evaluateModel(model, rows, { from: "20260401", to: "20260401" }).samples, 8);
  assert.throws(() => evaluateModel(model, [{ ...rows.at(-1), modelInputs: null }]));
});

test("failed training and malformed upstream responses preserve prior artifacts", async (t) => {
  const directory = await temporary(t);
  const input = path.join(directory, "examples.ndjson");
  const output = path.join(directory, "model.json");
  await fs.writeFile(input, ndjson(examples().slice(0, 8)));
  await fs.writeFile(output, "previous-model\n");
  await assert.rejects(execFile(process.execPath, [script("train-score-model.js"), `--input=${input}`, `--output=${output}`], { cwd: directory }));
  assert.equal(await fs.readFile(output, "utf8"), "previous-model\n");
  const results = path.join(directory, "results.ndjson");
  const previous = ndjson([result("20260401", "old")]);
  await fs.writeFile(results, previous);
  const preload = path.join(directory, "upstream.cjs");
  await fs.writeFile(preload, "global.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ error: 'maintenance' }) });");
  await assert.rejects(execFile(process.execPath, ["--require", preload, script("fetch-results.js"), "--from=20260402", `--output=${results}`], { cwd: directory }));
  assert.equal(await fs.readFile(results, "utf8"), previous);
});

test("result fetching merges corrected games without deleting older dates", async (t) => {
  const directory = await temporary(t);
  const output = path.join(directory, "results.ndjson");
  await fs.writeFile(output, ndjson([result("20260401", "old"), result("20260402", "updated", 1, 3)]));
  const preload = path.join(directory, "upstream.cjs");
  await fs.writeFile(preload, `global.fetch = async () => ({ok: true, text: async () => JSON.stringify({game: [
    {G_ID:'updated',G_DT:'20260402',GAME_STATE_SC:'3',B_SCORE_CN:'4',T_SCORE_CN:'4',HOME_NM:'HOME',AWAY_NM:'AWAY'}]})});`);
  await execFile(process.execPath, ["--require", preload, script("fetch-results.js"), "--from=20260402", `--output=${output}`], { cwd: directory });
  const rows = (await fs.readFile(output, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.find((row) => row.gameKey === "old"), result("20260401", "old"));
  assert.equal(rows.find((row) => row.gameKey === "updated").homeScore, 4);
  assert.equal(rows.find((row) => row.gameKey === "updated").winner, null);
});

test("offline walk-forward evaluates future stored count games without network or active model writes", async (t) => {
  const directory = await temporary(t);
  const input = path.join(directory, "examples.ndjson");
  const model = path.join(directory, "run_model.kbo.json");
  await fs.writeFile(model, "active-model\n");
  const inputBytes = ndjson(examples());
  await fs.writeFile(input, inputBytes);
  const preload = path.join(directory, "network-forbidden.cjs");
  await fs.writeFile(preload, "global.fetch = () => { throw new Error('Network forbidden'); };");
  await execFile(process.execPath, ["--require", preload, script("walk-forward-eval.js"), "--from=20260406", "--holdoutDays=1", "--epochs=200", `--input=${input}`, `--outDir=${directory}`], { cwd: directory });
  const report = JSON.parse(await fs.readFile(path.join(directory, "walk_forward_20260406_20260406.summary.json"), "utf8"));
  assert.equal(report.overall.games, 8);
  assert.equal(report.overall.drawGames, 2);
  assert.ok(report.perDay[0].validationRange.to < "20260406");
  assert.equal(await fs.readFile(model, "utf8"), "active-model\n");
  assert.equal(await fs.readFile(input, "utf8"), inputBytes);
});
