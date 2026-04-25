const path = require("path");
const { kRootDir } = require("../../lib/server/constants");
const {
  ensureOpenclawStartupEnv,
  withOpenclawStartupEnv,
} = require("../../lib/server/openclaw-runtime-env");

describe("server/openclaw-runtime-env", () => {
  it("defaults OpenClaw CLI startup settings to the stable AlphaClaw root", () => {
    const env = withOpenclawStartupEnv({ FOO: "bar" });

    expect(env).toEqual(
      expect.objectContaining({
        FOO: "bar",
        NODE_COMPILE_CACHE: path.join(
          kRootDir,
          "cache",
          "openclaw-compile-cache",
        ),
        OPENCLAW_NO_RESPAWN: "1",
      }),
    );
  });

  it("preserves explicit OpenClaw startup settings", () => {
    const env = withOpenclawStartupEnv({
      NODE_COMPILE_CACHE: "/custom/cache",
      OPENCLAW_NO_RESPAWN: "0",
    });

    expect(env.NODE_COMPILE_CACHE).toBe("/custom/cache");
    expect(env.OPENCLAW_NO_RESPAWN).toBe("0");
  });

  it("creates the compile cache directory and backfills missing process env values", () => {
    const fsModule = { mkdirSync: vi.fn() };
    const logger = { warn: vi.fn() };
    const env = {};

    const result = ensureOpenclawStartupEnv({ fsModule, env, logger });

    expect(fsModule.mkdirSync).toHaveBeenCalledWith(result.NODE_COMPILE_CACHE, {
      recursive: true,
    });
    expect(env.NODE_COMPILE_CACHE).toBe(result.NODE_COMPILE_CACHE);
    expect(env.OPENCLAW_NO_RESPAWN).toBe("1");
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
