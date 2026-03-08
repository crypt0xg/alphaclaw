const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const loadUsageDb = () => {
  const modulePath = require.resolve("../../lib/server/db/usage");
  delete require.cache[modulePath];
  return require(modulePath);
};

describe("server/usage-db", () => {
  it("sums per-model costs for session detail totals", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-db-cost-"));
    const { initUsageDb, getSessionDetail } = loadUsageDb();
    const { path: dbPath } = initUsageDb({ rootDir });
    const database = new DatabaseSync(dbPath);

    const insertUsageEvent = database.prepare(`
      INSERT INTO usage_events (
        timestamp,
        session_id,
        session_key,
        run_id,
        provider,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens
      ) VALUES (
        $timestamp,
        $session_id,
        $session_key,
        $run_id,
        $provider,
        $model,
        $input_tokens,
        $output_tokens,
        $cache_read_tokens,
        $cache_write_tokens,
        $total_tokens
      )
    `);

    insertUsageEvent.run({
      $timestamp: Date.now() - 1000,
      $session_id: "raw-session-1",
      $session_key: "session-1",
      $run_id: "run-1",
      $provider: "openai",
      $model: "gpt-4o",
      $input_tokens: 1_000_000,
      $output_tokens: 0,
      $cache_read_tokens: 0,
      $cache_write_tokens: 0,
      $total_tokens: 1_000_000,
    });
    insertUsageEvent.run({
      $timestamp: Date.now(),
      $session_id: "raw-session-1",
      $session_key: "session-1",
      $run_id: "run-2",
      $provider: "anthropic",
      $model: "claude-opus-4-6",
      $input_tokens: 0,
      $output_tokens: 1_000_000,
      $cache_read_tokens: 0,
      $cache_write_tokens: 0,
      $total_tokens: 1_000_000,
    });

    const detail = getSessionDetail({ sessionId: "session-1" });
    const expectedCost = 2.5 + 37.5;
    const summedBreakdownCost = detail.modelBreakdown.reduce(
      (sum, row) => sum + Number(row.totalCost || 0),
      0,
    );

    expect(detail).toBeTruthy();
    expect(detail.totalCost).toBeCloseTo(expectedCost, 8);
    expect(detail.totalCost).toBeCloseTo(summedBreakdownCost, 8);

    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("returns cost distribution by agent and source", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-db-agent-breakdown-"));
    const { initUsageDb, getDailySummary } = loadUsageDb();
    const { path: dbPath } = initUsageDb({ rootDir });
    const database = new DatabaseSync(dbPath);
    const now = Date.now();

    const insertUsageEvent = database.prepare(`
      INSERT INTO usage_events (
        timestamp,
        session_id,
        session_key,
        run_id,
        provider,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens
      ) VALUES (
        $timestamp,
        $session_id,
        $session_key,
        $run_id,
        $provider,
        $model,
        $input_tokens,
        $output_tokens,
        $cache_read_tokens,
        $cache_write_tokens,
        $total_tokens
      )
    `);

    insertUsageEvent.run({
      $timestamp: now - 2_000,
      $session_id: "raw-a",
      $session_key: "agent:main:telegram:direct:123",
      $run_id: "run-a",
      $provider: "openai",
      $model: "gpt-4o",
      $input_tokens: 1_000_000,
      $output_tokens: 0,
      $cache_read_tokens: 0,
      $cache_write_tokens: 0,
      $total_tokens: 1_000_000,
    });
    insertUsageEvent.run({
      $timestamp: now - 1_000,
      $session_id: "raw-b",
      $session_key: "agent:main:hook:gmail:abc123",
      $run_id: "run-b",
      $provider: "openai",
      $model: "gpt-4o",
      $input_tokens: 0,
      $output_tokens: 1_000_000,
      $cache_read_tokens: 0,
      $cache_write_tokens: 0,
      $total_tokens: 1_000_000,
    });
    insertUsageEvent.run({
      $timestamp: now - 500,
      $session_id: "raw-c",
      $session_key: "agent:ops:cron:nightly",
      $run_id: "run-c",
      $provider: "openai",
      $model: "gpt-4o",
      $input_tokens: 0,
      $output_tokens: 1_000_000,
      $cache_read_tokens: 0,
      $cache_write_tokens: 0,
      $total_tokens: 1_000_000,
    });

    const summary = getDailySummary({ days: 7, timeZone: "UTC" });

    expect(summary?.costByAgent).toBeTruthy();
    expect(Array.isArray(summary.costByAgent.agents)).toBe(true);

    const mainAgent = summary.costByAgent.agents.find((row) => row.agent === "main");
    const opsAgent = summary.costByAgent.agents.find((row) => row.agent === "ops");

    expect(mainAgent).toBeTruthy();
    expect(opsAgent).toBeTruthy();
    expect(mainAgent.totalCost).toBeCloseTo(12.5, 8);
    expect(opsAgent.totalCost).toBeCloseTo(10, 8);

    const mainChat = mainAgent.sourceBreakdown.find((row) => row.source === "chat");
    const mainHooks = mainAgent.sourceBreakdown.find((row) => row.source === "hooks");
    const mainCron = mainAgent.sourceBreakdown.find((row) => row.source === "cron");

    expect(mainChat.totalCost).toBeCloseTo(2.5, 8);
    expect(mainHooks.totalCost).toBeCloseTo(10, 8);
    expect(mainCron.totalCost).toBeCloseTo(0, 8);

    const opsCron = opsAgent.sourceBreakdown.find((row) => row.source === "cron");
    expect(opsCron.totalCost).toBeCloseTo(10, 8);

    expect(summary.costByAgent.totals.totalCost).toBeCloseTo(22.5, 8);

    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("applies tiered pricing per event, not aggregated totals", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-db-tiered-event-"));
    const { initUsageDb, getSessionDetail } = loadUsageDb();
    const { path: dbPath } = initUsageDb({ rootDir });
    const database = new DatabaseSync(dbPath);
    const now = Date.now();

    const insertUsageEvent = database.prepare(`
      INSERT INTO usage_events (
        timestamp,
        session_id,
        session_key,
        run_id,
        provider,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens
      ) VALUES (
        $timestamp,
        $session_id,
        $session_key,
        $run_id,
        $provider,
        $model,
        $input_tokens,
        $output_tokens,
        $cache_read_tokens,
        $cache_write_tokens,
        $total_tokens
      )
    `);

    // Each event stays below the 200k threshold, so both should use 25/M output rate.
    insertUsageEvent.run({
      $timestamp: now - 1000,
      $session_id: "raw-tier-1",
      $session_key: "session-tier-1",
      $run_id: "run-tier-1",
      $provider: "anthropic",
      $model: "claude-opus-4-6",
      $input_tokens: 0,
      $output_tokens: 150_000,
      $cache_read_tokens: 0,
      $cache_write_tokens: 0,
      $total_tokens: 150_000,
    });
    insertUsageEvent.run({
      $timestamp: now,
      $session_id: "raw-tier-1",
      $session_key: "session-tier-1",
      $run_id: "run-tier-2",
      $provider: "anthropic",
      $model: "claude-opus-4-6",
      $input_tokens: 0,
      $output_tokens: 150_000,
      $cache_read_tokens: 0,
      $cache_write_tokens: 0,
      $total_tokens: 150_000,
    });

    const detail = getSessionDetail({ sessionId: "session-tier-1" });

    expect(detail).toBeTruthy();
    expect(detail.totalCost).toBeCloseTo(7.5, 8);

    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("backfills usage events from session JSONL files", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-db-backfill-"));
    const openclawDir = path.join(rootDir, ".openclaw");
    const sessionsDir = path.join(openclawDir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify(
        {
          "agent:main:telegram:direct:123": {
            sessionId: "sess-1",
            sessionFile: "sess-1.jsonl",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(sessionsDir, "sess-1.jsonl"),
      [
        JSON.stringify({
          timestamp: new Date("2026-03-01T01:00:00.000Z").toISOString(),
          message: { role: "user", content: "hello" },
        }),
        JSON.stringify({
          timestamp: new Date("2026-03-01T01:00:02.000Z").toISOString(),
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_read_input_tokens: 20,
              cache_creation_input_tokens: 3,
            },
          },
        }),
      ].join("\n"),
    );

    const { initUsageDb, backfillFromTranscripts } = loadUsageDb();
    const { path: dbPath } = initUsageDb({ rootDir });
    const database = new DatabaseSync(dbPath);

    const result = await backfillFromTranscripts({ openclawDir });

    const rows = database
      .prepare(`
        SELECT
          session_id,
          session_key,
          provider,
          model,
          input_tokens,
          output_tokens,
          cache_read_tokens,
          cache_write_tokens,
          total_tokens
        FROM usage_events
        ORDER BY timestamp ASC
      `)
      .all();

    expect(result.backfilledEvents).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe("sess-1");
    expect(rows[0].session_key).toBe("agent:main:telegram:direct:123");
    expect(rows[0].provider).toBe("anthropic");
    expect(rows[0].model).toBe("claude-sonnet-4-6");
    expect(rows[0].input_tokens).toBe(10);
    expect(rows[0].output_tokens).toBe(5);
    expect(rows[0].cache_read_tokens).toBe(20);
    expect(rows[0].cache_write_tokens).toBe(3);
    expect(rows[0].total_tokens).toBe(38);

    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("skips JSONL rows newer than the existing DB cutoff", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-db-backfill-cutoff-"));
    const openclawDir = path.join(rootDir, ".openclaw");
    const sessionsDir = path.join(openclawDir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify(
        {
          "agent:main:hook:nightly:abc": {
            sessionId: "sess-cutoff",
            sessionFile: "sess-cutoff.jsonl",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
    );

    const olderIso = new Date("2026-03-01T01:00:00.000Z").toISOString();
    const newerIso = new Date("2026-03-02T01:00:00.000Z").toISOString();
    const cutoffMs = new Date("2026-03-01T12:00:00.000Z").getTime();
    fs.writeFileSync(
      path.join(sessionsDir, "sess-cutoff.jsonl"),
      [
        JSON.stringify({
          timestamp: olderIso,
          message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-4o",
            usage: { prompt_tokens: 40, completion_tokens: 2 },
          },
        }),
        JSON.stringify({
          timestamp: newerIso,
          message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-4o",
            usage: { prompt_tokens: 10, completion_tokens: 1 },
          },
        }),
      ].join("\n"),
    );
    fs.utimesSync(
      path.join(sessionsDir, "sess-cutoff.jsonl"),
      new Date("2026-03-01T00:00:00.000Z"),
      new Date("2026-03-01T00:00:00.000Z"),
    );

    const { initUsageDb, backfillFromTranscripts } = loadUsageDb();
    const { path: dbPath } = initUsageDb({ rootDir });
    const database = new DatabaseSync(dbPath);
    database
      .prepare(`
        INSERT INTO usage_events (
          timestamp,
          session_id,
          session_key,
          run_id,
          provider,
          model,
          input_tokens,
          output_tokens,
          cache_read_tokens,
          cache_write_tokens,
          total_tokens
        ) VALUES (
          $timestamp,
          $session_id,
          $session_key,
          $run_id,
          $provider,
          $model,
          $input_tokens,
          $output_tokens,
          $cache_read_tokens,
          $cache_write_tokens,
          $total_tokens
        )
      `)
      .run({
        $timestamp: cutoffMs,
        $session_id: "existing",
        $session_key: "agent:main:existing",
        $run_id: "run-existing",
        $provider: "openai",
        $model: "gpt-4o",
        $input_tokens: 1,
        $output_tokens: 1,
        $cache_read_tokens: 0,
        $cache_write_tokens: 0,
        $total_tokens: 2,
      });

    const result = await backfillFromTranscripts({ openclawDir });

    const rows = database
      .prepare(
        "SELECT session_id, total_tokens FROM usage_events WHERE session_id = 'sess-cutoff' ORDER BY timestamp ASC",
      )
      .all();

    expect(result.backfilledEvents).toBe(1);
    expect(result.filesScanned).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].total_tokens).toBe(42);

    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});
