const fs = require("fs/promises");
const path = require("path");
const readline = require("readline");
const { atomicWrite, sha256 } = require("./artifacts");
const { MODEL_TYPE, isPregameSnapshot } = require("./prediction-contract");

const MAX_PUBLISHED_BYTES = 10 * 1024 * 1024;
const METADATA_FIELDS = [
  "league", "gameId", "gameKey", "gameDate", "gameTime", "gameStartsAt", "gameState", "stadium",
  "awayTeam", "homeTeam", "awayTeamId", "homeTeamId", "status", "featureSchemaVersion", "mode",
  "lineupConfirmed", "trainingEligible", "asOfTimestamp", "dataOrigin", "predictionSource",
  "archivedPredictionAsOf", "modelType", "modelVersion", "modelHash", "awayWinProbability",
  "homeWinProbability", "tieAfterNineProbability", "expectedAwayRuns", "expectedHomeRuns",
  "predictedAwayScore", "predictedHomeScore", "predictedWinner", "predictedRunDiff",
  "actualAwayScore", "actualHomeScore", "actualWinner", "predictionHit",
];
const INPUT_FIELDS = ["lineupOpsRatio", "pitchingFipRatio", "bullpenWorkload", "parkRunFactor", "home"];
const LINEUP_FIELDS = ["order", "position", "name", "playerId", "team", "season", "war", "ops", "adjustedOps", "priorPA", "priorOps"];
const PITCHER_FIELDS = [
  "playerId", "name", "playerName", "team", "season", "fip", "rawFip", "priorOuts", "priorFip",
  "expectedInnings", "starts", "appearances", "games", "outs", "tbf", "hits", "homeRuns",
  "bb", "hbp", "strikeouts", "runs", "earnedRuns", "pitches", "pitches3d", "workload", "sampleScope",
];
const WINDOW_FIELDS = ["from", "to", "days", "completedGames"];

function isPublishablePrediction(row) {
  return isPregameSnapshot(row) && row.status === "ready" && row.modelType === MODEL_TYPE
    && [row.gameKey, row.awayTeam, row.homeTeam].every((value) => typeof value === "string" && value.trim())
    && [row.homeWinProbability, row.awayWinProbability, row.tieAfterNineProbability]
      .every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    && Math.abs(row.homeWinProbability + row.awayWinProbability - 1) < 1e-9
    && [row.expectedAwayRuns, row.expectedHomeRuns].every((value) => Number.isFinite(value) && value > 0)
    && [row.predictedAwayScore, row.predictedHomeScore].every((value) => Number.isInteger(value) && value >= 0);
}

// Explicit scalar allowlists prevent diagnostic histories and raw season tables from leaking into Git.
function scalars(value, fields) {
  const result = {};
  for (const field of fields) {
    const item = value?.[field];
    if (item === null || typeof item === "string" || typeof item === "boolean" || Number.isFinite(item)) result[field] = item;
  }
  return result;
}

function pitcher(value) {
  if (typeof value === "string" || value == null) return value;
  const result = scalars(value, PITCHER_FIELDS);
  if (value.window) result.window = scalars(value.window, WINDOW_FIELDS);
  return result;
}

function diagnostics(value) {
  if (!value || typeof value !== "object") return value == null ? value : undefined;
  const result = {};
  if (value.league) result.league = scalars(value.league, ["season", "ops", "era", "fip", "runsPerGame", "fipConstant", "source"]);
  for (const side of ["away", "home"]) {
    if (!value[side]) continue;
    result[side] = scalars(value[side], ["lineupOps"]);
    for (const role of ["starter", "bullpen"]) {
      if (Object.hasOwn(value[side], role)) result[side][role] = pitcher(value[side][role]);
    }
  }
  if (value.park) {
    result.park = scalars(value.park, ["stadium", "factor", "games", "runs", "leagueGames", "leagueRuns", "priorGames", "sampleScope"]);
    if (value.park.window) result.park.window = scalars(value.park.window, WINDOW_FIELDS);
  }
  if (value.window) result.window = scalars(value.window, WINDOW_FIELDS);
  if (value.sources) result.sources = scalars(value.sources, ["lineup", "hitters", "starters", "bullpen"]);
  if (value.shrinkage) result.shrinkage = scalars(value.shrinkage, ["hitterPriorPA", "pitcherPriorOuts", "parkPriorGames", "hitterPrior", "pitcherPrior", "parkPrior"]);
  return result;
}

