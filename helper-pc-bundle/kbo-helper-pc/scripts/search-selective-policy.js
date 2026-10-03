const fs = require("fs/promises");
const path = require("path");
const { parseArgs } = require("./ml-utils");
function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells;
}
async function readCsv(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = cols[idx] ?? "";
    });
    return row;
  });
}
function toNum(v, fallback = null) {
  if (v === undefined || v === null || typeof v === "boolean" || String(v).trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function round(v, d = 6) {
  if (!Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}
function shouldIncludeByTier(row, tierMode) {
  const tier = String(row.edgeTier || "");
  if (!tierMode) return true;
  if (tierMode === "elite_only") return tier === "elite_edge";
  if (tierMode === "strong_only") return tier === "strong_edge";
  if (tierMode === "strong_or_elite") return tier === "strong_edge" || tier === "elite_edge";
  return true;
}
function pickDayTop1(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = String(row.evalDate || "");
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const selected = [];
  for (const dayRows of grouped.values()) {
    dayRows.sort((a, b) => {
      if (b.maxWinProbability !== a.maxWinProbability) {
        return b.maxWinProbability - a.maxWinProbability;
      }
      if (b.winProbGap !== a.winProbGap) {
        return b.winProbGap - a.winProbGap;
      }
      return b.absPredictedRunDiff - a.absPredictedRunDiff;
    });
    selected.push(dayRows[0]);
  }
  return selected;
}
function evaluate(rows, policy) {
  const filtered = rows.filter((row) => {
    if (typeof row.predictionHit !== "boolean") return false;
    if (![row.maxWinProbability, row.winProbGap, row.absPredictedRunDiff].every(Number.isFinite)) return false;
    if (policy.evalFrom && row.evalDate < policy.evalFrom) return false;
    if (policy.evalTo && row.evalDate > policy.evalTo) return false;
    if (row.maxWinProbability < policy.minProb) return false;
    if (row.winProbGap < policy.minGap) return false;
    if (row.absPredictedRunDiff < policy.minRunDiff) return false;
    if (policy.excludeAvoid && row.bettingTag === "회피") return false;
    if (policy.requireMlCentered && row.decisionBasis !== "ml_centered") return false;
    if (!shouldIncludeByTier(row, policy.tierMode)) return false;
    return true;
  });
  const selected = policy.dayTop1 ? pickDayTop1(filtered) : filtered;
  if (selected.length === 0) {
    return {
      ...policy,
      selectedGames: 0,
      selectedDays: 0,
      coverage: 0,
      accuracy: null,
    };
  }
  const daySet = new Set(selected.map((row) => String(row.evalDate || "")));
  const hits = selected.filter((row) => row.predictionHit).length;
  return {
    ...policy,
    selectedGames: selected.length,
    selectedDays: daySet.size,
    coverage: selected.length / rows.length,
    accuracy: hits / selected.length,
  };
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = String(args.input || "").trim();
  const output = String(args.output || path.join(process.cwd(), "data", "backtests", "selective_policy_search.json"));
  const minGames = Number(args.minGames || 20);
  const targetAccuracy = Number(args.targetAccuracy || 0.9);
  const dayTop1 = parseBool(args.dayTop1, false);
  const evalFrom = String(args.evalFrom || "").trim();
  const evalTo = String(args.evalTo || "").trim();
  if (!input) {
    throw new Error("Usage: node scripts/search-selective-policy.js --input=<walkforward.csv>");
  }
  const rawRows = await readCsv(input);
  const rows = rawRows.map((row) => {
    const homeProb = toNum(row.homeWinProbability);
    const awayProb = toNum(row.awayWinProbability);
    const validProbs = homeProb !== null && awayProb !== null;
    const maxWinProbability = toNum(row.maxWinProbability, validProbs ? Math.max(homeProb, awayProb) : null);
    const winProbGap = toNum(row.winProbGap, validProbs ? Math.abs(homeProb - awayProb) : null);
    const predictedRunDiff = toNum(row.predictedRunDiff);
    const hit = String(row.predictionHit ?? row.winnerHit ?? "").trim().toLowerCase();
    const awayScore = toNum(row.actualAwayScore);
    const homeScore = toNum(row.actualHomeScore);
    const missingScores = (Object.hasOwn(row, "actualAwayScore") || Object.hasOwn(row, "actualHomeScore"))
      && (awayScore === null || homeScore === null);
    const voidOutcome = parseBool(row.isDraw) || parseBool(row.void) || String(row.outcome || "").toLowerCase() === "void"
      || (awayScore !== null && homeScore !== null && awayScore === homeScore);
    return {
      evalDate: String(row.evalDate || row.gameDate || ""),
      maxWinProbability,
      winProbGap,
      absPredictedRunDiff: predictedRunDiff === null ? null : Math.abs(predictedRunDiff),
      bettingTag: String(row.bettingTag || ""),
      edgeBand: String(row.edgeBand || ""),
      edgeTier: String(row.edgeTier || ""),
      decisionBasis: String(row.decisionBasis || ""),
      predictionHit: voidOutcome || missingScores ? null : hit === "true" ? true : hit === "false" ? false : null,
    };
  }).filter((row) => typeof row.predictionHit === "boolean" && /^\d{8}$/.test(row.evalDate)
    && [row.maxWinProbability, row.winProbGap, row.absPredictedRunDiff].every(Number.isFinite));
  const minProbValues = Array.from({ length: 36 }, (_, i) => Number((0.6 + i * 0.01).toFixed(2)));
  const minGapValues = [0.05, 0.08, 0.1, 0.12, 0.15, 0.18, 0.2, 0.22, 0.24, 0.28, 0.3, 0.35, 0.4];
  const minRunDiffValues = [0, 1, 2, 3, 4, 5];
  const tierModes = ["", "elite_only", "strong_only", "strong_or_elite"];
  const all = [];
  for (const minProb of minProbValues) {
    for (const minGap of minGapValues) {
      for (const minRunDiff of minRunDiffValues) {
        for (const excludeAvoid of [false, true]) {
          for (const requireMlCentered of [false, true]) {
            for (const tierMode of tierModes) {
              all.push(evaluate(rows, {
                minProb,
                minGap,
                minRunDiff,
                excludeAvoid,
                requireMlCentered,
                tierMode,
                dayTop1,
                evalFrom,
                evalTo,
              }));
            }
          }
        }
      }
    }
  }
  const eligible = all.filter((r) => r.selectedGames >= minGames && Number.isFinite(r.accuracy));
  const bestByAccuracy = [...eligible].sort((a, b) => {
    if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
    return b.coverage - a.coverage;
  })[0] || null;
  const targetMeet = [...eligible]
    .filter((r) => r.accuracy >= targetAccuracy)
    .sort((a, b) => b.coverage - a.coverage);
  const payload = {
    createdAt: new Date().toISOString(),
    input,
    totalGames: rows.length,
    minGames,
    targetAccuracy,
    dayTop1,
    evalFrom: evalFrom || null,
    evalTo: evalTo || null,
    bestByAccuracy: bestByAccuracy
      ? { ...bestByAccuracy, coverage: round(bestByAccuracy.coverage), accuracy: round(bestByAccuracy.accuracy) }
      : null,
    hasTargetMeetingPolicy: targetMeet.length > 0,
    bestTargetMeeting: targetMeet[0]
      ? { ...targetMeet[0], coverage: round(targetMeet[0].coverage), accuracy: round(targetMeet[0].accuracy) }
      : null,
    top10: eligible
      .sort((a, b) => {
        if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
        return b.coverage - a.coverage;
      })
      .slice(0, 10)
      .map((r) => ({ ...r, coverage: round(r.coverage), accuracy: round(r.accuracy) })),
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    output,
    totalGames: payload.totalGames,
    minGames,
    targetAccuracy,
    dayTop1,
    bestByAccuracy: payload.bestByAccuracy,
    bestTargetMeeting: payload.bestTargetMeeting,
  }, null, 2));
}
main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
