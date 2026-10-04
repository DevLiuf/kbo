const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { createHash } = require("crypto");
const { MODEL_TYPE } = require("../lib/score-model");
const { snapshot } = require("./count-fixtures");

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("deployed archive identity distinguishes missing, changed and unreadable files and serves saved pregame forecasts", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kbo-archive-status-"));
  const previous = process.env.KBO_DATA_DIR;
  process.env.KBO_DATA_DIR = directory;
  const app = require("../server");
  if (previous === undefined) delete process.env.KBO_DATA_DIR;
  else process.env.KBO_DATA_DIR = previous;
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = `${base}/api/predictions/archive/status`;
  const file = path.join(directory, "prediction_snapshots.ndjson");
  const missing = await fetch(url);
  assert.equal(missing.status, 200);
  assert.equal(missing.headers.get("cache-control"), "no-store");
  assert.deepEqual(await missing.json(), { featureSchemaVersion: 3, snapshotHash: null });

  const row = snapshot("20260401", "20260401AWAYHOME0", {
    status: "ready", unavailableCode: null, modelType: MODEL_TYPE,
    awayWinProbability: 0.4, homeWinProbability: 0.6, tieAfterNineProbability: 0.1,
    expectedAwayRuns: 3.5, expectedHomeRuns: 4.5, predictedAwayScore: 3, predictedHomeScore: 4,
  });
  const bytes = `${JSON.stringify(row)}\n`;
  await fs.writeFile(file, bytes);
  assert.deepEqual(await (await fetch(url)).json(), { featureSchemaVersion: 3, snapshotHash: hash(bytes) });
  await fs.writeFile(file, `${bytes}\n`);
  const changed = await (await fetch(url)).json();
  assert.equal(changed.snapshotHash, hash(`${bytes}\n`));
  assert.notEqual(changed.snapshotHash, hash(bytes));

  const realFetch = global.fetch;
  t.mock.method(global, "fetch", (input, options) => {
    if (String(input).startsWith(base)) return realFetch(input, options);
    assert.equal(String(input), "https://www.koreabaseball.com/ws/Main.asmx/GetKboGameList");
    return Promise.resolve({ ok: true, json: async () => ({ code: "100", game: [{
      G_DT: row.gameDate, G_ID: row.gameKey, G_TM: "18:00", GAME_STATE_SC: "3", S_NM: "잠실",
      AWAY_NM: row.awayTeam, HOME_NM: row.homeTeam, AWAY_ID: "AWAY", HOME_ID: "HOME",
      T_SCORE_CN: "3", B_SCORE_CN: "5", CANCEL_SC_NM: "",
    }] }) });
  });
  const response = await fetch(`${base}/api/predictions/gameday?date=20260401&includeFinished=true`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.readyGameCount, 1);
  assert.equal(payload.predictions[0].predictionSource, "archived_pregame");
  assert.equal(payload.predictions[0].homeWinProbability, row.homeWinProbability);
  assert.equal(payload.predictions[0].archivedPredictionAsOf, row.asOfTimestamp);
  assert.equal(payload.predictions[0].actualHomeScore, 5);

  await fs.unlink(file);
  await fs.mkdir(file);
  const failure = await fetch(url);
  assert.equal(failure.status, 503);
  assert.equal(failure.headers.get("cache-control"), "no-store");
  assert.deepEqual(await failure.json(), { error: "Prediction archive status unavailable." });
});
