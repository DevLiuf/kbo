const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");
const { ndjson, seoulToday, sha256 } = require("../lib/artifacts");
const { snapshot, archive } = require("./count-fixtures");

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
          featureSchemaVersion: 3, snapshotHash: sha256(git(remote, "show", "main:snapshots.ndjson")),
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

test("collect-only pushes only snapshots and verifies exact remote bytes without publishing local user files", async (t) => {
  const { work, remote } = await repository(t);
  const fixture = await fixtureServer(t, remote, [snapshot(seoulToday(), "new")]);
  await fs.writeFile(path.join(work, "model.json"), '{"version":"user-change"}\n');
  await fs.writeFile(path.join(work, "results.ndjson"), "user results\n");
  await fs.writeFile(path.join(work, "retrain.json"), '{"user":true}\n');
  await fs.writeFile(path.join(work, "unrelated.txt"), "user change\n");
  const result = await cli(work, args(fixture));
  assert.equal(result.code, 0, result.stderr);
  const saved = await fs.readFile(path.join(work, "snapshots.ndjson"));
  const report = await status(work);
  assert.equal(report.snapshotRowsCollected, 1);
  assert.equal(report.snapshotValidRows, 1);
  assert.equal(report.snapshotHash, sha256(saved));
  assert.equal(report.deployment.state, "verified");
  assert.equal(report.deployment.snapshotVerification.remote.snapshotHash, sha256(saved));
  assert.equal(git(remote, "diff-tree", "--no-commit-id", "--name-only", "-r", "main").trim(), "snapshots.ndjson");
  assert.equal(git(remote, "show", "main:snapshots.ndjson"), saved.toString());
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
  const original = snapshot("20260401", "past", { status: "ready", predictionSource: "live_pregame" });
  await fs.writeFile(path.join(work, "snapshots.ndjson"), ndjson([original]));
  const hook = path.join(remote, "hooks", "pre-receive");
  await fs.writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const fixture = await fixtureServer(t, remote, [snapshot(seoulToday(), "new")]);
  const rejected = await cli(work, args(fixture));
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /autoPush failed: git push/);
  assert.equal((await status(work)).deployment.state, "failed");
  const saved = await fs.readFile(path.join(work, "snapshots.ndjson"));
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
  assert.deepEqual(await fs.readFile(path.join(work, "snapshots.ndjson")), saved);
});

test("unrelated staged changes refuse publication and leave saved past snapshots and index intact", async (t) => {
  const { work, remote } = await repository(t);
  const saved = ndjson([snapshot("20260401", "past")]);
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
  const fixture = await fixtureServer(t, remote, [snapshot(seoulToday(), "new")]);
  const result = await cli(work, args(fixture));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /autoPush failed: git push/);
  assert.equal((await status(work)).deployment.state, "failed");
  assert.equal(git(remote, "rev-parse", "main"), remoteHead);
  assert.notEqual(git(work, "rev-parse", "HEAD"), remoteHead);
  assert.equal(git(work, "rev-list", "--count", "HEAD").trim(), "2");
  await assert.rejects(fs.access(path.join(work, "remote-only.txt")), { code: "ENOENT" });
  assert.equal(git(work, "show", "HEAD:snapshots.ndjson"), await fs.readFile(path.join(work, "snapshots.ndjson"), "utf8"));
});

test("saved ready pregame rows publish with no new rows, but stale or wrong-schema remote hashes cannot verify", async (t) => {
  const { work, remote } = await repository(t);
  const saved = ` ${JSON.stringify(snapshot("20260401", "past", { status: "ready", predictionSource: "live_pregame" }))}\r\n\r\n`;
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
    assert.equal(report.snapshotHash, sha256(saved));
    assert.equal(report.snapshotRowsCollected, 0);
    assert.equal(report.snapshotValidRows, 1);
    assert.equal(await fs.readFile(path.join(work, "snapshots.ndjson"), "utf8"), saved);
    assert.equal(git(remote, "show", "main:snapshots.ndjson"), saved);
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
  for (const bytes of [null, "", ndjson([snapshot("20260401", "late", { asOfTimestamp: "2026-04-01T09:00:00.000Z" })])]) {
    if (bytes !== null) await fs.writeFile(path.join(work, "snapshots.ndjson"), bytes);
    const result = await cli(work, args(fixture));
    assert.equal(result.code, 0, result.stderr);
    const report = await status(work);
    assert.equal(report.ok, true);
    assert.equal(report.deployment.state, "not_deployed");
    assert.equal(report.deployment.reason, bytes === null ? "no_snapshot_archive" : "no_valid_pregame_rows");
    assert.equal(report.snapshotValidRows, 0);
    assert.equal(report.snapshotHash, bytes === null ? null : sha256(bytes));
    if (bytes === null) await assert.rejects(fs.access(path.join(work, "snapshots.ndjson")), { code: "ENOENT" });
    else assert.equal(await fs.readFile(path.join(work, "snapshots.ndjson"), "utf8"), bytes);
  }
  assert.ok(fixture.requests.every((url) => url.startsWith("/api/predictions/gameday?")));
});

test("normal retraining publishes model, retrain status and existing snapshots and verifies both hashes", async (t) => {
  const { work, remote } = await repository(t);
  const rows = archive();
  await fs.writeFile(path.join(work, "snapshots.ndjson"), ndjson(rows.snapshots));
  await fs.writeFile(path.join(work, "results.ndjson"), ndjson(rows.results));
  const fixture = await fixtureServer(t, remote);
  const result = await cli(work, args(fixture, ["--collectOnly=false", "--from=20260401", "--to=20260406", "--examples=examples.ndjson", "--holdoutDays=1", "--epochs=200"]));
  assert.equal(result.code, 0, result.stderr);
  const report = await status(work);
  assert.equal(report.deployment.state, "verified");
  assert.equal(report.deployment.modelVerification.remote.modelHash, report.modelHash);
  assert.equal(report.deployment.snapshotVerification.remote.snapshotHash, report.snapshotHash);
  assert.equal(report.snapshotHash, sha256(await fs.readFile(path.join(work, "snapshots.ndjson"))));
  assert.deepEqual(git(remote, "diff-tree", "--no-commit-id", "--name-only", "-r", "main").trim().split("\n").sort(), ["model.json", "retrain.json", "snapshots.ndjson"]);
  assert.equal(git(remote, "show", "main:results.ndjson"), "");
  assert.deepEqual(fixture.requests, ["/api/model/status", "/api/predictions/archive/status"]);
});
