const fs = require("fs/promises");
const path = require("path");
const { randomUUID, createHash } = require("crypto");

async function atomicWrite(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, { flag: "wx" });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function writeJson(filePath, value) {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readNdjson(filePath, { allowMissing = false } = {}) {
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return [];
    throw error;
  }
  return content.split("\n").filter((line) => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid NDJSON in ${filePath}, row ${index + 1}: ${error.message}`);
    }
  });
}

function ndjson(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
}

async function copyIfPresent(source, target) {
  let content;
  try {
    content = await fs.readFile(source);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  await atomicWrite(target, content);
  return true;
}

async function promoteArtifacts(entries) {
  const targets = new Set();
  const prepared = [];
  for (const { source, target } of entries) {
    const resolved = path.resolve(target);
    if (targets.has(resolved)) throw new Error(`Duplicate artifact target: ${target}`);
    targets.add(resolved);
    const next = await fs.readFile(source);
    let previous = null;
    try {
      previous = await fs.readFile(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    prepared.push({ target, next, previous });
  }
  const promoted = [];
  try {
    for (const artifact of prepared) {
      await atomicWrite(artifact.target, artifact.next);
      promoted.push(artifact);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const artifact of promoted.reverse()) {
      try {
        if (artifact.previous === null) await fs.rm(artifact.target, { force: true });
        else await atomicWrite(artifact.target, artifact.previous);
      } catch (rollbackError) {
        rollbackErrors.push(`${artifact.target}: ${rollbackError.message}`);
      }
    }
    if (rollbackErrors.length) {
      throw new Error(`${error.message}; artifact rollback failed: ${rollbackErrors.join("; ")}`);
    }
    throw error;
  }
}

async function acquireLock(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let handle;
  try {
    handle = await fs.open(filePath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Helper already running or stale lock requires inspection: ${filePath}`);
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
  } catch (error) {
    await handle.close();
    await fs.rm(filePath, { force: true });
    throw error;
  }
  return async () => {
    await handle.close();
    await fs.unlink(filePath);
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function seoulToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type).value).join("");
}

function assertDateRange(from, to) {
  for (const text of [from, to]) {
    if (!/^\d{8}$/.test(text)) throw new Error(`Invalid date: ${text}; expected YYYYMMDD`);
    const iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
    const date = new Date(`${iso}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso) {
      throw new Error(`Invalid calendar date: ${text}`);
    }
  }
  if (from > to) throw new Error(`Invalid date range: ${from} > ${to}`);
}

function shiftDate(text, days) {
  const date = new Date(`${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

module.exports = {
  acquireLock, assertDateRange, atomicWrite, copyIfPresent, ndjson,
  promoteArtifacts, readNdjson, seoulToday, sha256, shiftDate, writeJson,
};
