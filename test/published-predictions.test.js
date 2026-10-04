const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { buildPublishedArchive, isPublishablePrediction } = require("../lib/published-predictions");
const { MODEL_TYPE } = require("../lib/prediction-contract");
const { ndjson, readNdjson, sha256 } = require("../lib/artifacts");
const { snapshot: countSnapshot } = require("./count-fixtures");

function prediction(date = "20260901", key = "game1", overrides = {}) {
  return countSnapshot(date, key, { status: "ready", unavailableCode: null, modelType: MODEL_TYPE,
    predictedWinner: "HOME", predictedAwayScore: 3, predictedHomeScore: 5, expectedAwayRuns: 3.5, expectedHomeRuns: 5.5,
    homeWinProbability: 0.7, awayWinProbability: 0.3, tieAfterNineProbability: 0.1, ...overrides });
}

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kbo-published-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, source: path.join(directory, "raw.ndjson"), archive: path.join(directory, "published.ndjson") };
}

function diagnosticFixture() {
  const history = Array.from({ length: 1000 }, (_, i) => ({ date: String(i), raw: "historical noise".repeat(100) }));
  const starter = { playerId: "123", name: "선발투수", team: "HOME", season: 2026, fip: 3.21, rawFip: 3.01,
    expectedInnings: 5.2, priorOuts: 90, priorFip: 4.2, starts: 10, appearances: 12, outs: 150,
    bb: 10, hbp: 2, strikeouts: 50, sampleScope: "observed starts", recentStarts: history, seasonStats: history };
  const bullpen = { fip: 4.12, rawFip: 4.3, pitches3d: 130, workload: 0.8, games: 11, appearances: 30,
    window: { from: "20260818", to: "20260831", days: 14, dates: history },
    sampleScope: "actual relief appearances", workloadByDate: history, sameDayGames: history, boxes: history };
  return { starter, bullpen, diagnostics: {
    league: { season: 2026, ops: 0.75, era: 4.2, fip: 4.2, fipConstant: 3.1, runsPerGame: 4.5,
      source: "official records", counts: { raw: history } },
    away: { lineupOps: 0.8, starter, bullpen }, home: { lineupOps: 0.9, starter, bullpen },
    park: { stadium: "잠실", factor: 0.95, games: 5, runs: 40, leagueGames: 20, leagueRuns: 180,
      priorGames: 10, window: { from: "20260818", to: "20260831" }, boxes: history },
    window: { from: "20260818", to: "20260831", days: 14, completedGames: 20, dates: history },
    sources: { lineup: "official lineup", hitters: "official hitters", starters: "official starters", bullpen: "official boxes", raw: history },
    shrinkage: { hitterPriorPA: 100, pitcherPriorOuts: 90, parkPriorGames: 10, hitterPrior: "league OPS" },
    rawHistory: history,
  } };
}

test("latest ready pregame forecasts are sorted by date/key without a retention cutoff", async (t) => {
  const { source, archive } = await temporary(t);
  const early = prediction("20260901", "z", { asOfTimestamp: "2026-09-01T07:30:00Z" });
  const latest = prediction("20260901", "z", { homeWinProbability: 0.8, awayWinProbability: 0.2 });
  const rows = [latest, prediction("20260401", "old"), prediction("20260901", "a"), early,
    prediction("20260901", "z", { status: "unavailable", asOfTimestamp: "2026-09-01T08:59:00Z" })];
  const original = ndjson(rows);
  await fs.writeFile(source, original);
  const result = await buildPublishedArchive(source, archive);
  const saved = await readNdjson(archive);
  assert.deepEqual(saved.map((row) => row.gameKey), ["old", "a", "z"]);
  assert.equal(saved[2].asOfTimestamp, latest.asOfTimestamp);
  assert.equal(saved[2].homeWinProbability, 0.8);
  const content = await fs.readFile(archive, "utf8");
  assert.deepEqual(result, { snapshotHash: sha256(content), snapshotValidRows: 3,
    snapshotBytes: Buffer.byteLength(content), sourceMissing: false });
  assert.equal(await fs.readFile(source, "utf8"), original);
  await fs.writeFile(source, ndjson(rows.reverse()));
  assert.equal((await buildPublishedArchive(source, archive)).snapshotHash, result.snapshotHash);
  assert.equal(await fs.readFile(archive, "utf8"), content);
});

