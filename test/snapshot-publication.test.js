const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");
const { ndjson, seoulToday, sha256 } = require("../lib/artifacts");
const { snapshot, archive } = require("./count-fixtures");
const { MODEL_TYPE } = require("../lib/score-model");

const publishedFile = "data/published_predictions.kbo.ndjson";
function readySnapshot(date, key, overrides = {}) {
  return snapshot(date, key, {
    status: "ready", unavailableCode: null, predictionSource: "live_pregame",
    modelType: MODEL_TYPE, modelVersion: "fixture-model",
    awayWinProbability: 0.4, homeWinProbability: 0.6, tieAfterNineProbability: 0.1,
    expectedAwayRuns: 3, expectedHomeRuns: 4, predictedAwayScore: 3, predictedHomeScore: 4,
    predictedRunDiff: 1, ...overrides,
  });
}

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull,
  GIT_AUTHOR_NAME: "Snapshot Test", GIT_AUTHOR_EMAIL: "snapshot@example.invalid",
  GIT_COMMITTER_NAME: "Snapshot Test", GIT_COMMITTER_EMAIL: "snapshot@example.invalid" };
function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8", timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kbo-snapshot-publish-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
async function repository(t) {
  const directory = await temporary(t);
  const work = path.join(directory, "work");
  const remote = path.join(directory, "remote.git");
  await fs.mkdir(work);
  git(directory, "init", "--bare", "--initial-branch=main", remote);
  git(work, "init", "--initial-branch=main");
  git(work, "config", "commit.gpgsign", "false");
  git(work, "config", "core.autocrlf", "true");
  await fs.copyFile(path.resolve(__dirname, "../.gitattributes"), path.join(work, ".gitattributes"));
  await fs.writeFile(path.join(work, "model.json"), '{"version":"original"}\n');
  await fs.writeFile(path.join(work, "results.ndjson"), "");
  await fs.writeFile(path.join(work, "retrain.json"), '{}\n');
  await fs.writeFile(path.join(work, "unrelated.txt"), "original\n");
  git(work, "add", "--", ".gitattributes", "model.json", "results.ndjson", "retrain.json", "unrelated.txt");
  git(work, "commit", "-m", "Initial artifacts");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "--set-upstream", "origin", "main");
  return { directory, work, remote };
}
function cli(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, "../scripts/helper-pc-train-and-tune.js"), ...args], {
      cwd, env: { ...gitEnv, HELPER_PC_CODE_REVISION: "fixture-revision" }, timeout: 60000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
async function fixtureServer(t, remote, predictions = []) {
  const fixture = { predictions, snapshotOverride: undefined, modelOverride: undefined, requests: [] };
  const server = http.createServer((req, res) => {
    fixture.requests.push(req.url);
    try {
      if (req.url === "/api/predictions/archive/status") {
        res.end(JSON.stringify(fixture.snapshotOverride ?? {
          featureSchemaVersion: 3, snapshotHash: sha256(git(remote, "show", `main:${publishedFile}`)),
        }));
      } else if (req.url === "/api/model/status") {
        const bytes = git(remote, "show", "main:model.json");
        const model = JSON.parse(bytes);
        res.end(JSON.stringify({ status: "ready", modelType: model.modelType, modelValidationIndependent: model.validationIndependent,
          featureSchemaVersion: model.featureSchemaVersion, modelVersion: model.version, modelHash: sha256(bytes), ...fixture.modelOverride }));
      } else if (req.url.startsWith("/api/predictions/gameday?")) {
        res.end(JSON.stringify({ date: seoulToday(), asOfTimestamp: new Date().toISOString(), predictions: fixture.predictions }));
      } else { res.writeHead(404); res.end(); }
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  fixture.baseUrl = `http://127.0.0.1:${server.address().port}`;
  return fixture;
}
function args(fixture, extra = []) {
  return [`--from=${seoulToday()}`, `--baseUrl=${fixture.baseUrl}`, "--collectOnly=true", "--fetchResults=false", "--autoPush=true",
    "--verifyAttempts=1", "--verifyDelayMs=0", "--timeoutMs=2000", "--snapshots=snapshots.ndjson", "--results=results.ndjson",
    "--model=model.json", "--retrainStatus=retrain.json", "--status=helper.json", ...extra];
}
async function status(work) { return JSON.parse(await fs.readFile(path.join(work, "helper.json"), "utf8")); }

test("collect-only pushes only compact predictions and verifies exact LF bytes without publishing local user files", async (t) => {
  const { work, remote } = await repository(t);
  const fixture = await fixtureServer(t, remote, [readySnapshot(seoulToday(), "new")]);
  await fs.writeFile(path.join(work, "model.json"), '{"version":"user-change"}\n');
  await fs.writeFile(path.join(work, "results.ndjson"), "user results\n");
  await fs.writeFile(path.join(work, "retrain.json"), '{"user":true}\n');
  await fs.writeFile(path.join(work, "unrelated.txt"), "user change\n");
  const result = await cli(work, args(fixture));
  assert.equal(result.code, 0, result.stderr);
  const saved = await fs.readFile(path.join(work, publishedFile));
  const report = await status(work);
  assert.equal(report.snapshotRowsCollected, 1);
  assert.equal(report.snapshotValidRows, 1);
  assert.equal(report.snapshotHash, sha256(saved));
  assert.equal(report.snapshotBytes, saved.length);
  assert.equal(saved.includes(13), false);
  assert.equal(report.deployment.state, "verified");
  assert.equal(report.deployment.snapshotVerification.remote.snapshotHash, sha256(saved));
  assert.equal(git(remote, "diff-tree", "--no-commit-id", "--name-only", "-r", "main").trim(), publishedFile);
  assert.equal(git(remote, "show", `main:${publishedFile}`), saved.toString());
  assert.equal(git(remote, "ls-tree", "--name-only", "main", "--", "snapshots.ndjson"), "");
  assert.equal(git(remote, "show", "main:model.json"), '{"version":"original"}\n');
  assert.equal(git(remote, "show", "main:results.ndjson"), "");
  assert.equal(git(remote, "show", "main:retrain.json"), '{}\n');
  assert.equal(git(remote, "show", "main:unrelated.txt"), "original\n");
  assert.equal(await fs.readFile(path.join(work, "model.json"), "utf8"), '{"version":"user-change"}\n');
  assert.equal(await fs.readFile(path.join(work, "results.ndjson"), "utf8"), "user results\n");
  assert.equal(await fs.readFile(path.join(work, "retrain.json"), "utf8"), '{"user":true}\n');
  assert.equal(await fs.readFile(path.join(work, "unrelated.txt"), "utf8"), "user change\n");
  assert.deepEqual(fixture.requests.filter((url) => !url.startsWith("/api/predictions/gameday?")), ["/api/predictions/archive/status"]);
  fixture.predictions = [];
  fixture.requests = [];
  assert.equal((await cli(work, args(fixture, ["--verifyDeployment=false"]))).code, 0);
  assert.equal((await status(work)).deployment.state, "pushed_unverified");
  assert.equal((await status(work)).deployment.committed, false);
  assert.ok(fixture.requests.every((url) => url.startsWith("/api/predictions/gameday?")));
});

test("failed push retains collected and past snapshots; zero-new-row retry pushes the saved commit", async (t) => {
  const { work, remote } = await repository(t);
  const original = readySnapshot("20260401", "past");
  await fs.writeFile(path.join(work, "snapshots.ndjson"), ndjson([original]));
  const hook = path.join(remote, "hooks", "pre-receive");
  await fs.writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const fixture = await fixtureServer(t, remote, [readySnapshot(seoulToday(), "new")]);
  const rejected = await cli(work, args(fixture));
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /autoPush failed: git push/);
  assert.equal((await status(work)).deployment.state, "failed");
  const raw = await fs.readFile(path.join(work, "snapshots.ndjson"));
  const saved = await fs.readFile(path.join(work, publishedFile));
  assert.deepEqual(saved.toString().trim().split("\n").map(JSON.parse).map((row) => row.gameKey).sort(), ["new", "past"]);
  const savedCommit = git(work, "rev-parse", "HEAD");
  await fs.unlink(hook);
  fixture.predictions = [];
  const retried = await cli(work, args(fixture));
  assert.equal(retried.code, 0, retried.stderr);
  const report = await status(work);
  assert.equal(report.snapshotRowsCollected, 0);
  assert.equal(report.snapshotCollection, "no_pregame_rows");
  assert.equal(report.snapshotHash, sha256(saved));
  assert.equal(report.deployment.state, "verified");
  assert.equal(report.deployment.committed, false);
  assert.equal(git(work, "rev-parse", "HEAD"), savedCommit);
  assert.equal(git(remote, "rev-parse", "main"), savedCommit);
  assert.deepEqual(await fs.readFile(path.join(work, "snapshots.ndjson")), raw);
  assert.deepEqual(await fs.readFile(path.join(work, publishedFile)), saved);
});

test("unrelated staged changes refuse publication and leave saved past snapshots and index intact", async (t) => {
  const { work, remote } = await repository(t);
  const saved = ndjson([readySnapshot("20260401", "past")]);
  await fs.writeFile(path.join(work, "snapshots.ndjson"), saved);
  await fs.writeFile(path.join(work, "unrelated.txt"), "staged user change\n");
  git(work, "add", "--", "unrelated.txt");
  const before = git(work, "rev-parse", "HEAD");
  const fixture = await fixtureServer(t, remote);
  const result = await cli(work, args(fixture));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /refuses unrelated staged changes: unrelated.txt/);
  assert.equal((await status(work)).deployment.state, "failed");
  assert.equal(git(work, "rev-parse", "HEAD"), before);
  assert.equal(git(remote, "rev-parse", "main"), before);
  assert.equal(git(work, "diff", "--cached", "--name-only").trim(), "unrelated.txt");
  assert.equal(git(work, "show", ":unrelated.txt"), "staged user change\n");
  assert.equal(await fs.readFile(path.join(work, "snapshots.ndjson"), "utf8"), saved);
});

test("divergent remote rejects ordinary push without pulling, resetting or overwriting either branch", async (t) => {
  const { directory, work, remote } = await repository(t);
  const other = path.join(directory, "other");
  git(directory, "clone", remote, other);
  await fs.writeFile(path.join(other, "remote-only.txt"), "remote user change\n");
  git(other, "add", "--", "remote-only.txt");
  git(other, "commit", "-m", "Advance remote independently");
  git(other, "push");
  const remoteHead = git(remote, "rev-parse", "main");
  const fixture = await fixtureServer(t, remote, [readySnapshot(seoulToday(), "new")]);
  const result = await cli(work, args(fixture));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /autoPush failed: git push/);
  assert.equal((await status(work)).deployment.state, "failed");
  assert.equal(git(remote, "rev-parse", "main"), remoteHead);
  assert.notEqual(git(work, "rev-parse", "HEAD"), remoteHead);
  assert.equal(git(work, "rev-list", "--count", "HEAD").trim(), "2");
  await assert.rejects(fs.access(path.join(work, "remote-only.txt")), { code: "ENOENT" });
  assert.equal(git(work, "show", `HEAD:${publishedFile}`), await fs.readFile(path.join(work, publishedFile), "utf8"));
});

test("saved ready pregame rows publish with no new rows, but stale or wrong-schema remote hashes cannot verify", async (t) => {
  const { work, remote } = await repository(t);
  const saved = ` ${JSON.stringify(readySnapshot("20260401", "past"))}\r\n\r\n`;
  await fs.writeFile(path.join(work, "snapshots.ndjson"), saved);
  const fixture = await fixtureServer(t, remote);
  for (const snapshotOverride of [{ featureSchemaVersion: 3, snapshotHash: "stale" }, { featureSchemaVersion: 2, snapshotHash: sha256(saved) }]) {
    fixture.snapshotOverride = snapshotOverride;
    const result = await cli(work, args(fixture));
    assert.equal(result.code, 1);
    const report = await status(work);
    assert.equal(report.ok, false);
    assert.equal(report.failure.stage, "verify-deployment");
    assert.equal(report.deployment.state, "pushed_unverified");
    assert.match(report.deployment.error, /snapshot schema\/hash/);
    const compact = await fs.readFile(path.join(work, publishedFile));
    assert.equal(report.snapshotHash, sha256(compact));
    assert.equal(report.snapshotBytes, compact.length);
    assert.equal(compact.includes(13), false);
    assert.notEqual(report.snapshotHash, sha256(saved));
    assert.equal(report.snapshotRowsCollected, 0);
    assert.equal(report.snapshotValidRows, 1);
    assert.equal(await fs.readFile(path.join(work, "snapshots.ndjson"), "utf8"), saved);
    assert.equal(git(remote, "show", `main:${publishedFile}`), compact.toString());
  }
  fixture.snapshotOverride = undefined;
  const retried = await cli(work, args(fixture));
  assert.equal(retried.code, 0, retried.stderr);
  assert.equal((await status(work)).deployment.state, "verified");
  assert.equal((await status(work)).snapshotRowsCollected, 0);
});

test("no archive or no valid pregame rows explicitly skips deployment without requiring Git", async (t) => {
  const work = await temporary(t);
  const fixture = await fixtureServer(t, null);
  for (const bytes of [null, "", ndjson([readySnapshot("20260401", "late", { asOfTimestamp: "2026-04-01T09:00:00.000Z" })]),
    ndjson([snapshot("20260401", "unavailable")]), ndjson([snapshot("20260401", "status-only", { status: "ready" })])]) {
    if (bytes !== null) await fs.writeFile(path.join(work, "snapshots.ndjson"), bytes);
    const result = await cli(work, args(fixture));
    assert.equal(result.code, 0, result.stderr);
    const report = await status(work);
    assert.equal(report.ok, true);
    assert.equal(report.deployment.state, "not_deployed");
    assert.equal(report.deployment.reason, bytes === null ? "no_snapshot_archive" : "no_valid_pregame_rows");
    assert.equal(report.snapshotValidRows, 0);
    assert.equal(report.snapshotHash, null);
    assert.equal(report.snapshotBytes, 0);
    await assert.rejects(fs.access(path.join(work, publishedFile)), { code: "ENOENT" });
    if (bytes === null) await assert.rejects(fs.access(path.join(work, "snapshots.ndjson")), { code: "ENOENT" });
    else assert.equal(await fs.readFile(path.join(work, "snapshots.ndjson"), "utf8"), bytes);
  }
  assert.ok(fixture.requests.every((url) => url.startsWith("/api/predictions/gameday?")));
});

test("normal retraining publishes model, retrain status and compact predictions and verifies both hashes", async (t) => {
  const { work, remote } = await repository(t);
  const rows = archive();
  await fs.writeFile(path.join(work, "snapshots.ndjson"), ndjson(rows.snapshots.map((row) => readySnapshot(row.gameDate, row.gameKey, { modelInputs: row.modelInputs }))));
  await fs.writeFile(path.join(work, "results.ndjson"), ndjson(rows.results));
  const fixture = await fixtureServer(t, remote);
  const result = await cli(work, args(fixture, ["--collectOnly=false", "--from=20260401", "--to=20260406", "--examples=examples.ndjson", "--holdoutDays=1", "--epochs=200"]));
  assert.equal(result.code, 0, result.stderr);
  const report = await status(work);
  assert.equal(report.deployment.state, "verified");
  assert.equal(report.deployment.modelVerification.remote.modelHash, report.modelHash);
  assert.equal(report.deployment.snapshotVerification.remote.snapshotHash, report.snapshotHash);
  assert.equal(report.snapshotHash, sha256(await fs.readFile(path.join(work, publishedFile))));
  assert.deepEqual(git(remote, "diff-tree", "--no-commit-id", "--name-only", "-r", "main").trim().split("\n").sort(), [publishedFile, "model.json", "retrain.json"].sort());
  assert.equal(git(remote, "ls-tree", "--name-only", "main", "--", "snapshots.ndjson"), "");
  assert.equal(git(remote, "show", "main:results.ndjson"), "");
  assert.deepEqual(fixture.requests, ["/api/model/status", "/api/predictions/archive/status"]);
});

test("legacy raw noise plus five valid ready rows creates only a small compact commit without changing raw bytes", async (t) => {
  const { work, remote } = await repository(t);
  const noise = `${JSON.stringify({ featureSchemaVersion: 1, status: "ready", legacy: "x".repeat(1024) })}\r\n`;
  const ready = Array.from({ length: 5 }, (_, index) => readySnapshot("20260401", `ready-${index}`));
  const excluded = [
    snapshot("20260401", "unavailable"),
    readySnapshot("20260401", "late", { asOfTimestamp: "2026-04-01T09:00:00.000Z" }),
    readySnapshot("20260401", "invalid-probability", { homeWinProbability: 3 }),
  ];
  const raw = ` \r\n${noise.repeat(2048)}${ndjson([...ready, ...excluded])}\r\n`;
  await fs.writeFile(path.join(work, "snapshots.ndjson"), raw);
  const fixture = await fixtureServer(t, remote);
  const result = await cli(work, args(fixture));
  assert.equal(result.code, 0, result.stderr);
  const report = await status(work);
  const compact = await fs.readFile(path.join(work, publishedFile));
  assert.equal(report.snapshotRowsCollected, 0);
  assert.equal(report.snapshotValidRows, 5);
  assert.equal(report.snapshotHash, sha256(compact));
  assert.equal(report.snapshotBytes, compact.length);
  assert.ok(compact.length < 20 * 1024);
  assert.deepEqual(compact.toString().trim().split("\n").map(JSON.parse).map((row) => row.gameKey).sort(), ready.map((row) => row.gameKey));
  assert.equal(await fs.readFile(path.join(work, "snapshots.ndjson"), "utf8"), raw);
  assert.equal(git(remote, "show", `main:${publishedFile}`), compact.toString());
  assert.equal(git(remote, "ls-tree", "--name-only", "main", "--", "snapshots.ndjson"), "");
  assert.equal(git(remote, "diff-tree", "--no-commit-id", "--name-only", "-r", "main").trim(), publishedFile);
});

test("missing raw input can retry publishing existing compact ready records without inventing a raw archive", async (t) => {
  const { work, remote } = await repository(t);
  await fs.mkdir(path.join(work, "data"));
  await fs.writeFile(path.join(work, publishedFile), ndjson([readySnapshot("20260401", "saved")]));
  const fixture = await fixtureServer(t, remote);
  const result = await cli(work, args(fixture));
  assert.equal(result.code, 0, result.stderr);
  const report = await status(work);
  assert.equal(report.snapshotValidRows, 1);
  assert.equal(report.snapshotRowsCollected, 0);
  assert.equal(report.deployment.state, "verified");
  await assert.rejects(fs.access(path.join(work, "snapshots.ndjson")), { code: "ENOENT" });
});

test("custom compact output publishes only the requested path", async (t) => {
  const { work, remote } = await repository(t);
  const fixture = await fixtureServer(t, remote);
  await fs.writeFile(path.join(work, "snapshots.ndjson"), ndjson([readySnapshot("20260401", "saved")]));
  const result = await cli(work, args(fixture, ["--publishedSnapshots=custom.ndjson", "--verifyDeployment=false"]));
  assert.equal(result.code, 0, result.stderr);
  const compact = await fs.readFile(path.join(work, "custom.ndjson"));
  assert.equal((await status(work)).snapshotHash, sha256(compact));
  assert.equal(git(remote, "diff-tree", "--no-commit-id", "--name-only", "-r", "main").trim(), "custom.ndjson");
  await assert.rejects(fs.access(path.join(work, publishedFile)), { code: "ENOENT" });
});

test("raw and compact aliases with any artifact or lock are rejected before any write", async (t) => {
  const work = await temporary(t);
  const raw = ` ${JSON.stringify(readySnapshot("20260401", "saved"))}\r\n`;
  const rawPath = path.join(work, "snapshots.ndjson");
  await fs.writeFile(rawPath, raw);
  await fs.symlink(rawPath, path.join(work, "linked.ndjson"));
  await fs.link(rawPath, path.join(work, "hardlinked.ndjson"));
  for (const collision of [
    "--publishedSnapshots=snapshots.ndjson", "--publishedSnapshots=linked.ndjson",
    "--publishedSnapshots=hardlinked.ndjson", "--publishedSnapshots=model.json",
    "--publishedSnapshots=results.ndjson", "--publishedSnapshots=retrain.json",
    "--publishedSnapshots=helper.json", "--publishedSnapshots=model.json.helper.lock",
    "--publishedSnapshots=data/historical_inputs.kbo.ndjson", "--publishedSnapshots=data/run_training_examples.kbo.ndjson",
    "--publishedSnapshots=snapshots.ndjson/nested.ndjson",
    "--status=snapshots.ndjson", "--results=snapshots.ndjson", "--lock=snapshots.ndjson",
  ]) {
    const result = await cli(work, args({ baseUrl: "http://127.0.0.1:1" }, [collision]));
    assert.equal(result.code, 1, collision);
    assert.match(result.stderr, /Artifact paths must be distinct|ENOTDIR/, collision);
    assert.equal(await fs.readFile(rawPath, "utf8"), raw, collision);
    await assert.rejects(fs.access(path.join(work, "helper.json")), { code: "ENOENT" });
    await assert.rejects(fs.access(path.join(work, "model.json.helper.lock")), { code: "ENOENT" });
    await assert.rejects(fs.access(path.join(work, publishedFile)), { code: "ENOENT" });
  }
});

test("a pending 101 MiB raw blob requires manual backed-up recovery before another commit or push", async (t) => {
  const { work, remote } = await repository(t);
  const rawPath = path.join(work, "snapshots.ndjson");
  const oversized = await fs.open(rawPath, "w");
  try {
    await oversized.truncate(101 * 1024 * 1024);
  } finally {
    await oversized.close();
  }
  git(work, "add", "--", "snapshots.ndjson");
  git(work, "commit", "-m", "Previously rejected oversized raw snapshot commit");
  const before = git(work, "rev-parse", "HEAD");
  const remoteBefore = git(remote, "rev-parse", "main");
  // A smaller working file does not repair the oversized blob in outgoing history.
  const raw = ndjson([readySnapshot("20260401", "saved")]);
  await fs.writeFile(rawPath, raw);
  await fs.writeFile(path.join(remote, "hooks", "pre-receive"), '#!/bin/sh\nprintf called > "$GIT_DIR/push-attempted"\nexit 1\n', { mode: 0o755 });
  const fixture = await fixtureServer(t, remote);
  const result = await cli(work, args(fixture));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /pending oversized Git blob snapshots\.ndjson/);
  assert.match(result.stderr, /Back up.*recover.*local commit history/);
  assert.match(result.stderr, /Deleting or untracking.*does not remove/);
  assert.equal((await status(work)).failure.stage, "deploy-preflight");
  assert.equal((await status(work)).deployment.state, "failed");
  assert.equal(git(work, "rev-parse", "HEAD"), before);
  assert.equal(git(remote, "rev-parse", "main"), remoteBefore);
  assert.equal(git(work, "diff", "--cached", "--name-only"), "");
  assert.equal(await fs.readFile(rawPath, "utf8"), raw);
  await assert.rejects(fs.access(path.join(remote, "push-attempted")), { code: "ENOENT" });
  assert.ok(fixture.requests.every((url) => url.startsWith("/api/predictions/gameday?")));
});

