const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { collectHistoricalInputs } = require("../lib/kbo-historical-data");
const { acquireLock, atomicWrite, ndjson, promoteArtifacts, readNdjson } = require("../lib/artifacts");
const { mergeResults } = require("./fetch-results");
const { parseArgs } = require("./ml-utils");

function mergeHistorical(existing, fetched) {
  const byKey = new Map();
  for (const row of [...existing, ...fetched]) {
    const key = String(row.gameKey || row.gameId || "").trim();
    if (!key || row.gameId !== key || row.mode !== "historical_reconstruction" || row.dataOrigin !== "historical_reconstruction") throw new Error("Historical artifact contains a nonhistorical or unidentified row; live originals must remain separate");
    byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => a.gameDate.localeCompare(b.gameDate) || a.gameKey.localeCompare(b.gameKey));
}
async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const allowed = new Set(["from", "to", "output", "results", "cacheDir", "timeoutMs", "concurrency"]);
  for (const key of Object.keys(args)) if (!allowed.has(key) || args[key] === true) throw new Error(`Unsupported or valueless option --${key}; use --${key}=value`);
  const output = path.resolve(args.output || path.join("data", "historical_inputs.kbo.ndjson"));
  const results = path.resolve(args.results || path.join("data", "game_results.kbo.ndjson"));
  if (output === results) throw new Error("Historical input and result artifacts must have different paths");
  const releases = []; let temporary;
  try {
    // The official collection/audit completes before either destination is touched.
    for (const file of [output, results].sort()) releases.push(await acquireLock(`${file}.historical.lock`));
    const collected = await collectHistoricalInputs({ from: args.from, to: args.to, cacheDir: args.cacheDir, timeoutMs: args.timeoutMs === undefined ? 15000 : Number(args.timeoutMs), concurrency: args.concurrency === undefined ? 6 : Number(args.concurrency) });
    if (!collected.snapshots.length) throw new Error(`No eligible historical training rows; artifacts unchanged. ${JSON.stringify(collected.summary)}`);
    const mergedInputs = mergeHistorical(await readNdjson(output, { allowMissing: true }), collected.snapshots);
    const mergedResults = mergeResults(await readNdjson(results, { allowMissing: true }), collected.results);
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), "kbo-historical-"));
    const stagedInputs = path.join(temporary, "historical.ndjson"), stagedResults = path.join(temporary, "results.ndjson");
    await atomicWrite(stagedInputs, ndjson(mergedInputs));
    await atomicWrite(stagedResults, ndjson(mergedResults));
    await promoteArtifacts([{ source: stagedInputs, target: output }, { source: stagedResults, target: results }]);
    console.log(JSON.stringify({ ...collected.summary, historicalRows: mergedInputs.length, resultRows: mergedResults.length, output, results }, null, 2));
    return { ...collected, historicalRows: mergedInputs.length, resultRows: mergedResults.length };
  } finally {
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    for (const release of releases.reverse()) await release();
  }
}
if (require.main === module) main().catch((error) => { console.error(`${error.code || "HISTORICAL_BOOTSTRAP_FAILED"}: ${error.message}`); process.exitCode = 1; });
module.exports = { main, mergeHistorical };
