const topicRegistry = require("../topic-registry");
const { parsePositiveInt } = require("../utils/number");
const fs = require("fs");
const path = require("path");

const kSummaryCacheTtlMs = 60 * 1000;
const kClientTimeZoneHeader = "x-client-timezone";

const createSummaryCache = () => new Map();
const readOnboardingMarker = ({ onboardingMarkerPath, fsModule = fs }) => {
  const safePath = String(onboardingMarkerPath || "").trim();
  if (!safePath || !fsModule.existsSync(safePath)) return {};
  try {
    const parsed = JSON.parse(fsModule.readFileSync(safePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const writeOnboardingMarker = ({
  onboardingMarkerPath,
  marker,
  fsModule = fs,
}) => {
  const safePath = String(onboardingMarkerPath || "").trim();
  if (!safePath) return;
  fsModule.mkdirSync(path.dirname(safePath), { recursive: true });
  fsModule.writeFileSync(safePath, JSON.stringify(marker || {}, null, 2));
};
const toTitleLabel = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
};
const isUuidLike = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value || "").trim(),
  );

// Parse "agent:main:telegram:group:-123:topic:42" into structured labels.
const parseSessionLabels = (sessionKey) => {
  const raw = String(sessionKey || "").trim();
  if (!raw) return null;
  const parts = raw.split(":");
  const labels = [];

  if (parts[0] === "agent" && parts[1]) {
    labels.push({
      label: parts[1].charAt(0).toUpperCase() + parts[1].slice(1),
      tone: "cyan",
    });
  }

  const channelIndex = parts.indexOf("telegram");
  if (channelIndex !== -1 && parts[channelIndex + 1]) {
    const channelType = parts[channelIndex + 1];
    if (channelType === "direct") {
      labels.push({ label: "Telegram Direct", tone: "blue" });
    } else if (channelType === "group") {
      const groupId = parts[channelIndex + 2] || "";
      let groupName = null;
      let groupEntry = null;
      try {
        groupEntry = topicRegistry.getGroup(groupId);
        groupName = groupEntry?.name || null;
      } catch {}
      labels.push({
        label: groupName || `Group ${groupId}`,
        tone: "purple",
      });
      const topicIndex = parts.indexOf("topic", channelIndex);
      if (topicIndex !== -1 && parts[topicIndex + 1]) {
        const topicId = parts[topicIndex + 1];
        const topicName = groupEntry?.topics?.[topicId]?.name || null;
        labels.push({
          label: topicName || `Topic ${topicId}`,
          tone: "gray",
        });
      }
    } else {
      labels.push({
        label: `Telegram ${channelType.charAt(0).toUpperCase() + channelType.slice(1)}`,
        tone: "blue",
      });
    }
  }
  const hookIndex = parts.indexOf("hook");
  if (hookIndex !== -1) {
    labels.push({ label: "Hook", tone: "purple" });
    const hookName = String(parts[hookIndex + 1] || "").trim();
    if (hookName && !isUuidLike(hookName)) {
      labels.push({
        label: toTitleLabel(hookName),
        tone: "gray",
      });
    }
  }
  if (parts.includes("cron")) {
    labels.push({ label: "Cron", tone: "blue" });
  }

  return labels.length > 0 ? labels : null;
};

const enrichSessionLabels = (session) => ({
  ...session,
  labels: parseSessionLabels(session.sessionKey || session.sessionId),
});

const registerUsageRoutes = ({
  app,
  requireAuth,
  getDailySummary,
  getSessionsList,
  getSessionDetail,
  getSessionTimeSeries,
  getBackfillStatus,
  backfillFromTranscripts,
  openclawDir = "",
  onboardingMarkerPath = "",
  fsModule = fs,
}) => {
  const summaryCache = createSummaryCache();

  app.get("/api/usage/summary", requireAuth, (req, res) => {
    try {
      const days = parsePositiveInt(req.query.days, 30);
      const timeZone = String(
        req.get(kClientTimeZoneHeader) || req.query.timeZone || "",
      ).trim();
      const cacheKey = `${days}:${timeZone || "UTC"}`;
      const cached = summaryCache.get(cacheKey);
      const now = Date.now();
      if (cached && now - cached.cachedAt <= kSummaryCacheTtlMs) {
        res.json({ ok: true, ...cached.payload, cached: true });
        return;
      }
      const summary = getDailySummary({ days, timeZone });
      const payload = { summary };
      summaryCache.set(cacheKey, { payload, cachedAt: now });
      res.json({ ok: true, ...payload, cached: false });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/usage/sessions", requireAuth, (req, res) => {
    try {
      const limit = parsePositiveInt(req.query.limit, 50);
      const sessions = getSessionsList({ limit }).map(enrichSessionLabels);
      res.json({ ok: true, sessions });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/usage/sessions/:id", requireAuth, (req, res) => {
    try {
      const sessionId = String(req.params.id || "").trim();
      const detail = getSessionDetail({ sessionId });
      if (!detail) {
        res.status(404).json({ ok: false, error: "Session not found" });
        return;
      }
      res.json({ ok: true, detail: enrichSessionLabels(detail) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/usage/sessions/:id/timeseries", requireAuth, (req, res) => {
    try {
      const sessionId = String(req.params.id || "").trim();
      const maxPoints = parsePositiveInt(req.query.maxPoints, 100);
      const series = getSessionTimeSeries({ sessionId, maxPoints });
      res.json({ ok: true, series });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/usage/backfill/status", requireAuth, (req, res) => {
    try {
      const marker = readOnboardingMarker({ onboardingMarkerPath, fsModule });
      if (String(marker?.usageBackfilledAt || "").trim()) {
        res.json({ ok: true, available: false, estimatedFiles: 0 });
        return;
      }
      const status = getBackfillStatus({ openclawDir, fsModule });
      res.json({
        ok: true,
        available: !!status?.available,
        estimatedFiles: Number(status?.estimatedFiles || 0),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/usage/backfill", requireAuth, async (req, res) => {
    try {
      const marker = readOnboardingMarker({ onboardingMarkerPath, fsModule });
      if (String(marker?.usageBackfilledAt || "").trim()) {
        res.json({
          ok: true,
          alreadyBackfilled: true,
          backfilledEvents: 0,
          skippedEvents: 0,
          filesScanned: 0,
        });
        return;
      }
      const result = await backfillFromTranscripts({ openclawDir, fsModule });
      writeOnboardingMarker({
        onboardingMarkerPath,
        fsModule,
        marker: {
          ...marker,
          onboarded:
            typeof marker?.onboarded === "boolean" ? marker.onboarded : true,
          reason: String(marker?.reason || "onboarding_complete"),
          markedAt: String(marker?.markedAt || new Date().toISOString()),
          usageBackfilledAt: new Date().toISOString(),
          usageBackfilledEvents: Number(result?.backfilledEvents || 0),
        },
      });
      summaryCache.clear();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
};

module.exports = { registerUsageRoutes };
