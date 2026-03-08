const fs = require("fs");
const path = require("path");
const readline = require("readline");

const kSessionsStoreFileName = "sessions.json";
const kSessionFileSuffix = ".jsonl";

const toFiniteNumber = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const toNonNegativeInt = (value) => {
  const parsed = toFiniteNumber(value);
  if (parsed === undefined) return undefined;
  if (parsed <= 0) return 0;
  return Math.floor(parsed);
};

const normalizeUsage = (rawUsage) => {
  if (!rawUsage || typeof rawUsage !== "object") return null;
  const inputTokens = toNonNegativeInt(
    rawUsage.input ??
      rawUsage.inputTokens ??
      rawUsage.input_tokens ??
      rawUsage.promptTokens ??
      rawUsage.prompt_tokens,
  );
  const outputTokens = toNonNegativeInt(
    rawUsage.output ??
      rawUsage.outputTokens ??
      rawUsage.output_tokens ??
      rawUsage.completionTokens ??
      rawUsage.completion_tokens,
  );
  const cacheReadTokens = toNonNegativeInt(
    rawUsage.cacheRead ??
      rawUsage.cache_read ??
      rawUsage.cache_read_input_tokens ??
      rawUsage.cached_tokens ??
      rawUsage.prompt_tokens_details?.cached_tokens,
  );
  const cacheWriteTokens = toNonNegativeInt(
    rawUsage.cacheWrite ??
      rawUsage.cache_write ??
      rawUsage.cache_creation_input_tokens,
  );
  const totalTokens = toNonNegativeInt(
    rawUsage.total ?? rawUsage.totalTokens ?? rawUsage.total_tokens,
  );
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    totalTokens === undefined
  ) {
    return null;
  }

  const normalized = {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
    totalTokens:
      totalTokens ??
      (inputTokens ?? 0) +
        (outputTokens ?? 0) +
        (cacheReadTokens ?? 0) +
        (cacheWriteTokens ?? 0),
  };
  if (normalized.totalTokens <= 0) return null;
  return normalized;
};

const parseTimestampMs = (entry) => {
  const rawTimestamp = toFiniteNumber(entry?.timestamp);
  if (rawTimestamp !== undefined && rawTimestamp > 0) {
    return Math.floor(rawTimestamp);
  }

  const rawTimestampIso = String(entry?.timestamp || "").trim();
  if (rawTimestampIso) {
    const parsedDate = new Date(rawTimestampIso);
    const parsedMs = parsedDate.valueOf();
    if (Number.isFinite(parsedMs) && parsedMs > 0) return parsedMs;
  }

  const messageTimestamp = toFiniteNumber(entry?.message?.timestamp);
  if (messageTimestamp !== undefined && messageTimestamp > 0) {
    return Math.floor(messageTimestamp);
  }
  return null;
};

const toDayKey = (timestampMs) =>
  new Date(Number(timestampMs || 0)).toISOString().slice(0, 10);

const resolveSessionsDir = (openclawDir) =>
  path.join(String(openclawDir || ""), "agents", "main", "sessions");

const listBackfillCandidateFiles = ({
  openclawDir,
  earliestExistingTimestampMs = null,
  fsModule = fs,
}) => {
  const sessionsDir = resolveSessionsDir(openclawDir);
  if (!sessionsDir || !fsModule.existsSync(sessionsDir)) return [];
  const entries = fsModule.readdirSync(sessionsDir, { withFileTypes: true });
  const candidateFiles = [];
  for (const entry of entries) {
    if (!entry?.isFile?.()) continue;
    const fileName = String(entry.name || "");
    if (!fileName.endsWith(kSessionFileSuffix)) continue;
    if (!earliestExistingTimestampMs || earliestExistingTimestampMs <= 0) {
      candidateFiles.push(fileName);
      continue;
    }
    const absolutePath = path.join(sessionsDir, fileName);
    try {
      const stats = fsModule.statSync(absolutePath);
      if (Number(stats?.mtimeMs || 0) < earliestExistingTimestampMs) {
        candidateFiles.push(fileName);
      }
    } catch {}
  }
  return candidateFiles.sort((leftValue, rightValue) =>
    leftValue.localeCompare(rightValue),
  );
};

const getEarliestUsageTimestampMs = (database) => {
  const row = database
    .prepare("SELECT MIN(timestamp) AS earliest_timestamp FROM usage_events")
    .get();
  const parsed = toNonNegativeInt(row?.earliest_timestamp);
  return parsed && parsed > 0 ? parsed : null;
};

