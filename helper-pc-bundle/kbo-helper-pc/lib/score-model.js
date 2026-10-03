const { FEATURE_SCHEMA_VERSION, MODEL_TYPE, validateInputs } = require("./prediction-contract");

const INPUT_NAMES = Object.freeze(["lineupOps", "pitchingFip", "bullpenWorkload", "park", "home"]);
const TAIL_TOLERANCE = 1e-12;

function sideVector(side) {
  return {
    lineupOps: Math.log(side.lineupOpsRatio),
    pitchingFip: Math.log(side.pitchingFipRatio),
    bullpenWorkload: side.bullpenWorkload,
    park: Math.log(side.parkRunFactor),
    home: side.home,
  };
}

function validateModel(model) {
  return Boolean(model && model.modelType === MODEL_TYPE && model.featureSchemaVersion === FEATURE_SCHEMA_VERSION
    && typeof model.version === "string" && model.version.trim() && Number.isFinite(model.intercept)
    && model.coefficients && INPUT_NAMES.every((name) => Number.isFinite(model.coefficients[name]))
    && INPUT_NAMES.filter((name) => name !== "home").every((name) => model.coefficients[name] >= 0)
    && Math.abs(model.coefficients.home) <= 0.3);
}

function expectedRuns(model, inputs, sideName) {
  if (!validateModel(model) || !validateInputs(inputs) || !["away", "home"].includes(sideName)) {
    throw new Error("Invalid confirmed-lineup count model or inputs");
  }
  const vector = sideVector(inputs[sideName]);
  let logMean = Math.log(inputs.leagueRunsPerGame) + model.intercept;
  for (const name of INPUT_NAMES) logMean += model.coefficients[name] * vector[name];
  const mean = Math.exp(logMean);
  if (!Number.isFinite(mean) || mean <= 0 || mean > 50) throw new Error("Expected runs outside supported range (0, 50]");
  return mean;
}

function poissonMass(mean) {
  const values = [Math.exp(-mean)];
  let sum = values[0];
  for (let count = 1; 1 - sum > TAIL_TOLERANCE; count += 1) {
    if (count > 256) throw new Error("Poisson distribution failed to converge");
    const next = values[count - 1] * mean / count;
    values.push(next);
    sum += next;
  }
  // The discarded tail is below 1e-12; normalize to keep probability sums exact.
  return values.map((value) => value / sum);
}

function runOutcome(awayMean, homeMean) {
  const away = poissonMass(awayMean);
  const home = poissonMass(homeMean);
  let homeWins = 0;
  let awayWins = 0;
  let ties = 0;
  let awayBelow = 0;
  let homeBelow = 0;
  for (let count = 0; count < Math.max(away.length, home.length); count += 1) {
    const awayAt = away[count] || 0;
    const homeAt = home[count] || 0;
    homeWins += homeAt * awayBelow;
    awayWins += awayAt * homeBelow;
    ties += awayAt * homeAt;
    awayBelow += awayAt;
    homeBelow += homeAt;
  }
  const decisiveMass = homeWins + awayWins;
  if (!(decisiveMass > 0)) throw new Error("No decisive outcome mass");
  return {
    homeWinProbability: homeWins / decisiveMass,
    awayWinProbability: awayWins / decisiveMass,
    tieAfterNineProbability: ties,
  };
}

function contributions(model, inputs, sideName) {
  const vector = sideVector(inputs[sideName]);
  const labels = {
    lineupOps: "확정 타선 OPS", pitchingFip: "상대 선발·불펜 FIP", bullpenWorkload: "상대 불펜 최근 투구량",
    park: "최근 구장 득점 환경", home: "홈 효과",
  };
  return INPUT_NAMES.map((key) => ({ key, label: labels[key], value: vector[key], weight: model.coefficients[key],
    contribution: vector[key] * model.coefficients[key] }));
}

function predictGame(model, inputs) {
  const expectedAwayRuns = expectedRuns(model, inputs, "away");
  const expectedHomeRuns = expectedRuns(model, inputs, "home");
  return {
    expectedAwayRuns, expectedHomeRuns,
    ...runOutcome(expectedAwayRuns, expectedHomeRuns),
    // Joint Poisson mode. Do not force a score to agree with a selected winner.
    predictedAwayScore: Math.floor(expectedAwayRuns),
    predictedHomeScore: Math.floor(expectedHomeRuns),
    predictedRunDiff: Math.abs(expectedHomeRuns - expectedAwayRuns),
    expectedRunDiff: expectedHomeRuns - expectedAwayRuns,
    featureContributions: { away: contributions(model, inputs, "away"), home: contributions(model, inputs, "home") },
  };
}

function logFactorial(count) {
  let result = 0;
  for (let value = 2; value <= count; value += 1) result += Math.log(value);
  return result;
}

function evaluateRows(model, rows) {
  let poissonNll = 0;
  let absoluteError = 0;
  let logLoss = 0;
  let brier = 0;
  let hits = 0;
  let decisiveGames = 0;
  let drawGames = 0;
  for (const row of rows) {
    if (![row.awayScore, row.homeScore].every((value) => Number.isInteger(value) && value >= 0)) {
      throw new Error("Count evaluation requires observed nonnegative integer scores");
    }
    const prediction = predictGame(model, row.modelInputs);
    for (const [count, mean] of [[row.awayScore, prediction.expectedAwayRuns], [row.homeScore, prediction.expectedHomeRuns]]) {
      poissonNll += mean - count * Math.log(mean) + logFactorial(count);
      absoluteError += Math.abs(mean - count);
    }
    if (row.homeScore === row.awayScore) { drawGames += 1; continue; }
    const label = Number(row.homeScore > row.awayScore);
    const probability = Math.max(1e-12, Math.min(1 - 1e-12, prediction.homeWinProbability));
    logLoss -= label * Math.log(probability) + (1 - label) * Math.log1p(-probability);
    brier += (probability - label) ** 2;
    hits += Number(Number(prediction.homeWinProbability >= 0.5) === label);
    decisiveGames += 1;
  }
  const dates = rows.map((row) => row.gameDate).sort();
  return {
    samples: rows.length, range: { from: dates[0] || null, to: dates[dates.length - 1] || null },
    poissonNll: rows.length ? poissonNll / (2 * rows.length) : null,
    mae: rows.length ? absoluteError / (2 * rows.length) : null,
    logLoss: decisiveGames ? logLoss / decisiveGames : null,
    brier: decisiveGames ? brier / decisiveGames : null,
    accuracy: decisiveGames ? hits / decisiveGames : null,
    decisiveGames, drawGames,
  };
}

module.exports = { MODEL_TYPE, INPUT_NAMES, validateInputs, validateModel, sideVector, expectedRuns,
  poissonMass, runOutcome, predictGame, evaluateRows };
