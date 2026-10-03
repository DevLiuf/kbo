const { buildExamples } = require("../scripts/build-training-examples");
function inputs(date, homeHigh = true) {
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const side = (high, home) => ({ lineupOpsRatio: high ? 1.3 : 0.7, pitchingFipRatio: 1, bullpenWorkload: 0.2, parkRunFactor: 1, home });
  return { leagueRunsPerGame: 4, away: side(!homeHigh, 0), home: side(homeHigh, 1), dataAsOf: `${iso}T07:00:00.000Z` };
}
function snapshot(date, key, overrides = {}) {
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  return { league: "kbo", gameKey: key, gameId: key, gameDate: date, gameState: "1", featureSchemaVersion: 3,
    mode: "post_lineup", lineupConfirmed: true, trainingEligible: true, status: "unavailable", unavailableCode: "MODEL_NOT_TRAINED",
    gameStartsAt: `${iso}T09:00:00.000Z`, asOfTimestamp: `${iso}T08:00:00.000Z`, modelInputs: inputs(date),
    homeTeam: "HOME", awayTeam: "AWAY", ...overrides };
}
function result(date, key, homeScore = 5, awayScore = 3) {
  return { league: "kbo", gameKey: key, gameId: key, gameDate: date, homeTeam: "HOME", awayTeam: "AWAY", completed: true, homeScore, awayScore };
}
function archive() {
  const snapshots = [];
  const results = [];
  for (let day = 1; day <= 6; day += 1) {
    const date = `2026040${day}`;
    for (let i = 0; i < 8; i += 1) {
      const key = `${date}-${i}`;
      const draw = i >= 6;
      const homeHigh = i % 2 === 0;
      const modelInputs = inputs(date, homeHigh);
      if (draw) { modelInputs.home.lineupOpsRatio = 1; modelInputs.away.lineupOpsRatio = 1; }
      snapshots.push(snapshot(date, key, { modelInputs }));
      results.push(result(date, key, draw ? 4 : homeHigh ? 5 : 3, draw ? 4 : homeHigh ? 3 : 5));
    }
  }
  return { snapshots, results };
}
function examples() { const rows = archive(); return buildExamples(rows.snapshots, rows.results).examples; }
module.exports = { inputs, snapshot, result, archive, examples };
