const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { FEATURE_NAMES } = require("../lib/logistic");
const { acquireLock, ndjson, promoteArtifacts, readNdjson, seoulToday, shiftDate } = require("../lib/artifacts");
const { incrementalFrom } = require("../scripts/retrain-daily");
const { verifyDeployment } = require("../scripts/helper-pc-train-and-tune");

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kbo-helper-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixtureServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function cli(script, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, "..", "scripts", script), ...args], {
      cwd, env: { ...process.env, HELPER_PC_CODE_REVISION: "fixture-revision" }, timeout: 30000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function snapshot(date, gameKey, overrides = {}) {
  const isoDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  return {
    league: "kbo", gameDate: date, gameId: gameKey, gameKey, mode: "post_lineup",
    featureSchemaVersion: 2, gameState: "1", gameStartsAt: `${isoDate}T18:30:00+09:00`,
    asOfTimestamp: `${isoDate}T09:00:00+09:00`, trainingEligible: true,
    features: Object.fromEntries(FEATURE_NAMES.map((name) => [name, name === "homeAdvantage" ? 1 : 0])),
    scoreModelInputs: { baselineAwayRuns: 4, baselineHomeRuns: 4, markovAwayRuns: 6, markovHomeRuns: 6, monteCarloAwayRuns: 6, monteCarloHomeRuns: 6, saberApplied: true },
    ...overrides,
  };
}

async function trainingArchive(directory) {
  const snapshots = [];
  const results = [];
  for (let day = 1; day <= 6; day += 1) {
    const date = `2026010${day}`;
    for (let game = 0; game < 3; game += 1) {
      const gameKey = `${date}-${game}`;
      const homeWin = game % 2 === 0;
      const row = snapshot(date, gameKey);
      row.features.offenseDiff = homeWin ? 0.5 : -0.5;
      row.features.lineupWarDiff = homeWin ? 0.4 : -0.4;
      snapshots.push(row);
      results.push({ league: "kbo", gameDate: date, gameKey, completed: true, gameState: "3", homeScore: homeWin ? 5 : 3, awayScore: homeWin ? 3 : 5 });
    }
  }
  await fs.writeFile(path.join(directory, "snapshots.ndjson"), ndjson(snapshots));
  await fs.writeFile(path.join(directory, "results.ndjson"), ndjson(results));
}

test("snapshot HTTP503 fails without resetting an existing archive", async (t) => {
  const directory = await temporary(t);
  const archive = path.join(directory, "snapshots.ndjson");
  const original = ndjson([snapshot("20260101", "archived")]);
  await fs.writeFile(archive, original);
  const baseUrl = await fixtureServer(t, (_req, res) => { res.writeHead(503); res.end("unavailable"); });
  const result = await cli("backfill-snapshots.js", [`--from=${seoulToday()}`, `--baseUrl=${baseUrl}`, `--output=${archive}`, "--resetSnapshots=true"], directory);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /HTTP 503/);
  assert.equal(await fs.readFile(archive, "utf8"), original);
});

test("a later failed collection date cannot partially update the archive", async (t) => {
  const directory = await temporary(t);
  const today = seoulToday();
  const next = shiftDate(today, 1);
  const archive = path.join(directory, "snapshots.ndjson");
  const original = ndjson([snapshot("20260101", "archived")]);
  await fs.writeFile(archive, original);
  const baseUrl = await fixtureServer(t, (req, res) => {
    const date = new URL(req.url, "http://fixture").searchParams.get("date");
    if (date === next) { res.writeHead(503); res.end(); return; }
    res.setHeader("Content-Type", "application/json");
    const row = snapshot(date, "new");
    res.end(JSON.stringify({ date, asOfTimestamp: row.asOfTimestamp, predictions: [row] }));
  });
  const result = await cli("backfill-snapshots.js", [`--from=${today}`, `--to=${next}`, `--baseUrl=${baseUrl}`, `--output=${archive}`], directory);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(await fs.readFile(archive, "utf8"), original);
});

