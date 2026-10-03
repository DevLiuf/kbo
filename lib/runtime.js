function assertSupportedRuntime(version = process.versions.node) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (major < 20 || (major === 20 && (minor < 18 || (minor === 18 && patch < 1)))) {
    throw new Error(`Node.js >=20.18.1 is required; found ${version}. Install a supported Node.js LTS release.`);
  }
}

module.exports = { assertSupportedRuntime };
