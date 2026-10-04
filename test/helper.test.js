const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { MODEL_TYPE } = require("../lib/score-model");
const { acquireLock, ndjson, promoteArtifacts, readNdjson, seoulToday, shiftDate, sha256 } = require("../lib/artifacts");
const { incrementalFrom, resolveOpeningDate } = require("../scripts/retrain-daily");
const { verifyDeployment } = require("../scripts/helper-pc-train-and-tune");
const { snapshot, archive } = require("./count-fixtures");
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
async function trainingArchive(directory, reverseHoldout = false) {
  const rows = archive();
  if (reverseHoldout) for (const row of rows.results) if (row.gameDate === "20260406") [row.homeScore, row.awayScore] = [row.awayScore, row.homeScore];
  await fs.writeFile(path.join(directory, "snapshots.ndjson"), ndjson(rows.snapshots));
  await fs.writeFile(path.join(directory, "results.ndjson"), ndjson(rows.results));
}
const batchArgs = ["--from=20260401", "--to=20260406", "--fetchResults=false", "--snapshots=snapshots.ndjson", "--results=results.ndjson",
  "--examples=examples.ndjson", "--model=model.json", "--holdoutDays=1", "--epochs=200"];

test("snapshot source failure cannot reset or partially rewrite the archive", async (t) => {
  const directory = await temporary(t);
  const today = seoulToday();
  const next = shiftDate(today, 1);
  const file = path.join(directory, "snapshots.ndjson");
  const original = ndjson([snapshot("20260401", "archived")]);
  await fs.writeFile(file, original);
  const baseUrl = await fixtureServer(t, (req, res) => {
    const date = new URL(req.url, "http://fixture").searchParams.get("date");
    if (date === next) { res.writeHead(503); res.end(); return; }
    const row = snapshot(date, "new");
    res.end(JSON.stringify({ date, asOfTimestamp: row.asOfTimestamp, predictions: [row] }));
  });
  const result = await cli("backfill-snapshots.js", [`--from=${today}`, `--to=${next}`, `--baseUrl=${baseUrl}`, `--output=${file}`, "--resetSnapshots=true"], directory);
  assert.equal(result.code, 1);
  assert.equal(await fs.readFile(file, "utf8"), original);
});

test("collector archives latest confirmed bootstrap inputs even when model unavailable", async (t) => {
  const directory = await temporary(t);
  const today = seoulToday();
  const file = path.join(directory, "snapshots.ndjson");
  const older = snapshot(today, "current");
  const newer = snapshot(today, "current", { asOfTimestamp: older.asOfTimestamp.replace("08:00", "08:30"), trainingEligible: false });
  newer.modelInputs.leagueRunsPerGame = 4.123456789;
  await fs.writeFile(file, ndjson([snapshot("20260401", "old"), older]));
  const absent = snapshot(today, "unconfirmed", { lineupConfirmed: false, modelInputs: null, trainingEligible: false });
  const baseUrl = await fixtureServer(t, (_req, res) => res.end(JSON.stringify({ date: today, asOfTimestamp: newer.asOfTimestamp, predictions: [newer, absent] })));
  const result = await cli("backfill-snapshots.js", [`--from=${today}`, `--baseUrl=${baseUrl}`, `--output=${file}`], directory);
  assert.equal(result.code, 0, result.stderr);
  const rows = await readNdjson(file);
  assert.deepEqual(rows.map((row) => row.gameKey).sort(), ["current", "old"]);
  const current = rows.find((row) => row.gameKey === "current");
  assert.deepEqual(current.modelInputs, newer.modelInputs);
  assert.equal(current.status, "unavailable");
  assert.equal(current.trainingEligible, true);
  assert.equal(current.asOfTimestamp, newer.asOfTimestamp);
});