test("successful snapshot collection keeps older games and only latest eligible row per mode", async (t) => {
  const directory = await temporary(t);
  const today = seoulToday();
  const archive = path.join(directory, "snapshots.ndjson");
  const current = snapshot(today, "current");
  const newer = { ...current, asOfTimestamp: current.asOfTimestamp.replace("09:00", "10:00"), homeWinProbability: 0.64, expectedHomeRuns: 4.7, decisionBasis: "archived decision", modelFeatures: { visible: 1 } };
  const alternative = { ...current, mode: "pre_lineup" };
  const invalidLate = { ...current, asOfTimestamp: current.asOfTimestamp.replace("09:00", "19:00"), gameState: "3", trainingEligible: false };
  await fs.writeFile(archive, ndjson([snapshot("20260101", "older-game"), current, alternative]));
  const baseUrl = await fixtureServer(t, (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ date: today, asOfTimestamp: newer.asOfTimestamp, predictions: [newer, invalidLate] }));
  });
  const result = await cli("backfill-snapshots.js", [`--from=${today}`, `--baseUrl=${baseUrl}`, `--output=${archive}`, "--resetSnapshots=true"], directory);
  assert.equal(result.code, 0, result.stderr);
  const rows = await readNdjson(archive);
  assert.equal(rows.length, 3);
  assert.ok(rows.some((row) => row.gameKey === "older-game"));
  const retained = rows.find((row) => row.gameKey === "current" && row.mode === "post_lineup");
  assert.deepEqual(retained.features, newer.features);
  assert.deepEqual(retained.scoreModelInputs, newer.scoreModelInputs);
  assert.equal(retained.asOfTimestamp, newer.asOfTimestamp);
  assert.equal(retained.homeWinProbability, 0.64);
  assert.equal(retained.decisionBasis, "archived decision");
  assert.deepEqual(retained.modelFeatures, { visible: 1 });
});

test("invalid HTTP200 prediction schema fails without creating an archive", async (t) => {
  const directory = await temporary(t);
  const today = seoulToday();
  const archive = path.join(directory, "snapshots.ndjson");
  const baseUrl = await fixtureServer(t, (_req, res) => { res.end(JSON.stringify({ date: today, predictions: [] })); });
  const result = await cli("backfill-snapshots.js", [`--from=${today}`, `--baseUrl=${baseUrl}`, `--output=${archive}`], directory);
  assert.equal(result.code, 1, result.stderr);
  await assert.rejects(fs.access(archive), { code: "ENOENT" });
});

test("historical snapshot requests never query a live forecast or rewrite archives", async (t) => {
  const directory = await temporary(t);
  const archive = path.join(directory, "snapshots.ndjson");
  const original = ndjson([snapshot("20260101", "older-game")]);
  await fs.writeFile(archive, original);
  let requests = 0;
  const baseUrl = await fixtureServer(t, (_req, res) => { requests += 1; res.writeHead(503); res.end(); });
  const result = await cli("backfill-snapshots.js", ["--from=20260101", "--to=20260102", `--baseUrl=${baseUrl}`, `--output=${archive}`], directory);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests, 0);
  assert.equal(await fs.readFile(archive, "utf8"), original);
});

test("zero eligible tuning samples fail without replacing previous settings", async (t) => {
  const directory = await temporary(t);
  const output = path.join(directory, "tuning.json");
  const original = '{"prior":"valid-settings"}\n';
  await fs.writeFile(output, original);
  await fs.writeFile(path.join(directory, "snapshots.ndjson"), "");
  await fs.writeFile(path.join(directory, "results.ndjson"), "");
  const result = await cli("tune-saber-weights.js", ["--from=20260101", "--to=20260102", "--snapshots=snapshots.ndjson", "--results=results.ndjson", `--output=${output}`, "--minSamples=1"], directory);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(await fs.readFile(output, "utf8"), original);
});

test("offline tuning uses immutable baseline inputs, not already blended displayed scores", async (t) => {
  const directory = await temporary(t);
  const rows = [snapshot("20260101", "one"), snapshot("20260102", "two")].map((row) => ({ ...row, expectedAwayRuns: 99, expectedHomeRuns: 99, predictedAwayScore: 99, predictedHomeScore: 99 }));
  const results = rows.map((row) => ({ gameKey: row.gameKey, gameDate: row.gameDate, completed: true, awayScore: 4, homeScore: 4 }));
  await fs.writeFile(path.join(directory, "snapshots.ndjson"), ndjson(rows));
  await fs.writeFile(path.join(directory, "results.ndjson"), ndjson(results));
  const result = await cli("tune-saber-weights.js", ["--from=20260101", "--to=20260102", "--snapshots=snapshots.ndjson", "--results=results.ndjson", "--output=tuning.json", "--minSamples=2"], directory);
  assert.equal(result.code, 0, result.stderr);
  const tuning = JSON.parse(await fs.readFile(path.join(directory, "tuning.json"), "utf8"));
  assert.equal(tuning.best.baseWeight, 1);
  assert.equal(tuning.tuningMae, 0);
  assert.equal(tuning.validationMae, 0);
  assert.equal(tuning.validationSamples, 1);
  assert.ok(tuning.tuningRange.to < tuning.validationRange.from);
});