test("large legacy and unavailable raw records do not inflate compact publication", async (t) => {
  const { source, archive } = await temporary(t);
  const noise = "legacy history".repeat(200000);
  const original = ndjson([{ featureSchemaVersion: 2, history: noise }, prediction("20260901", "unavailable", {
    status: "unavailable", diagnosticHistory: noise,
  }), prediction()]);
  await fs.writeFile(source, original);
  const result = await buildPublishedArchive(source, archive);
  assert.equal(result.snapshotValidRows, 1);
  assert.ok(result.snapshotBytes < 2000);
  assert.equal(await fs.readFile(source, "utf8"), original);
});

test("scientific validity, timing, identity, and historical provenance are checked before projection", async (t) => {
  const { source, archive } = await temporary(t);
  const row = prediction();
  const invalid = [null, [], {},
    { featureSchemaVersion: 2 }, { gameState: "2" }, { gameState: "3" }, { mode: "historical_reconstruction" },
    { dataOrigin: "historical_reconstruction" }, { reconstructedAt: null }, { inputsCutoffAt: row.asOfTimestamp },
    { sourceThroughDate: "20260831" }, { lineupConfirmed: false }, { status: "unavailable" }, { modelType: "legacy" },
    { asOfTimestamp: row.gameStartsAt }, { asOfTimestamp: "2026-09-01T10:00:00Z" },
    { gameDate: "20260902" }, { modelInputs: null },
    { modelInputs: { ...row.modelInputs, dataAsOf: "2026-09-01T08:01:00Z" } },
    { modelInputs: { ...row.modelInputs, home: { ...row.modelInputs.home, pitchingFipRatio: 0 } } },
    { gameKey: "" }, { awayTeam: " " }, { homeTeam: null },
    { homeWinProbability: 0.9 }, { homeWinProbability: "0.7" }, { tieAfterNineProbability: -0.1 },
    { expectedAwayRuns: 0 }, { expectedHomeRuns: null }, { predictedAwayScore: 1.5 }, { predictedHomeScore: -1 },
  ].map((overrides) => overrides === null || Array.isArray(overrides) || !Object.keys(overrides).length
    ? overrides : { ...row, ...overrides });
  assert.equal(isPublishablePrediction(row), true);
  for (const candidate of invalid) assert.equal(isPublishablePrediction(candidate), false);
  await fs.writeFile(source, ndjson([...invalid, row]));
  assert.equal((await buildPublishedArchive(source, archive)).snapshotValidRows, 1);
  const [saved] = await readNdjson(archive);
  assert.equal(isPublishablePrediction(saved), true);
  assert.equal(saved.asOfTimestamp, row.asOfTimestamp);
});