test("malformed successful response creates no archive and historical collection sends no requests", async (t) => {
  const directory = await temporary(t);
  const file = path.join(directory, "snapshots.ndjson");
  let requests = 0;
  const baseUrl = await fixtureServer(t, (_req, res) => { requests += 1; res.end(JSON.stringify({ date: seoulToday(), predictions: [] })); });
  assert.equal((await cli("backfill-snapshots.js", [`--from=${seoulToday()}`, `--baseUrl=${baseUrl}`, `--output=${file}`], directory)).code, 1);
  await assert.rejects(fs.access(file), { code: "ENOENT" });
  requests = 0;
  const original = ndjson([snapshot("20260401", "old")]);
  await fs.writeFile(file, original);
  assert.equal((await cli("backfill-snapshots.js", ["--from=20260401", "--to=20260402", `--baseUrl=${baseUrl}`, `--output=${file}`], directory)).code, 0);
  assert.equal(requests, 0);
  assert.equal(await fs.readFile(file, "utf8"), original);
});

test("incremental result range includes correction dates", () => {
  const rows = [{ gameDate: "20260415", completed: true, homeScore: 3, awayScore: 1 }, { gameDate: "20260501", completed: false, homeScore: null, awayScore: null }];
  assert.equal(incrementalFrom(rows, "20260401", "20260430", 3), "20260412");
  assert.equal(incrementalFrom(rows, "20260414", "20260430", 3), "20260414");
});

test("official opening date derives current regular season without a hardcoded March date", async (t) => {
  t.mock.method(global, "fetch", async () => ({ ok: true, json: async () => ({ code: "100", NOW_G_DT: "20260328" }) }));
  const previous = process.env.KBO_OPENING_DAY;
  delete process.env.KBO_OPENING_DAY;
  t.after(() => { if (previous === undefined) delete process.env.KBO_OPENING_DAY; else process.env.KBO_OPENING_DAY = previous; });
  assert.equal(await resolveOpeningDate({}, "20261003"), "20260328");
  assert.equal(await resolveOpeningDate({ from: "20260401" }, "20261003"), "20260401");
});

test("insufficient retraining records failure without replacing the active model", async (t) => {
  const directory = await temporary(t);
  await fs.writeFile(path.join(directory, "model.json"), "active-model\n");
  await fs.writeFile(path.join(directory, "snapshots.ndjson"), "");
  await fs.writeFile(path.join(directory, "results.ndjson"), "");
  const result = await cli("retrain-daily.js", [...batchArgs, "--status=retrain.json"], directory);
  assert.equal(result.code, 1);
  assert.equal(await fs.readFile(path.join(directory, "model.json"), "utf8"), "active-model\n");
  const status = JSON.parse(await fs.readFile(path.join(directory, "retrain.json"), "utf8"));
  assert.equal(status.ok, false);
  assert.equal(status.skipped, true);
  assert.equal(status.skipReason, "insufficient_examples");
  await assert.rejects(fs.access(path.join(directory, "model.json.retrain.lock")), { code: "ENOENT" });
});

test("bad independent holdout cannot replace active model or reach deployment", async (t) => {
  const directory = await temporary(t);
  await trainingArchive(directory, true);
  await fs.writeFile(path.join(directory, "model.json"), '{"version":"old-user-artifact"}\n');
  const original = await fs.readFile(path.join(directory, "model.json"), "utf8");
  const result = await cli("helper-pc-train-and-tune.js", [...batchArgs, "--autoPush=true", "--retrainStatus=retrain.json", "--status=helper.json"], directory);
  assert.equal(result.code, 1);
  assert.equal(await fs.readFile(path.join(directory, "model.json"), "utf8"), original);
  const status = JSON.parse(await fs.readFile(path.join(directory, "helper.json"), "utf8"));
  assert.equal(status.ok, false);
  assert.equal(status.deployment.state, "not_deployed");
  assert.equal(status.modelVersion, null);
  await assert.rejects(fs.access(path.join(directory, "model.json.helper.lock")), { code: "ENOENT" });
});

test("offline helper promotes independently validated count model and exact hash", async (t) => {
  const directory = await temporary(t);
  await trainingArchive(directory);
  const result = await cli("helper-pc-train-and-tune.js", [...batchArgs, "--autoPush=false", "--retrainStatus=retrain.json", "--status=helper.json"], directory);
  assert.equal(result.code, 0, result.stderr);
  const bytes = await fs.readFile(path.join(directory, "model.json"));
  const model = JSON.parse(bytes);
  const status = JSON.parse(await fs.readFile(path.join(directory, "helper.json"), "utf8"));
  assert.equal(model.modelType, MODEL_TYPE);
  assert.equal(model.validationIndependent, true);
  assert.ok(model.trainingRange.to < model.validationRange.from);
  assert.equal(status.ok, true);
  assert.equal(status.deployment.state, "not_deployed");
  assert.equal(status.modelHash, sha256(bytes));
  assert.equal((await readNdjson(path.join(directory, "examples.ndjson"))).filter((row) => row.homeScore === row.awayScore).length, 12);
});