function projectPrediction(row) {
  const result = scalars(row, METADATA_FIELDS);
  for (const side of ["away", "home"]) {
    const lineup = row[`${side}Lineup`];
    if (Array.isArray(lineup)) result[`${side}Lineup`] = lineup.map((player) => scalars(player, LINEUP_FIELDS));
    if (Object.hasOwn(row, `${side}Starter`)) result[`${side}Starter`] = pitcher(row[`${side}Starter`]);
  }
  result.modelInputs = scalars(row.modelInputs, ["leagueRunsPerGame", "dataAsOf"]);
  for (const side of ["away", "home"]) result.modelInputs[side] = scalars(row.modelInputs[side], INPUT_FIELDS);
  if (Object.hasOwn(row.modelInputs, "diagnostics")) result.modelInputs.diagnostics = diagnostics(row.modelInputs.diagnostics);
  if (Object.hasOwn(row, "diagnostics")) result.diagnostics = diagnostics(row.diagnostics);
  return result;
}

async function statIfPresent(file) {
  try { return await fs.stat(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function canonicalPath(file) {
  try { return await fs.realpath(file); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await canonicalPath(parent), path.basename(file));
  }
}

async function scan(file, consume) {
  let handle;
  try { handle = await fs.open(file, "r"); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  const stream = handle.createReadStream({ encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); }
      catch (error) { throw new Error(`Malformed prediction JSON in ${file}:${lineNumber}`, { cause: error }); }
      consume(row, lineNumber);
    }
  } finally {
    lines.close();
    stream.destroy();
    await handle.close();
  }
  return true;
}

async function buildPublishedArchive(sourcePath, archivePath) {
  const source = path.resolve(sourcePath);
  const archive = path.resolve(archivePath);
  const [sourceCanonical, archiveCanonical, sourceStat, archiveStat] = await Promise.all([
    canonicalPath(source), canonicalPath(archive), statIfPresent(source), statIfPresent(archive),
  ]);
  if (sourceCanonical === archiveCanonical || (sourceStat && archiveStat
      && sourceStat.dev === archiveStat.dev && sourceStat.ino === archiveStat.ino)) {
    throw new Error("Prediction source and published archive must be different files");
  }
  if (archiveStat && archiveStat.size > MAX_PUBLISHED_BYTES) throw new Error("Published prediction archive exceeds the 10 MiB limit");

  const latest = new Map();
  function merge(row, strict, lineNumber) {
    // Validate the original row, before projection can remove historical reconstruction markers.
    if (!isPublishablePrediction(row)) {
      if (strict) throw new Error(`Invalid published prediction in ${archive}:${lineNumber}`);
      return;
    }
    const timestamp = Date.parse(row.asOfTimestamp);
    const prior = latest.get(row.gameKey);
    if (prior && prior.timestamp >= timestamp) return;
    const line = `${JSON.stringify(projectPrediction(row))}\n`;
    latest.set(row.gameKey, { gameDate: row.gameDate, gameKey: row.gameKey, timestamp, line });
  }
  await scan(archive, (row, lineNumber) => merge(row, true, lineNumber));
  const sourcePresent = await scan(source, (row, lineNumber) => merge(row, false, lineNumber));
  const rows = [...latest.values()].sort((a, b) => {
    const left = `${a.gameDate}:${a.gameKey}`;
    const right = `${b.gameDate}:${b.gameKey}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const snapshotBytes = rows.reduce((total, row) => total + Buffer.byteLength(row.line), 0);
  if (snapshotBytes > MAX_PUBLISHED_BYTES) throw new Error("Published prediction archive exceeds the 10 MiB limit; no records were removed");
  if (!rows.length) return { snapshotHash: null, snapshotValidRows: 0, snapshotBytes: 0, sourceMissing: !sourcePresent };
  const content = rows.map((row) => row.line).join("");
  await atomicWrite(archive, content);
  return { snapshotHash: sha256(content), snapshotValidRows: rows.length, snapshotBytes, sourceMissing: !sourcePresent };
}

module.exports = { buildPublishedArchive, isPublishablePrediction };
