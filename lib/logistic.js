const fs = require("fs/promises");
const { FEATURE_SCHEMA_VERSION, isPregameSnapshot } = require("./prediction-contract");

const FEATURE_NAMES = Object.freeze([
  "offenseDiff", "defenseDiff", "starterEraDiff", "runCreationResidualDiff",
  "powerContactMixDiff", "starterHitsPer9Diff", "starterHrPer9Diff",
  "starterFreePassPer9Diff", "starterSoPer9Diff", "starterRunsPer9Diff",
  "whipDiff", "bullpenDiff", "homeAdvantage", "lineupSignal", "lineupWarDiff",
]);

function sigmoid(value) {
  return value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
}

function linearScore(model, features) {
  let score = model.intercept;
  for (const name of FEATURE_NAMES) {
    const coefficient = name === "lineupWarDiff" && model[name] === undefined ? 0 : model[name];
    score += coefficient * features[name];
  }
  return score;
}

function calibratedProbability(model, features) {
  return Math.max(1e-9, Math.min(1 - 1e-9,
    sigmoid((model.plattA * linearScore(model, features) + model.plattB) / model.temperature)));
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{8}$/.test(value)) return false;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const timestamp = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === iso;
}

function validateRange(from, to) {
  if ((from !== undefined && !validDate(from)) || (to !== undefined && !validDate(to))
      || (from !== undefined && to !== undefined && from > to)) {
    throw new Error("Date range must contain valid YYYYMMDD dates with from <= to");
  }
}

function inRange(row, from, to) {
  return (!from || row.gameDate >= from) && (!to || row.gameDate <= to);
}

function validateExample(row) {
  return row && row.featureSchemaVersion === FEATURE_SCHEMA_VERSION
    && typeof row.gameKey === "string" && row.gameKey.length > 0
    && validDate(row.gameDate) && (row.labelHomeWin === 0 || row.labelHomeWin === 1)
    && FEATURE_NAMES.every((name) => Number.isFinite(row[name]))
    && Number.isFinite(row.homeScore) && Number.isFinite(row.awayScore)
    && row.homeScore >= 0 && row.awayScore >= 0 && row.homeScore !== row.awayScore
    && row.labelHomeWin === (row.homeScore > row.awayScore ? 1 : 0)
    && isPregameSnapshot({ ...row, features: row });
}

function validateModel(model) {
  return model && model.featureSchemaVersion === FEATURE_SCHEMA_VERSION
    && Number.isFinite(model.intercept) && FEATURE_NAMES.every((name) => Number.isFinite(model[name]))
    && Number.isFinite(model.plattA) && model.plattA > 0 && Number.isFinite(model.plattB)
    && Number.isFinite(model.temperature) && model.temperature > 0;
}

async function readRows(filePath, optional = false) {
  let content;
  try { content = await fs.readFile(filePath, "utf8"); }
  catch (error) { if (optional && error.code === "ENOENT") return []; throw error; }
  return content.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function eligibleExamples(rows, from, to) {
  validateRange(from, to);
  for (const row of rows) {
    if (!row || !validDate(row.gameDate)) throw new Error("Invalid labeled example gameDate");
  }
  const selected = rows.filter((row) => inRange(row, from, to));
  const keys = new Set();
  for (const row of selected) {
    if (!validateExample(row)) throw new Error(`Invalid schema-2 labeled example: ${row.gameKey || "unknown"}`);
    if (keys.has(row.gameKey)) throw new Error(`Duplicate labeled game: ${row.gameKey}`);
    keys.add(row.gameKey);
  }
  return selected.sort((a, b) => a.gameDate.localeCompare(b.gameDate) || a.gameKey.localeCompare(b.gameKey));
}

function rowRange(rows) {
  const dates = rows.map((row) => row.gameDate).sort();
  return { from: dates[0] || null, to: dates[dates.length - 1] || null };
}

function evaluateRows(model, rows) {
  let logLoss = 0;
  let brier = 0;
  let correct = 0;
  for (const row of rows) {
    const probability = calibratedProbability(model, row);
    logLoss -= row.labelHomeWin * Math.log(probability) + (1 - row.labelHomeWin) * Math.log(1 - probability);
    brier += (probability - row.labelHomeWin) ** 2;
    correct += Number((probability >= 0.5 ? 1 : 0) === row.labelHomeWin);
  }
  return { samples: rows.length, range: rowRange(rows), logLoss: rows.length ? logLoss / rows.length : null,
    brier: rows.length ? brier / rows.length : null, accuracy: rows.length ? correct / rows.length : null };
}

module.exports = { FEATURE_NAMES, linearScore, calibratedProbability, sigmoid, validDate, validateRange,
  inRange, validateExample, validateModel, readRows, eligibleExamples, rowRange, evaluateRows };
