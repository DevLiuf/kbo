const FEATURE_SCHEMA_VERSION = 3;
const MODEL_TYPE = "confirmed-lineup-poisson-v1";

function validateInputs(inputs) {
  if (!inputs || !Number.isFinite(inputs.leagueRunsPerGame) || inputs.leagueRunsPerGame <= 0
      || typeof inputs.dataAsOf !== "string" || !Number.isFinite(Date.parse(inputs.dataAsOf))) return false;
  for (const [name, home] of [["away", 0], ["home", 1]]) {
    const side = inputs[name];
    if (!side || side.home !== home
        || !Number.isFinite(side.bullpenWorkload) || side.bullpenWorkload < 0
        || !["lineupOpsRatio", "pitchingFipRatio", "parkRunFactor"]
          .every((key) => Number.isFinite(side[key]) && side[key] > 0)) return false;
  }
  return true;
}

function isPregameSnapshot(row) {
  if (!row || row.featureSchemaVersion !== FEATURE_SCHEMA_VERSION
      || String(row.gameState) !== "1" || row.lineupConfirmed !== true
      || row.dataOrigin === "historical_reconstruction" || Object.hasOwn(row, "reconstructedAt")
      || Object.hasOwn(row, "inputsCutoffAt") || Object.hasOwn(row, "sourceThroughDate")
      || row.mode !== "post_lineup" || !validateInputs(row.modelInputs)) return false;
  const captured = Date.parse(row.asOfTimestamp);
  const starts = Date.parse(row.gameStartsAt);
  const dataAsOf = Date.parse(row.modelInputs.dataAsOf);
  if (![captured, starts, dataAsOf].every(Number.isFinite)
      || dataAsOf > captured || captured >= starts) return false;
  const gameDate = new Date(starts + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replaceAll("-", "");
  return row.gameDate === gameDate;
}

function validDate(text) {
  if (typeof text !== "string" || !/^\d{8}$/.test(text)) return false;
  const iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso;
}

function isoTimestamp(text) {
  return typeof text === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(text)
    && validDate(text.slice(0, 10).replaceAll("-", ""))
    && Number.isFinite(Date.parse(text));
}

function initialLineup(rows) {
  return Array.isArray(rows) && rows.length === 9
    && rows.every((row, index) => row && row.order === index + 1
      && typeof row.name === "string" && row.name.trim())
    && new Set(rows.map((row) => row.name.trim())).size === 9;
}

function isHistoricalTrainingSnapshot(row) {
  if (!row || row.league !== "kbo" || row.featureSchemaVersion !== FEATURE_SCHEMA_VERSION
      || row.mode !== "historical_reconstruction" || row.dataOrigin !== "historical_reconstruction"
      || String(row.gameState) !== "3" || row.lineupConfirmed !== true || row.trainingEligible !== true
      || typeof row.gameId !== "string" || !row.gameId.trim() || row.gameKey !== row.gameId
      || ![row.awayTeam, row.homeTeam].every((team) => typeof team === "string" && team.trim())
      || !validDate(row.gameDate) || !validDate(row.sourceThroughDate)
      || row.sourceThroughDate >= row.gameDate || !validateInputs(row.modelInputs)
      || !initialLineup(row.awayLineup) || !initialLineup(row.homeLineup)
      || ![row.gameStartsAt, row.asOfTimestamp, row.reconstructedAt, row.inputsCutoffAt].every(isoTimestamp)
      || row.asOfTimestamp !== row.reconstructedAt || row.modelInputs.dataAsOf !== row.inputsCutoffAt) return false;
  const starts = Date.parse(row.gameStartsAt);
  const reconstructed = Date.parse(row.reconstructedAt);
  const gameDate = new Date(starts + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replaceAll("-", "");
  const iso = `${row.gameDate.slice(0, 4)}-${row.gameDate.slice(4, 6)}-${row.gameDate.slice(6, 8)}`;
  const cutoff = Date.parse(`${iso}T00:00:00+09:00`);
  return gameDate === row.gameDate && Date.parse(row.inputsCutoffAt) === cutoff
    && reconstructed > starts && reconstructed <= Date.now();
}

function isTrainingSnapshot(row) {
  return isPregameSnapshot(row) || isHistoricalTrainingSnapshot(row);
}

module.exports = { FEATURE_SCHEMA_VERSION, MODEL_TYPE, validateInputs, isPregameSnapshot,
  isHistoricalTrainingSnapshot, isTrainingSnapshot };