test("training with unavailable-only snapshots publishes model and status but no prediction archive", async (t) => {
  const { work, remote } = await repository(t);
  const rows = archive();
  const raw = ndjson(rows.snapshots);
  await fs.writeFile(path.join(work, "snapshots.ndjson"), raw);
  await fs.writeFile(path.join(work, "results.ndjson"), ndjson(rows.results));
  const fixture = await fixtureServer(t, remote);
  const result = await cli(work, args(fixture, ["--collectOnly=false", "--from=20260401", "--to=20260406", "--examples=examples.ndjson", "--holdoutDays=1", "--epochs=200"]));
  assert.equal(result.code, 0, result.stderr);
  const report = await status(work);
  assert.equal(report.deployment.state, "verified");
  assert.equal(report.snapshotHash, null);
  assert.equal(report.snapshotValidRows, 0);
  assert.equal(report.snapshotBytes, 0);
  assert.equal(report.deployment.snapshotVerification, undefined);
  assert.deepEqual(git(remote, "diff-tree", "--no-commit-id", "--name-only", "-r", "main").trim().split("\n").sort(), ["model.json", "retrain.json"]);
  assert.equal(await fs.readFile(path.join(work, "snapshots.ndjson"), "utf8"), raw);
  assert.deepEqual(fixture.requests, ["/api/model/status"]);
});