test("forecast display fields, provenance and diagnostic summaries survive without raw histories", async (t) => {
  const { source, archive } = await temporary(t);
  const { starter, bullpen, diagnostics } = diagnosticFixture();
  const base = prediction();
  const lineup = Array.from({ length: 9 }, (_, i) => ({ order: i + 1, position: "좌익수", name: `타자${i}`,
    playerId: String(i), team: "HOME", season: 2026, ops: 0.8, adjustedOps: 0.79, war: 1.3,
    priorPA: 100, priorOps: 0.75, pa: 300, seasonStats: { raw: "noise".repeat(10000) } }));
  const row = { ...base, gameTime: "18:00", stadium: "잠실", awayTeamId: "A", homeTeamId: "H",
    modelVersion: "count-fixture-v1", modelHash: "sha-fixture", predictionSource: "live_pregame", dataOrigin: "live_pregame",
    predictedRunDiff: 2, awayStarter: starter, homeStarter: "홈 선발", awayLineup: lineup, homeLineup: lineup,
    diagnostics, modelInputs: { ...base.modelInputs, diagnostics, rawSeasonStats: lineup } };
  await fs.writeFile(source, ndjson([row]));
  const result = await buildPublishedArchive(source, archive);
  const [saved] = await readNdjson(archive);
  assert.equal(saved.modelVersion, "count-fixture-v1");
  assert.equal(saved.modelHash, "sha-fixture");
  assert.equal(saved.predictionSource, "live_pregame");
  assert.equal(saved.asOfTimestamp, "2026-09-01T08:00:00.000Z");
  assert.equal(isPublishablePrediction(saved), true);
  for (const side of ["away", "home"]) {
    assert.deepEqual(saved.modelInputs[side], row.modelInputs[side]);
    assert.deepEqual(saved[`${side}Lineup`], lineup.map(({ pa, seasonStats, ...player }) => player));
    for (const data of [saved.diagnostics, saved.modelInputs.diagnostics]) {
      assert.equal(data[side].lineupOps, diagnostics[side].lineupOps);
      assert.equal(data[side].starter.name, starter.name);
      assert.equal(data[side].starter.fip, starter.fip);
      assert.equal(data[side].starter.expectedInnings, starter.expectedInnings);
      assert.equal(data[side].starter.starts, starter.starts);
      assert.equal(data[side].starter.recentStarts, undefined);
      assert.equal(data[side].starter.seasonStats, undefined);
      assert.equal(data[side].bullpen.fip, bullpen.fip);
      assert.equal(data[side].bullpen.pitches3d, bullpen.pitches3d);
      assert.equal(data[side].bullpen.games, bullpen.games);
      assert.deepEqual(data[side].bullpen.window, { from: "20260818", to: "20260831", days: 14 });
      assert.equal(data[side].bullpen.workloadByDate, undefined);
      assert.equal(data[side].bullpen.boxes, undefined);
      assert.equal(data.league.counts, undefined);
      assert.equal(data.rawHistory, undefined);
      assert.deepEqual(data.sources, { lineup: "official lineup", hitters: "official hitters", starters: "official starters", bullpen: "official boxes" });
    }
  }
  assert.equal(saved.modelInputs.dataAsOf, base.modelInputs.dataAsOf);
  assert.equal(saved.modelInputs.rawSeasonStats, undefined);
  assert.equal(saved.awayStarter.recentStarts, undefined);
  assert.ok(result.snapshotBytes < 15000);
});

test("existing compact records merge with raw and survive absent or legacy-only sources", async (t) => {
  const { source, archive } = await temporary(t);
  await fs.writeFile(source, ndjson([prediction("20260401", "old"), prediction()]));
  const first = await buildPublishedArchive(source, archive);
  await fs.unlink(source);
  assert.deepEqual(await buildPublishedArchive(source, archive), { ...first, sourceMissing: true });
  await fs.writeFile(source, ndjson([{ featureSchemaVersion: 2 }, prediction("20260901", "game1", {
    status: "unavailable", asOfTimestamp: "2026-09-01T08:59:00Z",
  })]));
  assert.deepEqual(await buildPublishedArchive(source, archive), first);
  await fs.writeFile(source, ndjson([prediction("20260901", "game1", {
    asOfTimestamp: "2026-09-01T08:30:00Z", homeWinProbability: 0.8, awayWinProbability: 0.2,
  }), prediction("20260902", "new")]));
  const result = await buildPublishedArchive(source, archive);
  const rows = await readNdjson(archive);
  assert.equal(result.snapshotValidRows, 3);
  assert.deepEqual(rows.map((row) => row.gameKey), ["old", "game1", "new"]);
  assert.equal(rows[1].homeWinProbability, 0.8);
});

