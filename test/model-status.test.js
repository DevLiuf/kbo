const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { createHash } = require("crypto");
const { MODEL_TYPE } = require("../lib/score-model");

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("HTTP model status never falls back to discarded coefficients and requires independent count validation", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kbo-count-status-"));
  const previous = process.env.KBO_DATA_DIR;
  process.env.KBO_DATA_DIR = directory;
  const app = require("../server");
  if (previous === undefined) delete process.env.KBO_DATA_DIR;
  else process.env.KBO_DATA_DIR = previous;
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(directory, "model_coefficients.kbo.json"), JSON.stringify({ version: "legacy", intercept: 0 }));
  const modelFile = path.join(directory, "run_model.kbo.json");
  const url = `http://127.0.0.1:${server.address().port}/api/model/status`;
  const missingResponse = await fetch(url);
  assert.equal(missingResponse.status, 200);
  assert.equal(missingResponse.headers.get("cache-control"), "no-store");
  const missing = await missingResponse.json();
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.unavailableCode, "MODEL_NOT_TRAINED");
  assert.equal(missing.modelVersion, null);
  const model = { modelType: MODEL_TYPE, featureSchemaVersion: 3, version: "fixture-count-v1", intercept: 0,
    coefficients: { lineupOps: 1, pitchingFip: 1, bullpenWorkload: 0.1, park: 1, home: 0.05 },
    trainingRange: { from: "20260401", to: "20260402" }, validationRange: { from: "20260403", to: "20260403" },
    validationIndependent: false, metrics: { validation: { samples: 5, decisiveGames: 4, poissonNll: 2, mae: 1,
      logLoss: 0.6, brier: 0.2 } } };
  await fs.writeFile(modelFile, JSON.stringify(model));
  assert.equal((await (await fetch(url)).json()).status, "unavailable");
  const bytes = JSON.stringify({ ...model, validationIndependent: true });
  await fs.writeFile(modelFile, bytes);
  const ready = await (await fetch(url)).json();
  assert.equal(ready.status, "ready");
  assert.equal(ready.modelHash, hash(bytes));
  assert.equal(ready.modelType, MODEL_TYPE);
  assert.equal(ready.modelValidationIndependent, true);
  await fs.writeFile(modelFile, JSON.stringify({ ...model, validationIndependent: true,
    trainingRange: { from: "20260401", to: "20260403" } }));
  assert.equal((await (await fetch(url)).json()).status, "unavailable");
  const nextBytes = JSON.stringify({ ...model, validationIndependent: true, version: "fixture-count-v2", intercept: 0.1 });
  await fs.writeFile(modelFile, nextBytes);
  const next = await (await fetch(url)).json();
  assert.equal(next.modelVersion, "fixture-count-v2");
  assert.equal(next.modelHash, hash(nextBytes));
  assert.notEqual(next.modelHash, ready.modelHash);
});