test("historical-only helper trains without a live archive and retains reconstruction provenance", async (t) => {
  const directory = await temporary(t);
  const archived = archive();
  const reconstructedAt = new Date().toISOString();
  const historical = archived.snapshots.map((row) => {
    const iso = `${row.gameDate.slice(0, 4)}-${row.gameDate.slice(4, 6)}-${row.gameDate.slice(6, 8)}`;
    const inputsCutoffAt = new Date(`${iso}T00:00:00+09:00`).toISOString();
    return { ...row, mode: "historical_reconstruction", dataOrigin: "historical_reconstruction",
      gameState: "3", asOfTimestamp: reconstructedAt, reconstructedAt, inputsCutoffAt,
      sourceThroughDate: shiftDate(row.gameDate, -1), modelInputs: { ...row.modelInputs, dataAsOf: inputsCutoffAt },
      awayLineup: Array.from({ length: 9 }, (_, i) => ({ order: i + 1, name: `Away${i}` })),
      homeLineup: Array.from({ length: 9 }, (_, i) => ({ order: i + 1, name: `Home${i}` })) };
  });
  await fs.writeFile(path.join(directory, "historical.ndjson"), ndjson(historical));
  await fs.writeFile(path.join(directory, "results.ndjson"), ndjson(archived.results));
  const result = await cli("helper-pc-train-and-tune.js", [...batchArgs, "--historical=historical.ndjson",
    "--autoPush=false", "--retrainStatus=retrain.json", "--status=helper.json"], directory);
  assert.equal(result.code, 0, result.stderr);
  const model = JSON.parse(await fs.readFile(path.join(directory, "model.json"), "utf8"));
  const examples = await readNdjson(path.join(directory, "examples.ndjson"));
  assert.equal(model.validationIndependent, true);
  assert.ok(model.trainingRange.to < model.validationRange.from);
  assert.equal(examples.length, archived.results.length);
  assert.ok(examples.every((row) => row.mode === "historical_reconstruction"
    && row.reconstructedAt === reconstructedAt && row.modelInputs.dataAsOf === row.inputsCutoffAt));
  const predicted = require("../lib/score-model").predictGame(model, historical[0].modelInputs);
  assert.ok(predicted.homeWinProbability > 0.5);
  await assert.rejects(fs.access(path.join(directory, "snapshots.ndjson")), { code: "ENOENT" });
});

test("first collect-only run needs no results file and archives only the 30-minute window without replacing the model", async (t) => {
  const directory = await temporary(t);
  const today = seoulToday();
  const row = snapshot(today, "new");
  row.asOfTimestamp = new Date(Date.parse(row.gameStartsAt) - 30 * 60000).toISOString();
  const tooEarly = snapshot(today, "too-early", { asOfTimestamp: new Date(Date.parse(row.gameStartsAt) - 30 * 60000 - 1).toISOString() });
  await fs.writeFile(path.join(directory, "model.json"), '{"version":"legacy-user-artifact"}\n');
  const baseUrl = await fixtureServer(t, (_req, res) => res.end(JSON.stringify({ date: today, asOfTimestamp: row.asOfTimestamp, predictions: [tooEarly, row] })));
  const result = await cli("helper-pc-train-and-tune.js", [`--from=${today}`, `--baseUrl=${baseUrl}`, "--fetchResults=false", "--collectOnly=true", "--autoPush=false", "--pregameWindowMinutes=30",
    "--snapshots=snapshots.ndjson", "--results=results.ndjson", "--model=model.json", "--status=helper.json"], directory);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await fs.readFile(path.join(directory, "model.json"), "utf8"), '{"version":"legacy-user-artifact"}\n');
  assert.deepEqual((await readNdjson(path.join(directory, "snapshots.ndjson")))[0].modelInputs, row.modelInputs);
  assert.deepEqual((await readNdjson(path.join(directory, "snapshots.ndjson"))).map((saved) => saved.gameKey), ["new"]);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, "helper.json"), "utf8")).deployment.state, "not_deployed");
});