test("tuning rejects a candidate that deteriorates on later validation dates", async (t) => {
  const directory = await temporary(t);
  const original = '{"prior":"good-tuning"}\n';
  await fs.writeFile(path.join(directory, "tuning.json"), original);
  const rows = [snapshot("20260101", "tune"), snapshot("20260102", "validate")];
  const results = rows.map((row, index) => ({
    gameKey: row.gameKey, gameDate: row.gameDate, completed: true,
    awayScore: index === 0 ? 4 : 6, homeScore: index === 0 ? 4 : 6,
  }));
  await fs.writeFile(path.join(directory, "snapshots.ndjson"), ndjson(rows));
  await fs.writeFile(path.join(directory, "results.ndjson"), ndjson(results));
  const result = await cli("tune-saber-weights.js", ["--from=20260101", "--to=20260102", "--snapshots=snapshots.ndjson", "--results=results.ndjson", "--output=tuning.json", "--minSamples=2"], directory);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /validation quality gate/);
  assert.equal(await fs.readFile(path.join(directory, "tuning.json"), "utf8"), original);
});

test("baseline-only snapshots without usable saber signals cannot qualify for tuning", async (t) => {
  const directory = await temporary(t);
  const rows = [snapshot("20260101", "one"), snapshot("20260102", "two")];
  rows[0].scoreModelInputs.saberApplied = false;
  rows[1].scoreModelInputs.markovAwayRuns = null;
  const results = rows.map((row) => ({ gameKey: row.gameKey, gameDate: row.gameDate, completed: true, awayScore: 4, homeScore: 4 }));
  await fs.writeFile(path.join(directory, "snapshots.ndjson"), ndjson(rows));
  await fs.writeFile(path.join(directory, "results.ndjson"), ndjson(results));
  const result = await cli("tune-saber-weights.js", ["--from=20260101", "--to=20260102", "--snapshots=snapshots.ndjson", "--results=results.ndjson", "--output=tuning.json", "--minSamples=1"], directory);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /samples \(0 < 1\)/);
  await assert.rejects(fs.access(path.join(directory, "tuning.json")), { code: "ENOENT" });
});

test("incremental result range includes correction window without discarding older training range", () => {
  const results = [
    { gameDate: "20260115", completed: true, homeScore: 3, awayScore: 1 },
    { gameDate: "20260201", completed: false, homeScore: null, awayScore: null },
  ];
  assert.equal(incrementalFrom(results, "20260101", "20260131", 3), "20260112");
  assert.equal(incrementalFrom(results, "20260114", "20260131", 3), "20260114");
});

test("failed retraining preserves active model bytes and persists insufficient status", async (t) => {
  const directory = await temporary(t);
  const original = '{"version":"active-model"}\n';
  await fs.writeFile(path.join(directory, "model.json"), original);
  await fs.writeFile(path.join(directory, "snapshots.ndjson"), "");
  await fs.writeFile(path.join(directory, "results.ndjson"), "");
  const result = await cli("retrain-daily.js", ["--from=20260101", "--to=20260102", "--fetchResults=false", "--snapshots=snapshots.ndjson", "--results=results.ndjson", "--examples=examples.ndjson", "--model=model.json", "--status=retrain.json", "--minExamples=1", "--allowInsufficient=true", "--epochs=2"], directory);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(await fs.readFile(path.join(directory, "model.json"), "utf8"), original);
  const status = JSON.parse(await fs.readFile(path.join(directory, "retrain.json"), "utf8"));
  assert.equal(status.ok, false);
  assert.equal(status.skipped, true);
  assert.equal(status.skipReason, "insufficient_examples");
});

