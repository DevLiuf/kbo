const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { createHash } = require("crypto");
const { FEATURE_NAMES } = require("../lib/logistic");

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("model status reports exact deployed bytes and only applies validated schema2 tuning", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kbo-status-test-"));
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
  const model = { ...Object.fromEntries(FEATURE_NAMES.map((name) => [name, 0])), featureSchemaVersion: 2,
    intercept: 0.125, plattA: 1, plattB: 0, temperature: 1, preLineupShrink: 0.75,
    version: "fixture-v1", calibrationRange: { from: "20260402", to: "20260402" },
    validationRange: { from: "20260403", to: "20260403" } };
  const modelFile = path.join(directory, "model_coefficients.kbo.json");
  const tuningFile = path.join(directory, "saber_tuning_status.kbo.json");
  const modelBytes = `${JSON.stringify(model)}\n`;
  await fs.writeFile(modelFile, modelBytes);
  const settings = { baseWeight: 0.5, markovWeight: 0.3, monteWeight: 0.2, clampThreshold: 4 };
  await fs.writeFile(tuningFile, JSON.stringify({ best: settings, sampleSize: 40 }));
  const url = `http://127.0.0.1:${server.address().port}/api/model/status`;
  const firstResponse = await fetch(url);
  assert.equal(firstResponse.status, 200);
  assert.equal(firstResponse.headers.get("cache-control"), "no-store");
  const first = await firstResponse.json();
  assert.equal(first.modelHash, hash(modelBytes));
  assert.equal(first.saberSettingsSource, "default");
  assert.equal(first.modelValidationIndependent, true);
  await fs.writeFile(tuningFile, JSON.stringify({ featureSchemaVersion: 2, best: settings,
    sampleSize: 40, validationSamples: 10, validationMae: 1.5, defaultValidationMae: 2 }));
  const tuned = await (await fetch(url)).json();
  assert.deepEqual(tuned.saberSettings, settings);
  assert.equal(tuned.saberSettingsHash, hash(JSON.stringify(settings)));
  assert.equal(tuned.saberSettingsSource, "validated_tuning");
  const nextBytes = JSON.stringify({ ...model, version: "fixture-v2", intercept: -0.25 });
  await fs.writeFile(modelFile, nextBytes);
  const next = await (await fetch(url)).json();
  assert.equal(next.modelVersion, "fixture-v2");
  assert.equal(next.modelHash, hash(nextBytes));
  assert.notEqual(next.modelHash, first.modelHash);
});
