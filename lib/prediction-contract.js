const FEATURE_SCHEMA_VERSION = 2;

function isPregameSnapshot(row) {
  if (!row || row.featureSchemaVersion !== FEATURE_SCHEMA_VERSION
    || String(row.gameState) !== "1" || !row.features || typeof row.features !== "object"
    || Array.isArray(row.features)) {
    return false;
  }
  const captured = Date.parse(row.asOfTimestamp);
  const starts = Date.parse(row.gameStartsAt);
  if (!Number.isFinite(captured) || !Number.isFinite(starts) || captured >= starts) {
    return false;
  }
  const gameDate = new Date(starts + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replaceAll("-", "");
  return row.gameDate === gameDate;
}

module.exports = { FEATURE_SCHEMA_VERSION, isPregameSnapshot };