test("retraining refuses a holdout worse than coinflip without replacing active model", async (t) => {
  const directory = await temporary(t);
  await trainingArchive(directory);
  const original = '{"version":"active-model"}\n';
  await fs.writeFile(path.join(directory, "model.json"), original);
  const resultsPath = path.join(directory, "results.ndjson");
  const rows = await readNdjson(resultsPath);
  for (const row of rows) {
    if (row.gameDate === "20260106") [row.homeScore, row.awayScore] = [row.awayScore, row.homeScore];
  }
  await fs.writeFile(resultsPath, ndjson(rows));
  const result = await cli("retrain-daily.js", ["--from=20260101", "--to=20260106", "--fetchResults=false", "--snapshots=snapshots.ndjson", "--results=results.ndjson", "--examples=examples.ndjson", "--model=model.json", "--status=retrain.json", "--minExamples=1", "--holdoutDays=1", "--calibrationDays=1", "--epochs=2"], directory);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /coinflip baseline/);
  assert.equal(await fs.readFile(path.join(directory, "model.json"), "utf8"), original);
  const status = JSON.parse(await fs.readFile(path.join(directory, "retrain.json"), "utf8"));
  assert.equal(status.ok, false);
  assert.equal(status.stage, "validate-model");
});

test("helper tuning health gate preserves model/settings and stops before deployment", async (t) => {
  const directory = await temporary(t);
  await trainingArchive(directory);
  const model = '{"version":"active-model"}\n';
  const tuning = '{"prior":"active-tuning"}\n';
  await fs.writeFile(path.join(directory, "model.json"), model);
  await fs.writeFile(path.join(directory, "tuning.json"), tuning);
  const result = await cli("helper-pc-train-and-tune.js", ["--from=20260101", "--to=20260106", "--fetchResults=false", "--autoPush=true", "--snapshots=snapshots.ndjson", "--results=results.ndjson", "--examples=examples.ndjson", "--model=model.json", "--tuning=tuning.json", "--retrainStatus=retrain.json", "--status=helper.json", "--minExamples=1", "--minSamples=999", "--holdoutDays=1", "--calibrationDays=1", "--epochs=2"], directory);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(await fs.readFile(path.join(directory, "model.json"), "utf8"), model);
  assert.equal(await fs.readFile(path.join(directory, "tuning.json"), "utf8"), tuning);
  const status = JSON.parse(await fs.readFile(path.join(directory, "helper.json"), "utf8"));
  assert.equal(status.failure.stage, "tune-saber");
  assert.equal(status.deployment.state, "not_deployed");
  assert.equal(status.modelVersion, "active-model");
  await assert.rejects(fs.access(path.join(directory, "model.json.helper.lock")), { code: "ENOENT" });
});

test("offline helper promotes a healthy pair and records not_deployed", async (t) => {
  const directory = await temporary(t);
  await trainingArchive(directory);
  const result = await cli("helper-pc-train-and-tune.js", ["--from=20260101", "--to=20260106", "--fetchResults=false", "--autoPush=false", "--snapshots=snapshots.ndjson", "--results=results.ndjson", "--examples=examples.ndjson", "--model=model.json", "--tuning=tuning.json", "--retrainStatus=retrain.json", "--status=helper.json", "--minExamples=1", "--minSamples=2", "--holdoutDays=1", "--calibrationDays=1", "--epochs=2"], directory);
  assert.equal(result.code, 0, result.stderr);
  const model = JSON.parse(await fs.readFile(path.join(directory, "model.json"), "utf8"));
  const tuning = JSON.parse(await fs.readFile(path.join(directory, "tuning.json"), "utf8"));
  const status = JSON.parse(await fs.readFile(path.join(directory, "helper.json"), "utf8"));
  assert.equal(model.featureSchemaVersion, 2);
  assert.equal(tuning.featureSchemaVersion, 2);
  assert.equal(status.ok, true);
  assert.equal(status.deployment.state, "not_deployed");
  assert.equal(status.codeRevision, "fixture-revision");
  assert.equal(status.modelVersion, model.version);
  assert.match(status.modelHash, /^[a-f0-9]{64}$/);
  assert.match(status.saberSettingsHash, /^[a-f0-9]{64}$/);
});

