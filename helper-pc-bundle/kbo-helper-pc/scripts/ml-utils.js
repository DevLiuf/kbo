const fs = require("fs/promises");

async function readNdjson(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) {
      continue;
    }
    const [key, value] = raw.slice(2).split("=");
    args[key] = value === undefined ? true : value;
  }
  return args;
}

function yyyymmddToDate(dateText) {
  const year = Number(dateText.slice(0, 4));
  const month = Number(dateText.slice(4, 6)) - 1;
  const day = Number(dateText.slice(6, 8));
  return new Date(year, month, day);
}

function dateToYyyymmdd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function iterDates(from, to) {
  const list = [];
  const current = yyyymmddToDate(from);
  const end = yyyymmddToDate(to);
  while (current <= end) {
    list.push(dateToYyyymmdd(current));
    current.setDate(current.getDate() + 1);
  }
  return list;
}

module.exports = {
  clamp,
  iterDates,
  parseArgs,
  readNdjson,
  sigmoid,
};
