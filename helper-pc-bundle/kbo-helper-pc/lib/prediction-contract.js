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
      || row.mode !== "post_lineup" || !validateInputs(row.modelInputs)) return false;
  const captured = Date.parse(row.asOfTimestamp);
  const starts = Date.parse(row.gameStartsAt);
  const dataAsOf = Date.parse(row.modelInputs.dataAsOf);
  if (![captured, starts, dataAsOf].every(Number.isFinite)
      || dataAsOf > captured || captured >= starts) return false;
  const gameDate = new Date(starts + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replaceAll("-", "");
  return row.gameDate === gameDate;
}

module.exports = { FEATURE_SCHEMA_VERSION, MODEL_TYPE, validateInputs, isPregameSnapshot };