test("new unavailable inputs cannot erase a previously published ready prediction", async (t) => {
  const { work, remote } = await repository(t);
  const fixture = await fixtureServer(t, remote, [readySnapshot(seoulToday(), "current")]);
  const first = await cli(work, args(fixture));
  assert.equal(first.code, 0, first.stderr);
  const compact = await fs.readFile(path.join(work, publishedFile));
  const head = git(work, "rev-parse", "HEAD");
  fixture.predictions = [snapshot(seoulToday(), "current", {
    asOfTimestamp: fixture.predictions[0].asOfTimestamp.replace("08:00", "08:30"),
  })];
  const next = await cli(work, args(fixture));
  assert.equal(next.code, 0, next.stderr);
  const report = await status(work);
  assert.equal(report.snapshotRowsCollected, 1);
  assert.equal(report.snapshotValidRows, 1);
  assert.equal(report.snapshotHash, sha256(compact));
  assert.equal(report.deployment.state, "verified");
  assert.equal(report.deployment.committed, false);
  assert.deepEqual(await fs.readFile(path.join(work, publishedFile)), compact);
  assert.equal(git(work, "rev-parse", "HEAD"), head);
  assert.equal(JSON.parse((await fs.readFile(path.join(work, "snapshots.ndjson"), "utf8")).trim()).status, "unavailable");
});
