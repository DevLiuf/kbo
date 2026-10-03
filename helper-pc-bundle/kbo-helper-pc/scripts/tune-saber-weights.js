const path = require("path");
const { parseArgs } = require("./ml-utils");
const { FEATURE_SCHEMA_VERSION, isPregameSnapshot } = require("../lib/prediction-contract");
const { DEFAULT_SABER_SETTINGS, validateSaberSettings, blendSaberRuns } = require("../lib/saber");
const { assertDateRange, readNdjson, writeJson } = require("../lib/artifacts");
const { assertSupportedRuntime } = require("../lib/runtime");

function meanAbsoluteError(rows, settings) {
  let error = 0;
  for (const { snapshot, result } of rows) {
    const input = snapshot.scoreModelInputs;
    const away = blendSaberRuns(input.baselineAwayRuns, input.markovAwayRuns, input.monteCarloAwayRuns, settings);
    const home = blendSaberRuns(input.baselineHomeRuns, input.markovHomeRuns, input.monteCarloHomeRuns, settings);
    if (!Number.isFinite(away) || !Number.isFinite(home)) throw new Error("Nonfinite candidate prediction");
    error += Math.abs(away - result.awayScore) + Math.abs(home - result.homeScore);
  }
  const mae = error / (rows.length * 2);
  if (!Number.isFinite(mae)) throw new Error("Nonfinite candidate MAE");
  return mae;
}

function settings(baseWeight, markovWeight, monteWeight, clampThreshold) {
  return { baseWeight, markovWeight, monteWeight, clampThreshold };
}

async function main() {
  assertSupportedRuntime();
  const args = parseArgs(process.argv.slice(2));
  if (args.baseUrl !== undefined) throw new Error("--baseUrl was removed: tuning uses only local pregame snapshots and results");
  const from = String(args.from || "");
  const to = String(args.to || from);
  assertDateRange(from, to);
  const minSamples = Number(args.minSamples || 20);
  if (!Number.isInteger(minSamples) || minSamples < 1) throw new Error("--minSamples must be a positive integer");
  const snapshotsPath = path.resolve(String(args.snapshots || "data/prediction_snapshots.ndjson"));
  const resultsPath = path.resolve(String(args.results || "data/game_results.kbo.ndjson"));
  const output = path.resolve(String(args.output || "data/saber_tuning_status.kbo.json"));
  const snapshots = await readNdjson(snapshotsPath);
  const results = await readNdjson(resultsPath);
  const latest = new Map();
  for (const snapshot of snapshots) {
    const key = String(snapshot.gameKey || snapshot.gameId || "").trim();
    const input = snapshot.scoreModelInputs;
    if (!key || !isPregameSnapshot(snapshot) || snapshot.gameDate < from || snapshot.gameDate > to
      || !input || input.saberApplied !== true
      || !Number.isFinite(input.baselineAwayRuns) || !Number.isFinite(input.baselineHomeRuns)
      || ![input.markovAwayRuns, input.markovHomeRuns, input.monteCarloAwayRuns, input.monteCarloHomeRuns].every(Number.isFinite)) continue;
    const previous = latest.get(key);
    if (!previous || Date.parse(snapshot.asOfTimestamp) > Date.parse(previous.asOfTimestamp)) latest.set(key, snapshot);
  }
  const completed = new Map();
  for (const result of results) {
    const key = String(result.gameKey || result.gameId || "").trim();
    if (key && result.completed === true && Number.isFinite(result.homeScore) && Number.isFinite(result.awayScore)
      && result.homeScore >= 0 && result.awayScore >= 0
      && String(result.gameDate) >= from && String(result.gameDate) <= to) completed.set(key, result);
  }
  const rows = [];
  for (const [key, result] of completed) {
    const snapshot = latest.get(key);
    if (snapshot && snapshot.gameDate === String(result.gameDate)) rows.push({ snapshot, result });
  }
  if (rows.length < minSamples) throw new Error(`Insufficient local pregame tuning samples (${rows.length} < ${minSamples}); tuning unchanged`);
  const dates = [...new Set(rows.map(({ snapshot }) => snapshot.gameDate))].sort();
  if (dates.length < 2) throw new Error("Tuning requires at least two distinct game dates; tuning unchanged");
  const split = Math.max(1, Math.min(dates.length - 1, Math.floor(dates.length * 0.7)));
  const tuningDates = new Set(dates.slice(0, split));
  const tuningRows = rows.filter(({ snapshot }) => tuningDates.has(snapshot.gameDate));
  const validationRows = rows.filter(({ snapshot }) => !tuningDates.has(snapshot.gameDate));
  const candidates = [settings(
    DEFAULT_SABER_SETTINGS.baseWeight, DEFAULT_SABER_SETTINGS.markovWeight,
    DEFAULT_SABER_SETTINGS.monteWeight, DEFAULT_SABER_SETTINGS.clampThreshold,
  )];
  for (const clampThreshold of [2.5, 3, 3.5, 4, 4.5]) {
    for (const baseWeight of [0.5, 0.55, 0.6, 0.65, 0.7, 1]) {
      for (const markovWeight of [0, 0.2, 0.25, 0.3, 0.35]) {
        const monteWeight = Number((1 - baseWeight - markovWeight).toFixed(2));
        const candidate = settings(baseWeight, markovWeight, monteWeight, clampThreshold);
        if (validateSaberSettings(candidate)) candidates.push(candidate);
      }
    }
  }
  const scored = candidates.map((candidate) => ({ settings: candidate, mae: meanAbsoluteError(tuningRows, candidate) }));
  scored.sort((a, b) => a.mae - b.mae);
  const best = scored[0].settings;
  const validationMae = meanAbsoluteError(validationRows, best);
  const defaultValidationMae = meanAbsoluteError(validationRows, DEFAULT_SABER_SETTINGS);
  if (validationMae > defaultValidationMae + 1e-12) {
    throw new Error(`Tuning validation quality gate failed (${validationMae} > default ${defaultValidationMae}); tuning unchanged`);
  }
  const payload = {
    ok: true,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    tunedAt: new Date().toISOString(),
    rangeFrom: from,
    rangeTo: to,
    sampleSize: rows.length,
    tuningSamples: tuningRows.length,
    validationSamples: validationRows.length,
    tuningRange: { from: dates[0], to: dates[split - 1] },
    validationRange: { from: dates[split], to: dates[dates.length - 1] },
    tuningMae: scored[0].mae,
    validationMae,
    defaultValidationMae,
    best,
    appliedSettings: best,
    top5: scored.slice(0, 5),
    source: "local-schema2-pregame-scoreModelInputs",
  };
  await writeJson(output, payload);
  console.log(JSON.stringify({ ...payload, output }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
