const fs = require("fs/promises");
const path = require("path");
const { spawnSync } = require("child_process");
const { createHash } = require("crypto");
const { assertSupportedRuntime } = require("../lib/runtime");

async function main() {
  assertSupportedRuntime();
  const root = path.resolve(__dirname, "..");
  const bundleRoot = path.join(root, "helper-pc-bundle");
  const target = path.join(bundleRoot, "kbo-helper-pc");
  const sourceFiles = ["package.json", "package-lock.json", "README.md", "quick-train-tune.bat"];
  for (const directory of ["scripts", "lib"]) {
    for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".js") && entry.name !== "build-helper-bundle.js") {
        sourceFiles.push(path.join(directory, entry.name));
      }
    }
  }
  const files = [];
  for (const relative of sourceFiles.sort()) {
    const bytes = await fs.readFile(path.join(root, relative));
    const output = path.join(target, relative);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, bytes);
    files.push({ path: relative.replaceAll(path.sep, "/"), sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  // Remove only obsolete generated executable files; never touch collected data.
  for (const directory of ["scripts", "lib"]) {
    for (const entry of await fs.readdir(path.join(target, directory), { withFileTypes: true })) {
      const relative = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith(".js") && !sourceFiles.includes(relative)) {
        await fs.unlink(path.join(target, relative));
      }
    }
  }
  await fs.writeFile(path.join(target, "bundle-manifest.json"), `${JSON.stringify({
    version: require("../package.json").version,
    files,
  }, null, 2)}\n`);
  const archive = path.join(bundleRoot, "kbo-helper-pc.zip");
  const temporary = path.join(bundleRoot, `.kbo-helper-${process.pid}.zip`);
  const members = [...sourceFiles.map((file) => path.join("kbo-helper-pc", file)), "kbo-helper-pc/bundle-manifest.json"];
  try {
    const result = spawnSync("zip", ["-q", temporary, ...members], { cwd: bundleRoot, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Failed to build helper archive; install zip and retry");
    await fs.rename(temporary, archive);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  console.log(JSON.stringify({ version: require("../package.json").version, files: files.length, archive, dataIncluded: false }));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
