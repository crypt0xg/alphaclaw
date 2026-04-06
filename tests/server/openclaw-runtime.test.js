const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ensureManagedOpenclawRuntimeProject,
  getManagedOpenclawBinDir,
  getManagedOpenclawBinPath,
  getManagedOpenclawRuntimeDir,
  prependManagedOpenclawBinToPath,
} = require("../../lib/server/openclaw-runtime");

describe("server/openclaw-runtime", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("builds the managed runtime directory under the AlphaClaw root", () => {
    expect(getManagedOpenclawRuntimeDir({ rootDir: tmpDir })).toBe(
      path.join(tmpDir, ".openclaw-runtime"),
    );
  });

  it("seeds a minimal runtime package.json when needed", () => {
    const runtimeDir = getManagedOpenclawRuntimeDir({ rootDir: tmpDir });

    const result = ensureManagedOpenclawRuntimeProject({
      fsModule: fs,
      runtimeDir,
    });

    expect(result.runtimeDir).toBe(runtimeDir);
    expect(
      JSON.parse(fs.readFileSync(path.join(runtimeDir, "package.json"), "utf8")),
    ).toEqual({
      name: "alphaclaw-openclaw-runtime",
      private: true,
    });
  });

  it("prepends the managed openclaw bin dir to PATH when a runtime exists", () => {
    const runtimeDir = getManagedOpenclawRuntimeDir({ rootDir: tmpDir });
    const binDir = getManagedOpenclawBinDir({ runtimeDir });
    const binPath = getManagedOpenclawBinPath({ runtimeDir });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(binPath, "#!/bin/sh\n");
    const env = { PATH: "/usr/local/bin:/usr/bin" };

    const applied = prependManagedOpenclawBinToPath({
      env,
      fsModule: fs,
      logger: { log: vi.fn() },
      runtimeDir,
    });

    expect(applied).toBe(true);
    expect(env.PATH.split(path.delimiter)[0]).toBe(binDir);
  });

  it("does not change PATH when the managed runtime is absent", () => {
    const runtimeDir = getManagedOpenclawRuntimeDir({ rootDir: tmpDir });
    const env = { PATH: "/usr/local/bin:/usr/bin" };

    const applied = prependManagedOpenclawBinToPath({
      env,
      fsModule: fs,
      logger: { log: vi.fn() },
      runtimeDir,
    });

    expect(applied).toBe(false);
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin");
  });
});
