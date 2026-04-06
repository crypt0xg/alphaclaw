const fs = require("fs");
const path = require("path");

const { kRootDir } = require("./constants");

const getManagedOpenclawRuntimeDir = ({ rootDir = kRootDir } = {}) =>
  path.join(rootDir, ".openclaw-runtime");

const getManagedOpenclawBinDir = ({ runtimeDir } = {}) =>
  path.join(
    runtimeDir || getManagedOpenclawRuntimeDir(),
    "node_modules",
    ".bin",
  );

const getManagedOpenclawBinPath = ({ runtimeDir } = {}) =>
  path.join(getManagedOpenclawBinDir({ runtimeDir }), "openclaw");

const ensureManagedOpenclawRuntimeProject = ({
  fsModule = fs,
  runtimeDir,
} = {}) => {
  const resolvedRuntimeDir = runtimeDir || getManagedOpenclawRuntimeDir();
  const packageJsonPath = path.join(resolvedRuntimeDir, "package.json");
  fsModule.mkdirSync(resolvedRuntimeDir, { recursive: true });
  if (!fsModule.existsSync(packageJsonPath)) {
    fsModule.writeFileSync(
      packageJsonPath,
      JSON.stringify(
        {
          name: "alphaclaw-openclaw-runtime",
          private: true,
        },
        null,
        2,
      ),
    );
  }
  return {
    runtimeDir: resolvedRuntimeDir,
    packageJsonPath,
  };
};

const prependManagedOpenclawBinToPath = ({
  env = process.env,
  fsModule = fs,
  logger = console,
  runtimeDir,
} = {}) => {
  const resolvedRuntimeDir = runtimeDir || getManagedOpenclawRuntimeDir();
  const binDir = getManagedOpenclawBinDir({ runtimeDir: resolvedRuntimeDir });
  const binPath = getManagedOpenclawBinPath({ runtimeDir: resolvedRuntimeDir });
  if (!fsModule.existsSync(binPath)) {
    return false;
  }
  const currentEntries = String(env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  const nextEntries = [binDir, ...currentEntries.filter((entry) => entry !== binDir)];
  env.PATH = nextEntries.join(path.delimiter);
  logger.log(`[alphaclaw] Using managed OpenClaw runtime from ${resolvedRuntimeDir}`);
  return true;
};

module.exports = {
  ensureManagedOpenclawRuntimeProject,
  getManagedOpenclawBinDir,
  getManagedOpenclawBinPath,
  getManagedOpenclawRuntimeDir,
  prependManagedOpenclawBinToPath,
};
