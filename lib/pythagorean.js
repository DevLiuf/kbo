const DEFAULT_EXPONENT = 1.83;

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function calculatePythagoreanWinPct(runsScored, runsAllowed, exponent = DEFAULT_EXPONENT) {
  if (runsScored < 0 || runsAllowed < 0) {
    throw new Error("Runs scored/allowed must be zero or greater.");
  }

  if (runsScored === 0 && runsAllowed === 0) {
    return 0;
  }

  const scoredPower = runsScored ** exponent;
  const allowedPower = runsAllowed ** exponent;
  const result = scoredPower / (scoredPower + allowedPower);
  return round(result, 3);
}

module.exports = {
  DEFAULT_EXPONENT,
  calculatePythagoreanWinPct,
};