test("obsolete tuning options explicitly fail and release the helper lock", async (t) => {
  const directory = await temporary(t);
  const result = await cli("helper-pc-train-and-tune.js", [...batchArgs, "--tuning=tuning.json", "--status=helper.json"], directory);
  assert.equal(result.code, 1);
  await assert.rejects(fs.access(path.join(directory, "model.json.helper.lock")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(directory, "model.json")), { code: "ENOENT" });
});

test("artifact promotion rolls back earlier writes and lock remains exclusive", async (t) => {
  const directory = await temporary(t);
  const first = path.join(directory, "model.json");
  const second = path.join(directory, "status.json");
  const source1 = path.join(directory, "new-model.json");
  const source2 = path.join(directory, "new-status.json");
  await fs.writeFile(first, "old model"); await fs.writeFile(second, "old status");
  await fs.writeFile(source1, "new model"); await fs.writeFile(source2, "new status");
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (source, target) => { if (target === second) throw new Error("promotion failure"); return rename(source, target); });
  await assert.rejects(promoteArtifacts([{ source: source1, target: first }, { source: source2, target: second }]));
  assert.equal(await fs.readFile(first, "utf8"), "old model");
  assert.equal(await fs.readFile(second, "utf8"), "old status");
  const lock = path.join(directory, "helper.lock");
  const release = await acquireLock(lock);
  await assert.rejects(acquireLock(lock));
  await release();
  const next = await acquireLock(lock); await next();
});

test("deployment rejects stale hashes, wrong model types, schemas and unavailable status", async (t) => {
  const expected = { modelVersion: "new", modelHash: "model-hash", modelType: MODEL_TYPE, featureSchemaVersion: 3, modelValidationIndependent: true, status: "ready" };
  let calls = 0;
  const baseUrl = await fixtureServer(t, (_req, res) => { calls += 1; res.end(JSON.stringify(calls === 1 ? { ...expected, modelHash: "stale" } : expected)); });
  assert.equal((await verifyDeployment(baseUrl, expected, { attempts: 2, delayMs: 0, timeoutMs: 1000 })).attempts, 2);
  for (const invalid of [{ modelType: "other" }, { featureSchemaVersion: 2 }, { status: "unavailable" }, { modelValidationIndependent: false }]) {
    const url = await fixtureServer(t, (_req, res) => res.end(JSON.stringify({ ...expected, ...invalid })));
    await assert.rejects(verifyDeployment(url, expected, { attempts: 1, delayMs: 0, timeoutMs: 1000 }));
  }
  const url = await fixtureServer(t, (_req, res) => { res.writeHead(503); res.end(); });
  await assert.rejects(verifyDeployment(url, expected, { attempts: 1, delayMs: 0, timeoutMs: 1000 }));
});

test("normalized off-day empty response preserves archived rows", async (t) => {
  const directory = await temporary(t);
  const today = seoulToday();
  const original = ndjson([snapshot("20260401", "old")]);
  await fs.writeFile(path.join(directory, "snapshots.ndjson"), original);
  await fs.writeFile(path.join(directory, "results.ndjson"), "");
  const baseUrl = await fixtureServer(t, (_req, res) => res.end(JSON.stringify({ requestedDate: today, date: shiftDate(today, -1), asOfTimestamp: new Date().toISOString(), predictions: [] })));
  const result = await cli("helper-pc-train-and-tune.js", [`--from=${today}`, `--baseUrl=${baseUrl}`, "--collectOnly=true", "--fetchResults=false",
    "--snapshots=snapshots.ndjson", "--results=results.ndjson", "--model=model.json", "--status=helper.json"], directory);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await fs.readFile(path.join(directory, "snapshots.ndjson"), "utf8"), original);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, "helper.json"), "utf8")).snapshotRowsCollected, 0);
});