test("collect-only mode retains validated pregame rows without replacing model or tuning", async (t) => {
  const directory = await temporary(t);
  const today = seoulToday();
  await fs.writeFile(path.join(directory, "results.ndjson"), "");
  const model = '{"version":"active-model"}\n';
  const tuning = '{"prior":"active-tuning"}\n';
  await fs.writeFile(path.join(directory, "model.json"), model);
  await fs.writeFile(path.join(directory, "tuning.json"), tuning);
  const row = snapshot(today, "new-pregame");
  const baseUrl = await fixtureServer(t, (_req, res) => { res.end(JSON.stringify({ date: today, asOfTimestamp: row.asOfTimestamp, predictions: [row] })); });
  const result = await cli("helper-pc-train-and-tune.js", [`--from=${today}`, `--to=${today}`, `--baseUrl=${baseUrl}`, "--fetchResults=false", "--collectOnly=true", "--autoPush=true", "--snapshots=snapshots.ndjson", "--results=results.ndjson", "--model=model.json", "--tuning=tuning.json", "--status=helper.json"], directory);
  assert.equal(result.code, 0, result.stderr);
  const rows = await readNdjson(path.join(directory, "snapshots.ndjson"));
  assert.equal(rows[0].gameKey, "new-pregame");
  assert.equal(await fs.readFile(path.join(directory, "model.json"), "utf8"), model);
  assert.equal(await fs.readFile(path.join(directory, "tuning.json"), "utf8"), tuning);
  const status = JSON.parse(await fs.readFile(path.join(directory, "helper.json"), "utf8"));
  assert.equal(status.stage, "collected");
  assert.equal(status.deployment.state, "not_deployed");
});

test("artifact promotion rolls earlier writes back when a later target cannot be written", async (t) => {
  const directory = await temporary(t);
  const first = path.join(directory, "active-model.json");
  const source1 = path.join(directory, "new-model.json");
  const source2 = path.join(directory, "new-tuning.json");
  const second = path.join(directory, "active-tuning.json");
  await fs.writeFile(first, "old model");
  await fs.writeFile(source1, "new model");
  await fs.writeFile(source2, "new tuning");
  await fs.writeFile(second, "old tuning");
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (source, target) => {
    if (target === second) throw Object.assign(new Error("fixture promotion failure"), { code: "EIO" });
    return rename(source, target);
  });
  await assert.rejects(promoteArtifacts([{ source: source1, target: first }, { source: source2, target: second }]), /fixture promotion failure/);
  assert.equal(await fs.readFile(first, "utf8"), "old model");
  assert.equal(await fs.readFile(second, "utf8"), "old tuning");
});

test("exclusive helper lock rejects a second owner and becomes reusable after release", async (t) => {
  const directory = await temporary(t);
  const lock = path.join(directory, "helper.lock");
  const release = await acquireLock(lock);
  await assert.rejects(acquireLock(lock), /already running/);
  await release();
  const releaseAgain = await acquireLock(lock);
  await releaseAgain();
});

test("deployment verification retries stale hashes but never accepts HTTP failures", async (t) => {
  const expected = { modelVersion: "new", modelHash: "model-hash", saberSettingsHash: "settings-hash", featureSchemaVersion: 2 };
  let calls = 0;
  const baseUrl = await fixtureServer(t, (_req, res) => {
    calls += 1;
    res.end(JSON.stringify(calls === 1 ? { ...expected, modelHash: "stale" } : expected));
  });
  const verified = await verifyDeployment(baseUrl, expected, { attempts: 2, delayMs: 0, timeoutMs: 1000 });
  assert.equal(verified.state, "verified");
  assert.equal(verified.attempts, 2);
  const unavailable = await fixtureServer(t, (_req, res) => { res.writeHead(503); res.end(); });
  await assert.rejects(verifyDeployment(unavailable, expected, { attempts: 2, delayMs: 0, timeoutMs: 1000 }), /HTTP 503/);
});

test("off-day empty normalized gameday reports no new rows and preserves archived games", async (t) => {
  const directory = await temporary(t);
  const today = seoulToday();
  const archive = path.join(directory, "snapshots.ndjson");
  const original = ndjson([snapshot("20260101", "old-game")]);
  await fs.writeFile(archive, original);
  await fs.writeFile(path.join(directory, "results.ndjson"), "");
  const baseUrl = await fixtureServer(t, (_req, res) => {
    res.end(JSON.stringify({
      requestedDate: today, date: shiftDate(today, -1),
      asOfTimestamp: new Date().toISOString(), predictions: [],
    }));
  });
  const result = await cli("helper-pc-train-and-tune.js", [
    `--from=${today}`, `--to=${today}`, `--baseUrl=${baseUrl}`,
    "--collectOnly=true", "--fetchResults=false", "--snapshots=snapshots.ndjson",
    "--results=results.ndjson", "--model=model.json", "--status=helper.json",
  ], directory);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await fs.readFile(archive, "utf8"), original);
  const status = JSON.parse(await fs.readFile(path.join(directory, "helper.json"), "utf8"));
  assert.equal(status.snapshotCollection, "no_pregame_rows");
  assert.equal(status.snapshotRowsCollected, 0);
});
