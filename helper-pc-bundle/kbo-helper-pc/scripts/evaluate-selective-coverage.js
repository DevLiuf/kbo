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
  if (lines.length < 2) {
    return [];
  }

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

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function summarize(rows, threshold) {
  const selected = rows.filter((row) => row.maxWinProbability >= threshold);
  const selectedCount = selected.length;
  const total = rows.length;

  if (selectedCount === 0) {
    return {
      threshold,
      selectedGames: 0,
      coverage: 0,
      accuracy: null,
    };
  }

  const hits = selected.filter((row) => row.predictionHit).length;
  return {
    threshold,
    selectedGames: selectedCount,
    coverage: selectedCount / total,
    accuracy: hits / selectedCount,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = String(args.input || "").trim();
  const outPath = String(args.output || path.join(process.cwd(), "data", "backtests", "selective_accuracy_curve.json")).trim();
  const targetAccuracy = Number(args.targetAccuracy || 0.9);
  const minGames = Number(args.minGames || 20);

  if (!input) {
    throw new Error("Usage: node scripts/evaluate-selective-coverage.js --input=data/backtests/walk_forward_2025_lowfix_signfix.csv [--targetAccuracy=0.9] [--minGames=20]");
  }

  const rawRows = await readCsv(input);
  const rows = rawRows
    .map((row) => ({
      maxWinProbability: toNumber(row.maxWinProbability, 0.5),
      predictionHit: String(row.predictionHit).toLowerCase() === "true",
    }))
    .filter((row) => Number.isFinite(row.maxWinProbability));

  if (rows.length === 0) {
    throw new Error("no valid rows in csv");
  }

  const curve = [];
  for (let threshold = 0.5; threshold <= 0.95; threshold += 0.01) {
    curve.push(summarize(rows, Number(threshold.toFixed(2))));
  }

  const eligible = curve.filter((row) => row.selectedGames >= minGames && Number.isFinite(row.accuracy));
  const meetsTarget = eligible
    .filter((row) => row.accuracy >= targetAccuracy)
    .sort((a, b) => b.coverage - a.coverage);

  const bestAccuracy = [...eligible].sort((a, b) => {
    if (b.accuracy !== a.accuracy) {
      return b.accuracy - a.accuracy;
    }
    return b.coverage - a.coverage;
  })[0] || null;

  const payload = {
    createdAt: new Date().toISOString(),
    input,
    totalGames: rows.length,
    targetAccuracy,
    minGames,
    hasTargetMeetingThreshold: meetsTarget.length > 0,
    bestTargetMeeting: meetsTarget[0]
      ? {
          threshold: meetsTarget[0].threshold,
          selectedGames: meetsTarget[0].selectedGames,
          coverage: round(meetsTarget[0].coverage),
          accuracy: round(meetsTarget[0].accuracy),
        }
      : null,
    bestAccuracy: bestAccuracy
      ? {
          threshold: bestAccuracy.threshold,
          selectedGames: bestAccuracy.selectedGames,
          coverage: round(bestAccuracy.coverage),
          accuracy: round(bestAccuracy.accuracy),
        }
      : null,
    curve: curve.map((row) => ({
      threshold: row.threshold,
      selectedGames: row.selectedGames,
      coverage: round(row.coverage),
      accuracy: round(row.accuracy),
    })),
  };

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    outPath,
    totalGames: payload.totalGames,
    targetAccuracy: payload.targetAccuracy,
    bestTargetMeeting: payload.bestTargetMeeting,
    bestAccuracy: payload.bestAccuracy,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