const readSessionsStore = ({ sessionsDir, fsModule = fs }) => {
  const sessionsStorePath = path.join(sessionsDir, kSessionsStoreFileName);
  if (!fsModule.existsSync(sessionsStorePath)) return {};
  try {
    const raw = fsModule.readFileSync(sessionsStorePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const buildSessionContextByFileName = ({ sessionsDir, fsModule = fs }) => {
  const sessionStore = readSessionsStore({ sessionsDir, fsModule });
  const byFileName = new Map();
  for (const [sessionKey, entry] of Object.entries(sessionStore)) {
    const safeSessionKey = String(sessionKey || "").trim();
    if (!safeSessionKey) continue;
    const rawSessionId = String(entry?.sessionId || "").trim();
    const rawSessionFile = String(entry?.sessionFile || "").trim();
    const baseContext = {
      sessionKey: safeSessionKey,
      sessionId: rawSessionId,
    };
    if (rawSessionFile) {
      byFileName.set(path.basename(rawSessionFile), baseContext);
    }
    if (rawSessionId) {
      byFileName.set(`${rawSessionId}${kSessionFileSuffix}`, baseContext);
    }
  }
  return byFileName;
};

const resolveSessionContext = ({ fileName, sessionContextByFileName }) => {
  const mappedContext = sessionContextByFileName.get(fileName) || null;
  if (mappedContext) return mappedContext;
  return {
    sessionKey: "",
    sessionId: String(fileName || "").replace(/\.jsonl$/i, ""),
  };
};

const scanUsageRecordsFromFile = async ({
  filePath,
  onRecord = () => {},
  onSkip = () => {},
  earliestExistingTimestampMs = null,
}) => {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const rawLine of lines) {
      const trimmedLine = String(rawLine || "").trim();
      if (!trimmedLine) {
        onSkip();
        continue;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(trimmedLine);
      } catch {
        onSkip();
        continue;
      }
      const message = parsed?.message;
      if (!message || typeof message !== "object") {
        onSkip();
        continue;
      }
      if (String(message.role || "").trim() !== "assistant") {
        onSkip();
        continue;
      }
      const usage = normalizeUsage(message.usage ?? parsed?.usage);
      if (!usage) {
        onSkip();
        continue;
      }
      const timestampMs = parseTimestampMs(parsed);
      if (!timestampMs) {
        onSkip();
        continue;
      }
      if (
        earliestExistingTimestampMs &&
        timestampMs >= earliestExistingTimestampMs
      ) {
        onSkip();
        continue;
      }
      const provider =
        String(message.provider || parsed?.provider || "").trim() || "unknown";
      const model = String(message.model || parsed?.model || "").trim() || "unknown";
      const runId =
        String(
          parsed?.runId ||
            parsed?.run_id ||
            message?.runId ||
            message?.run_id ||
            "",
        ).trim() || "";
      onRecord({
        timestampMs,
        provider,
        model,
        runId,
        ...usage,
      });
    }
  } finally {
    lines.close();
    stream.destroy();
  }
};

const getBackfillStatus = ({ database, openclawDir, fsModule = fs }) => {
  if (!database) throw new Error("Usage DB is not initialized");
  const earliestExistingTimestampMs = getEarliestUsageTimestampMs(database);
  const files = listBackfillCandidateFiles({
    openclawDir,
    earliestExistingTimestampMs,
    fsModule,
  });
  return {
    available: files.length > 0,
    estimatedFiles: files.length,
    earliestExistingTimestampMs,
  };
};

const backfillFromTranscripts = async ({
  database,
  openclawDir,
  fsModule = fs,
}) => {
  if (!database) throw new Error("Usage DB is not initialized");
  const earliestExistingTimestampMs = getEarliestUsageTimestampMs(database);
  const sessionsDir = resolveSessionsDir(openclawDir);
  const files = listBackfillCandidateFiles({
    openclawDir,
    earliestExistingTimestampMs,
    fsModule,
  });
  const sessionContextByFileName = buildSessionContextByFileName({
    sessionsDir,
    fsModule,
  });

  const insertUsageEventStmt = database.prepare(`
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
  const upsertUsageDailyStmt = database.prepare(`
    INSERT INTO usage_daily (
      date,
      model,
      provider,
      input_tokens,
      output_tokens,
      cache_read_tokens,
      cache_write_tokens,
      total_tokens,
      turn_count
    ) VALUES (
      $date,
      $model,
      $provider,
      $input_tokens,
      $output_tokens,
      $cache_read_tokens,
      $cache_write_tokens,
      $total_tokens,
      1
    )
    ON CONFLICT(date, model) DO UPDATE SET
      provider = COALESCE(excluded.provider, usage_daily.provider),
      input_tokens = usage_daily.input_tokens + excluded.input_tokens,
      output_tokens = usage_daily.output_tokens + excluded.output_tokens,
      cache_read_tokens = usage_daily.cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = usage_daily.cache_write_tokens + excluded.cache_write_tokens,
      total_tokens = usage_daily.total_tokens + excluded.total_tokens,
      turn_count = usage_daily.turn_count + 1
  `);

  let backfilledEvents = 0;
  let skippedEvents = 0;
  let filesScanned = 0;
  database.exec("BEGIN");
  try {
    for (const fileName of files) {
      filesScanned += 1;
      const filePath = path.join(sessionsDir, fileName);
      const sessionContext = resolveSessionContext({
        fileName,
        sessionContextByFileName,
      });
      await scanUsageRecordsFromFile({
        filePath,
        earliestExistingTimestampMs,
        onSkip: () => {
          skippedEvents += 1;
        },
        onRecord: (record) => {
          insertUsageEventStmt.run({
            $timestamp: record.timestampMs,
            $session_id: String(sessionContext.sessionId || ""),
            $session_key: String(sessionContext.sessionKey || ""),
            $run_id: String(record.runId || ""),
            $provider: record.provider,
            $model: record.model,
            $input_tokens: record.inputTokens,
            $output_tokens: record.outputTokens,
            $cache_read_tokens: record.cacheReadTokens,
            $cache_write_tokens: record.cacheWriteTokens,
            $total_tokens: record.totalTokens,
          });
          upsertUsageDailyStmt.run({
            $date: toDayKey(record.timestampMs),
            $model: record.model,
            $provider: record.provider,
            $input_tokens: record.inputTokens,
            $output_tokens: record.outputTokens,
            $cache_read_tokens: record.cacheReadTokens,
            $cache_write_tokens: record.cacheWriteTokens,
            $total_tokens: record.totalTokens,
          });
          backfilledEvents += 1;
        },
      });
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return {
    backfilledEvents,
    skippedEvents,
    filesScanned,
    cutoffMs: earliestExistingTimestampMs,
  };
};

module.exports = {
  getBackfillStatus,
  backfillFromTranscripts,
};