test("missing or empty valid source without prior predictions creates no publication", async (t) => {
  const { source, archive } = await temporary(t);
  assert.deepEqual(await buildPublishedArchive(source, archive), {
    snapshotHash: null, snapshotValidRows: 0, snapshotBytes: 0, sourceMissing: true,
  });
  await fs.writeFile(source, " \n" + ndjson([{ featureSchemaVersion: 2 }]));
  assert.deepEqual(await buildPublishedArchive(source, archive), {
    snapshotHash: null, snapshotValidRows: 0, snapshotBytes: 0, sourceMissing: false,
  });
  await assert.rejects(fs.access(archive), { code: "ENOENT" });
});

test("malformed raw input fails without touching raw or replacing an existing publication", async (t) => {
  const { directory, source, archive } = await temporary(t);
  await fs.writeFile(source, ndjson([prediction()]));
  await buildPublishedArchive(source, archive);
  const previous = await fs.readFile(archive, "utf8");
  const broken = ndjson([prediction("20260902", "new")]) + "{bad JSON}\n";
  await fs.writeFile(source, broken);
  await assert.rejects(buildPublishedArchive(source, archive), /Malformed prediction JSON.*:2/);
  assert.equal(await fs.readFile(archive, "utf8"), previous);
  assert.equal(await fs.readFile(source, "utf8"), broken);
  assert.deepEqual((await fs.readdir(directory)).sort(), ["published.ndjson", "raw.ndjson"]);
});

test("corrupt or invalid existing compact rows fail rather than disappearing", async (t) => {
  const { source, archive } = await temporary(t);
  await fs.writeFile(source, ndjson([prediction("20260902", "new")]));
  for (const invalid of ["{bad JSON}\n", ndjson([prediction(), { featureSchemaVersion: 2 }]),
    ndjson([prediction("20260901", "historical", { reconstructedAt: null })])]) {
    await fs.writeFile(archive, invalid);
    await assert.rejects(buildPublishedArchive(source, archive), /Malformed prediction JSON|Invalid published prediction/);
    assert.equal(await fs.readFile(archive, "utf8"), invalid);
  }
});

test("10 MiB publication limit fails without pruning or replacing either file", async (t) => {
  const { source, archive } = await temporary(t);
  await fs.writeFile(source, ndjson([prediction()]));
  await buildPublishedArchive(source, archive);
  const previous = await fs.readFile(archive, "utf8");
  const rows = Array.from({ length: 11 }, (_, i) => prediction("20260901", `game${i}`, { stadium: "구".repeat(350000) }));
  const original = ndjson(rows);
  await fs.writeFile(source, original);
  await assert.rejects(buildPublishedArchive(source, archive), /10 MiB/);
  assert.equal(await fs.readFile(archive, "utf8"), previous);
  assert.equal(await fs.readFile(source, "utf8"), original);
});

test("oversized existing compact archives are rejected without overwriting", async (t) => {
  const { source, archive } = await temporary(t);
  const original = ndjson([prediction("20260901", "large", { stadium: "x".repeat(10 * 1024 * 1024) })]);
  await fs.writeFile(archive, original);
  await assert.rejects(buildPublishedArchive(source, archive), /10 MiB/);
  assert.equal(await fs.readFile(archive, "utf8"), original);
});

test("same paths, symlinks, directory aliases and hard links cannot overwrite raw", async (t) => {
  const { directory, source } = await temporary(t);
  const original = ndjson([prediction()]);
  await fs.writeFile(source, original);
  const symbolic = path.join(directory, "symbolic.ndjson");
  const hard = path.join(directory, "hard.ndjson");
  const directoryAlias = path.join(directory, "alias");
  await fs.symlink(source, symbolic);
  await fs.link(source, hard);
  await fs.symlink(directory, directoryAlias);
  for (const archive of [source, path.join(directory, "nested", "..", "raw.ndjson"), symbolic, hard,
    path.join(directoryAlias, "raw.ndjson")]) {
    await assert.rejects(buildPublishedArchive(source, archive), /must be different files/);
    assert.equal(await fs.readFile(source, "utf8"), original);
  }
  const missing = path.join(directory, "missing.ndjson");
  await assert.rejects(buildPublishedArchive(missing, missing), /must be different files/);
});
