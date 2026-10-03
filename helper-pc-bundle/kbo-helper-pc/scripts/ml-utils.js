function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) {
      continue;
    }
    const separator = raw.indexOf("=");
    const key = separator < 0 ? raw.slice(2) : raw.slice(2, separator);
    args[key] = separator < 0 ? true : raw.slice(separator + 1);
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
  iterDates,
  parseArgs,
};
