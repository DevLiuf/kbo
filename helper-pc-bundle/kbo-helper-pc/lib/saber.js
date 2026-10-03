const DEFAULT_SABER_SETTINGS = Object.freeze({
  baseWeight: 0.7,
  markovWeight: 0.25,
  monteWeight: 0.05,
  clampThreshold: 2.5,
});

function validateSaberSettings(settings) {
  if (!settings || !Number.isFinite(settings.clampThreshold) || settings.clampThreshold <= 0) {
    return false;
  }
  const weights = [settings.baseWeight, settings.markovWeight, settings.monteWeight];
  return weights.every((weight) => Number.isFinite(weight) && weight >= 0 && weight <= 1)
    && Math.abs(weights[0] + weights[1] + weights[2] - 1) <= 1e-9;
}

function blendSaberRuns(baseline, markov, monte, settings) {
  if (!Number.isFinite(baseline) || !validateSaberSettings(settings)) {
    throw new Error("Invalid saber baseline or settings");
  }
  const trustedMarkov = Number.isFinite(markov) && Math.abs(markov - baseline) <= settings.clampThreshold
    ? markov : baseline;
  const trustedMonte = Number.isFinite(monte) && Math.abs(monte - baseline) <= settings.clampThreshold
    ? monte : baseline;
  return Math.max(1.2, Math.min(10.5,
    baseline * settings.baseWeight + trustedMarkov * settings.markovWeight + trustedMonte * settings.monteWeight));
}

module.exports = { DEFAULT_SABER_SETTINGS, validateSaberSettings, blendSaberRuns };
