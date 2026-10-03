const { isPregameSnapshot } = require("../lib/prediction-contract");
const { validateInputs } = require("../lib/score-model");
const { assertDateRange } = require("../lib/artifacts");

function validateRange(from, to) {
  if (from !== undefined) assertDateRange(from, from);
  if (to !== undefined) assertDateRange(to, to);
  if (from !== undefined && to !== undefined) assertDateRange(from, to);
}
function inRange(row, from, to) {
  return (!from || row.gameDate >= from) && (!to || row.gameDate <= to);
}
function rowRange(rows) {
  const dates = rows.map((row) => row.gameDate).sort();
  return { from: dates[0] || null, to: dates[dates.length - 1] || null };
}
function validateExample(row) {
  return Boolean(row && typeof row.gameKey === "string" && row.gameKey.trim()
    && isPregameSnapshot(row) && validateInputs(row.modelInputs)
    && Number.isInteger(row.homeScore) && row.homeScore >= 0
    && Number.isInteger(row.awayScore) && row.awayScore >= 0);
}
function eligibleExamples(rows, from, to) {
  validateRange(from, to);
  for (const row of rows) {
    if (!row) throw new Error("Invalid count example");
    assertDateRange(row.gameDate, row.gameDate);
  }
  const selected = rows.filter((row) => inRange(row, from, to));
  const keys = new Set();
  for (const row of selected) {
    if (!validateExample(row)) throw new Error(`Invalid schema-3 count example: ${row.gameKey || "unknown"}`);
    if (keys.has(row.gameKey)) throw new Error(`Duplicate count game: ${row.gameKey}`);
    keys.add(row.gameKey);
  }
  return selected.sort((a, b) => a.gameDate.localeCompare(b.gameDate) || a.gameKey.localeCompare(b.gameKey));
}
function rejectObsoleteOptions(options) {
  for (const name of ["marketOdds", "calibrationDays", "minTuneSample", "tuning", "minSamples", "preLineupShrink", "temperature"]) {
    if (options[name] !== undefined) throw new Error(`--${name} is unsupported by the confirmed-lineup count model`);
  }
}
module.exports = { validateRange, inRange, rowRange, validateExample, eligibleExamples, rejectObsoleteOptions };
