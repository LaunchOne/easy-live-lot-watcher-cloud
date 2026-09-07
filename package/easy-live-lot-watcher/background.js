"use strict";

const DEFAULT_SETTINGS = {
  threshold: 5,
  timedThresholdMinutes: 3,
  defaultLiveStages: [5],
  defaultTimedStagesSeconds: [180],
  accountWatchImportEnabled: true,
  desktopEnabled: true,
  pushoverEnabled: false,
  pushoverUserKey: "",
  pushoverAppToken: "",
  pushoverPriority: 1,
  reliabilityMode: true,
  autoRecoveryEnabled: false,
  disconnectWarningMinutes: 2,
  cloudEnabled: false,
  cloudServiceUrl: "",
  cloudApiKey: ""
};

const STORAGE_KEYS = {
  settings: "settings",
  configs: "auctionConfigs",
  timedConfigs: "timedAuctionConfigs",
  runtime: "auctionRuntime",
  alerted: "liveAlertedStages",
  legacyAlerted: "alertedLots",
  timedAlerted: "timedAlertedStages",
  legacyTimedAlerted: "timedAlertedDeadlines",
  timedAlarmIndex: "timedAlarmIndex",
  origins: "enabledOrigins",
  links: "notificationLinks",
  history: "alertHistory",
  healthWarnings: "healthWarnings",
  diagnostics: "diagnosticLog",
  cloudStatus: "cloudStatus"
};

const HEALTH_ALARM = "easy-live-health-check";
const CLOUD_SYNC_ALARM = "easy-live-cloud-sync";
const HEALTH_REMINDER_MS = 10 * 60 * 1000;
const HEALTH_RECOVERY_RESET_MS = 10 * 60 * 1000;
const HEALTH_MAX_NOTIFICATIONS = 2;
const DIAGNOSTIC_LIMIT = 200;
const CLOUD_STATUS_REFRESH_MS = 15 * 1000;
const BACKUP_FORMAT = "easy-live-lot-watcher-backup";
let mutationQueue = Promise.resolve();
let powerHeld = false;
const protectedTabIds = new Set();
let cloudSyncTimer = null;

function serializeMutation(task) {
  const result = mutationQueue.then(task, task);
  mutationQueue = result.catch(() => null);
  return result;
}

function hashText(text) {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
  return (hash >>> 0).toString(36);
}

function scriptId(origin) {
  return `easy-live-watch-${hashText(origin)}`;
}

function diagnosticUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch (_error) {
    return String(value || "").slice(0, 1000);
  }
}

function sensitiveDiagnosticField(key) {
  const normalized = String(key || "").replace(/[^a-z]/gi, "").toLowerCase();
  return /(?:password|passcode|authorization|cookie|secret|credential|payment|cardnumber|token|apikey|userkey)/.test(normalized);
}

function sanitizeDiagnostic(value, key = "", depth = 0) {
  if (sensitiveDiagnosticField(key)) return "[redacted]";
  if (depth > 8) return "[depth limit]";
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return /(?:url|href)$/i.test(key) ? diagnosticUrl(value) : value.slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 250).map((item) => sanitizeDiagnostic(item, key, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 500)
      .map(([childKey, childValue]) => [childKey, sanitizeDiagnostic(childValue, childKey, depth + 1)]));
  }
  return String(value).slice(0, 500);
}

function redactDiagnosticSecrets(value, secrets) {
  if (typeof value === "string") {
    return secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), value);
  }
  if (Array.isArray(value)) return value.map((item) => redactDiagnosticSecrets(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .map(([key, childValue]) => [key, redactDiagnosticSecrets(childValue, secrets)]));
  }
  return value;
}

async function recordDiagnostic({ event, level = "info", auctionKey = "", details = {} } = {}) {
  if (!event) return;
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.diagnostics);
    const log = Array.isArray(stored[STORAGE_KEYS.diagnostics]) ? stored[STORAGE_KEYS.diagnostics] : [];
    log.push({
      time: Date.now(),
      event: String(event).slice(0, 120),
      level: ["info", "warning", "error"].includes(level) ? level : "info",
      auctionKey: String(auctionKey || "").slice(0, 500),
      details: sanitizeDiagnostic(details)
    });
    await chrome.storage.local.set({ [STORAGE_KEYS.diagnostics]: log.slice(-DIAGNOSTIC_LIMIT) });
  } catch (_error) {}
}

function normalizeLot(value) {
  return String(value ?? "").trim().replace(/^lot\s*(?:no\.?\s*)?/i, "").replace(/\s+/g, "").toUpperCase();
}

function normalizeLiveStages(values, fallback = [5]) {
  const stages = Array.from(new Set((Array.isArray(values) ? values : fallback)
    .map((value) => Math.max(0, Math.min(50, Number.parseInt(value, 10))))
    .filter(Number.isFinite)));
  return stages.length ? stages.sort((a, b) => b - a) : [5];
}

function normalizeTimedStages(values, fallback = [180]) {
  const stages = Array.from(new Set((Array.isArray(values) ? values : fallback)
    .map((value) => Math.max(10, Math.min(10800, Number.parseInt(value, 10))))
    .filter(Number.isFinite)));
  return stages.length ? stages.sort((a, b) => b - a) : [180];
}

function liveStageKey(auctionKey, lot, stage) {
  return `${auctionKey}::${normalizeLot(lot)}::${Number(stage)}`;
}

function timedStageKey(auctionKey, lot, stageSeconds) {
  return `${auctionKey}::${normalizeLot(lot)}::${Number(stageSeconds)}`;
}

function timedAlarmName(auctionKey, lot, stageSeconds) {
  return `easy-live-timed-${hashText(timedStageKey(auctionKey, lot, stageSeconds))}`;
}

function formatTimedStage(seconds) {
  const value = Number(seconds);
  if (value < 60) return `${value} second${value === 1 ? "" : "s"}`;
  const minutes = value / 60;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} minute${minutes === 1 ? "" : "s"}`;
}

function timedStageProcessed(value) {
  return Boolean(value);
}

function terminalLotState(state) {
  return ["ended", "passed", "unavailable"].includes(state);
}

function allWatchedLotsTerminal(status) {
  const watched = status?.watched || [];
  return watched.length > 0 && watched.every((item) => terminalLotState(item.state));
}

function cloudLiveDistance(current, target, order = []) {
  const currentLot = normalizeLot(current);
  const targetLot = normalizeLot(target);
  const normalizedOrder = order.map(normalizeLot);
  const currentIndex = normalizedOrder.indexOf(currentLot);
  const targetIndex = normalizedOrder.indexOf(targetLot);
  if (currentIndex >= 0 && targetIndex >= 0) return targetIndex - currentIndex;
  const currentNumber = Number(currentLot.match(/^\d+/)?.[0]);
  const targetNumber = Number(targetLot.match(/^\d+/)?.[0]);
  return Number.isFinite(currentNumber) && Number.isFinite(targetNumber) ? targetNumber - currentNumber : null;
}

function mergeCloudLiveRuntime(auctionKey, config, localStatus = {}, cloudRuntime = {}) {
  const currentLot = normalizeLot(cloudRuntime.currentLot);
  if (!currentLot) return localStatus;
  const order = Array.isArray(cloudRuntime.order) ? cloudRuntime.order.map(normalizeLot).filter(Boolean) : [];
  const localByLot = new Map((localStatus.watched || []).map((item) => [normalizeLot(item.targetLot), item]));
  const watched = (config.lots || []).map((targetLot) => {
    const lot = normalizeLot(targetLot);
    const existing = localByLot.get(lot) || { targetLot: lot };
    const remaining = cloudLiveDistance(currentLot, lot, order);
    const state = !Number.isFinite(remaining) ? "waiting" : remaining < 0 ? "passed" : remaining === 0 ? "live" : "upcoming";
    const statusText = state === "waiting" ? "Waiting for live catalogue order"
      : state === "passed" ? "Passed"
        : state === "live" ? "Live now"
          : `${remaining} lot${remaining === 1 ? "" : "s"} away`;
    return {
      ...existing,
      targetLot: lot,
      currentLot,
      remaining,
      state,
      statusText,
      visible: Number.isFinite(remaining),
      bidUrl: cloudRuntime.bidLiveUrl || localStatus.bidLiveUrl || existing.bidUrl || existing.url || config.url || ""
    };
  }).sort((left, right) => {
    const rank = (item) => item.state === "live" ? -1 : item.state === "upcoming" ? item.remaining : item.state === "passed" ? 100000 : 99999;
    return rank(left) - rank(right);
  });
  return {
    ...localStatus,
    mode: "live",
    auctionKey,
    auctionLabel: cloudRuntime.label || localStatus.auctionLabel || config.auctionLabel || "Live auction",
    livePhase: "active",
    ready: true,
    currentLot,
    orderSize: order.length,
    auctionEnded: Boolean(cloudRuntime.auctionEnded),
    monitoringComplete: Boolean(cloudRuntime.monitoringComplete),
    bidLiveUrl: cloudRuntime.bidLiveUrl || localStatus.bidLiveUrl || config.bidLiveUrl || "",
    url: cloudRuntime.bidLiveUrl || localStatus.url || config.url || "",
    cloudManaged: true,
    lastSeen: Number(cloudRuntime.lastSuccessAt || cloudRuntime.lastCheckedAt || Date.now()),
    watched
  };
}

function confirmedTerminalWatch(mode, item, auctionEnded = false) {
  if (auctionEnded || item?.state === "unavailable") return true;
  if (mode === "live") return item?.state === "passed";
  return Boolean(item?.confirmedEnded || Number(item?.expiredChecks || 0) >= 2);
}

async function pruneCompletedWatches() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.configs, STORAGE_KEYS.timedConfigs, STORAGE_KEYS.runtime,
    STORAGE_KEYS.alerted, STORAGE_KEYS.legacyAlerted, STORAGE_KEYS.timedAlerted,
    STORAGE_KEYS.timedAlarmIndex, STORAGE_KEYS.healthWarnings
  ]);
  const liveConfigs = { ...(stored[STORAGE_KEYS.configs] || {}) };
  const timedConfigs = { ...(stored[STORAGE_KEYS.timedConfigs] || {}) };
  const runtime = { ...(stored[STORAGE_KEYS.runtime] || {}) };
  const liveAlerted = { ...(stored[STORAGE_KEYS.alerted] || {}) };
  const legacyAlerted = { ...(stored[STORAGE_KEYS.legacyAlerted] || {}) };
  const timedAlerted = { ...(stored[STORAGE_KEYS.timedAlerted] || {}) };
  const alarmIndex = { ...(stored[STORAGE_KEYS.timedAlarmIndex] || {}) };
  const warnings = { ...(stored[STORAGE_KEYS.healthWarnings] || {}) };
  const removed = [];

  for (const [mode, configs] of [["live", liveConfigs], ["timed", timedConfigs]]) {
    for (const [auctionKey, config] of Object.entries(configs)) {
      const status = runtime[auctionKey] || {};
      const watchedByLot = new Map((status.watched || []).map((item) => [normalizeLot(item.targetLot), item]));
      const originalLots = Array.from(new Set((config.lots || []).map(normalizeLot).filter(Boolean)));
      const auctionComplete = Boolean(status.auctionEnded || (status.monitoringComplete && originalLots.length &&
        originalLots.every((lot) => confirmedTerminalWatch(mode, watchedByLot.get(lot), false))));
      const removedLots = originalLots.filter((lot) =>
        auctionComplete || confirmedTerminalWatch(mode, watchedByLot.get(lot), Boolean(status.auctionEnded))
      );
      const removedSet = new Set(removedLots);
      const remainingLots = originalLots.filter((lot) => !removedSet.has(lot));
      if (!removedLots.length && remainingLots.length === originalLots.length && remainingLots.length) continue;

      for (const lot of removedLots) {
        for (const key of Object.keys(liveAlerted)) if (key.startsWith(`${auctionKey}::${lot}::`)) delete liveAlerted[key];
        delete legacyAlerted[`${auctionKey}::${lot}`];
        for (const key of Object.keys(timedAlerted)) if (key.startsWith(`${auctionKey}::${lot}::`)) delete timedAlerted[key];
        for (const [alarmName, scheduled] of Object.entries(alarmIndex)) {
          if (scheduled.auctionKey === auctionKey && normalizeLot(scheduled.targetLot) === lot) {
            await chrome.alarms.clear(alarmName);
            delete alarmIndex[alarmName];
          }
        }
        if (config.lotOptions) delete config.lotOptions[lot];
      }

      if (!remainingLots.length) {
        delete configs[auctionKey];
        delete runtime[auctionKey];
        delete warnings[auctionKey];
      } else {
        configs[auctionKey] = { ...config, lots: remainingLots, updatedAt: Date.now() };
        if (runtime[auctionKey]?.watched) {
          runtime[auctionKey] = {
            ...runtime[auctionKey],
            watched: runtime[auctionKey].watched.filter((item) => remainingLots.includes(normalizeLot(item.targetLot)))
          };
        }
      }
      removed.push({ auctionKey, mode, lots: removedLots, auctionRemoved: !remainingLots.length });
    }
  }

  if (!removed.length) return { changed: false, removed: [] };
  await chrome.storage.local.set({
    [STORAGE_KEYS.configs]: liveConfigs,
    [STORAGE_KEYS.timedConfigs]: timedConfigs,
    [STORAGE_KEYS.runtime]: runtime,
    [STORAGE_KEYS.alerted]: liveAlerted,
    [STORAGE_KEYS.legacyAlerted]: legacyAlerted,
    [STORAGE_KEYS.timedAlerted]: timedAlerted,
    [STORAGE_KEYS.timedAlarmIndex]: alarmIndex,
    [STORAGE_KEYS.healthWarnings]: warnings
  });
  for (const item of removed) {
    await recordDiagnostic({
      event: item.auctionRemoved ? "completed-auction-removed" : "completed-lots-removed",
      auctionKey: item.auctionKey,
      details: { mode: item.mode, lots: item.lots }
    });
  }
  return { changed: true, removed };
}

async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const settings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) };
  if (!Array.isArray(settings.defaultLiveStages)) settings.defaultLiveStages = [settings.threshold || 5];
  if (!Array.isArray(settings.defaultTimedStagesSeconds)) {
    settings.defaultTimedStagesSeconds = [(settings.timedThresholdMinutes || 3) * 60];
  }
  settings.defaultLiveStages = normalizeLiveStages(settings.defaultLiveStages, [settings.threshold || 5]);
  settings.defaultTimedStagesSeconds = normalizeTimedStages(
    settings.defaultTimedStagesSeconds,
    [(settings.timedThresholdMinutes || 3) * 60]
  );
  return settings;
}

function normalizeCloudServiceUrl(value) {
  const url = new URL(String(value || "").trim());
  if (url.protocol !== "https:") throw new Error("The Railway service URL must use HTTPS.");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

async function cloudRequest(path, options = {}) {
  const settings = await getSettings();
  if (!settings.cloudEnabled) throw new Error("Cloud monitoring is not enabled.");
  if (!settings.cloudServiceUrl || !settings.cloudApiKey) throw new Error("Railway connection details are incomplete.");
  const base = normalizeCloudServiceUrl(settings.cloudServiceUrl);
  const response = await fetch(`${base}${path}`, {
    ...options,
    credentials: "omit",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.cloudApiKey}`,
      ...(options.headers || {})
    }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) throw new Error(result.error || `Railway returned HTTP ${response.status}.`);
  return result;
}

function cloudWatchedLots(config, status, mode) {
  return (config.lots || []).map((lot) => {
    const runtime = (status?.watched || []).find((item) => normalizeLot(item.targetLot) === normalizeLot(lot)) || {};
    const options = config.lotOptions?.[lot] || {};
    return {
      lot: normalizeLot(lot),
      ...(mode === "timed"
        ? { stagesSeconds: normalizeTimedStages(options.stagesSeconds) }
        : { stages: normalizeLiveStages(options.stages) }),
      url: runtime.bidUrl || runtime.url || "",
      description: runtime.description || ""
    };
  });
}

async function buildCloudPayload() {
  await pruneCompletedWatches();
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.configs, STORAGE_KEYS.timedConfigs, STORAGE_KEYS.runtime
  ]);
  const runtime = stored[STORAGE_KEYS.runtime] || {};
  const entries = [
    ...Object.entries(stored[STORAGE_KEYS.configs] || {}).map(([auctionKey, config]) => ({ auctionKey, config, mode: "live" })),
    ...Object.entries(stored[STORAGE_KEYS.timedConfigs] || {}).map(([auctionKey, config]) => ({ auctionKey, config, mode: "timed" }))
  ].filter(({ config }) => configHasLots(config));
  return {
    extensionVersion: chrome.runtime.getManifest().version,
    syncedAt: Date.now(),
    auctions: entries.map(({ auctionKey, config, mode }) => {
      const status = runtime[auctionKey] || {};
      return {
        mode,
        auctionKey,
        auctionId: config.auctionId || status.auctionId || "",
        dayId: config.dayId || status.dayId || "",
        label: config.auctionLabel || status.auctionLabel || "Easy Live Auction",
        url: config.url || status.url || "",
        bidLiveUrl: status.bidLiveUrl || config.bidLiveUrl || "",
        lots: cloudWatchedLots(config, status, mode),
        updatedAt: config.updatedAt || 0
      };
    })
  };
}

async function applyCloudCompletions(remote) {
  const completedAuctions = remote?.completedAuctions || {};
  const completedLots = remote?.completedLots || {};
  if (!Object.keys(completedAuctions).length && !Object.keys(completedLots).length) return { changed: false };
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.configs, STORAGE_KEYS.timedConfigs, STORAGE_KEYS.runtime
  ]);
  const configs = { ...(stored[STORAGE_KEYS.configs] || {}), ...(stored[STORAGE_KEYS.timedConfigs] || {}) };
  const runtime = { ...(stored[STORAGE_KEYS.runtime] || {}) };
  let changed = false;
  for (const [auctionKey, config] of Object.entries(configs)) {
    const completedAuction = completedAuctions[auctionKey];
    const lots = completedLots[auctionKey] || {};
    if (!completedAuction && !Object.keys(lots).length) continue;
    const mode = config.mode === "live" ? "live" : "timed";
    const previous = runtime[auctionKey] || {};
    runtime[auctionKey] = {
      ...previous,
      mode,
      auctionKey,
      auctionEnded: Boolean(completedAuction),
      monitoringComplete: Boolean(completedAuction),
      terminalReason: completedAuction ? "cloud-complete" : previous.terminalReason || "",
      watched: (config.lots || []).map((targetLot) => {
        const old = (previous.watched || []).find((item) => normalizeLot(item.targetLot) === normalizeLot(targetLot)) || {};
        if (!lots[normalizeLot(targetLot)] && !completedAuction) return { ...old, targetLot };
        return mode === "live"
          ? { ...old, targetLot, state: "passed" }
          : { ...old, targetLot, state: "ended", confirmedEnded: true, expiredChecks: 2 };
      })
    };
    changed = true;
  }
  if (!changed) return { changed: false };
  await chrome.storage.local.set({ [STORAGE_KEYS.runtime]: runtime });
  return pruneCompletedWatches();
}

async function syncCloud({ test = false } = {}) {
  const settings = await getSettings();
  if (!settings.cloudEnabled) {
    const status = { connected: false, disabled: true, checkedAt: Date.now(), error: "" };
    await chrome.storage.local.set({ [STORAGE_KEYS.cloudStatus]: status });
    return status;
  }
  try {
    const payload = await buildCloudPayload();
    const sync = await cloudRequest("/api/sync", { method: "PUT", body: JSON.stringify(payload) });
    if (test) await cloudRequest("/api/test", { method: "POST", body: "{}" });
    const remote = await cloudRequest("/api/status", { method: "GET" });
    await applyCloudCompletions(remote);
    const status = {
      connected: true,
      checkedAt: Date.now(),
      lastSyncAt: Date.now(),
      auctionCount: sync.auctionCount ?? payload.auctions.length,
      watchedLotCount: sync.watchedLotCount ?? remote.watchedLots?.total ?? null,
      serviceVersion: remote.version || "",
      runtime: remote.runtime || {},
      readiness: remote.readiness || {},
      activeAuctions: remote.activeAuctions || [],
      events: remote.events || [],
      alertLog: remote.alertLog || [],
      error: ""
    };
    await chrome.storage.local.set({ [STORAGE_KEYS.cloudStatus]: status });
    await recordDiagnostic({ event: "cloud-sync-complete", details: {
      auctionCount: status.auctionCount,
      watchedLotCount: status.watchedLotCount,
      serviceVersion: status.serviceVersion
    } });
    return status;
  } catch (error) {
    const status = { connected: false, checkedAt: Date.now(), error: error.message || String(error) };
    await chrome.storage.local.set({ [STORAGE_KEYS.cloudStatus]: status });
    await recordDiagnostic({ event: "cloud-sync-failed", level: "error", details: { message: status.error } });
    throw error;
  }
}

async function refreshCloudStatus({ force = false } = {}) {
  const settings = await getSettings();
  const stored = await chrome.storage.local.get(STORAGE_KEYS.cloudStatus);
  const previous = stored[STORAGE_KEYS.cloudStatus] || { connected: false };
  if (!settings.cloudEnabled) return { connected: false, disabled: true, checkedAt: Date.now(), error: "" };
  if (!force && previous.connected && Date.now() - Number(previous.checkedAt || 0) < CLOUD_STATUS_REFRESH_MS) return previous;
  try {
    const remote = await cloudRequest("/api/status", { method: "GET" });
    await applyCloudCompletions(remote);
    const status = {
      ...previous,
      connected: true,
      checkedAt: Date.now(),
      auctionCount: remote.auctionCount ?? previous.auctionCount ?? null,
      watchedLotCount: remote.watchedLots?.total ?? previous.watchedLotCount ?? null,
      serviceVersion: remote.version || previous.serviceVersion || "",
      runtime: remote.runtime || {},
      readiness: remote.readiness || {},
      activeAuctions: remote.activeAuctions || [],
      events: remote.events || [],
      alertLog: remote.alertLog || [],
      error: ""
    };
    await chrome.storage.local.set({ [STORAGE_KEYS.cloudStatus]: status });
    return status;
  } catch (error) {
    const recentlyConnected = previous.connected && Date.now() - Number(previous.checkedAt || 0) < 3 * 60 * 1000;
    const status = {
      ...previous,
      connected: recentlyConnected,
      error: error.message || String(error),
      failedAt: Date.now()
    };
    await chrome.storage.local.set({ [STORAGE_KEYS.cloudStatus]: status });
    return status;
  }
}

async function effectiveLiveStatus(localStatus) {
  if (localStatus?.mode !== "live" || !localStatus.auctionKey || localStatus.currentLot) return localStatus;
  const cloud = await refreshCloudStatus();
  const cloudRuntime = cloud.runtime?.[localStatus.auctionKey];
  const fresh = cloud.connected && cloudRuntime &&
    Date.now() - Number(cloudRuntime.lastSuccessAt || cloudRuntime.lastCheckedAt || 0) < 3 * 60 * 1000;
  if (!fresh || !cloudRuntime.currentLot) return localStatus;
  const stored = await chrome.storage.local.get(STORAGE_KEYS.configs);
  const config = (stored[STORAGE_KEYS.configs] || {})[localStatus.auctionKey];
  return config ? mergeCloudLiveRuntime(localStatus.auctionKey, config, localStatus, cloudRuntime) : localStatus;
}

function scheduleCloudSync(delay = 500) {
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => serializeMutation(() => syncCloud()).catch(() => null), delay);
}

async function registerOrigin(origin) {
  const baseId = scriptId(origin);
  const scripts = [
    { id: baseId, matches: [`${origin}/*`], js: ["core.js", "content.js"], runAt: "document_start", persistAcrossSessions: true },
    { id: `${baseId}-page`, matches: [`${origin}/*`], js: ["page-bridge.js"], runAt: "document_start", world: "MAIN", persistAcrossSessions: true }
  ];
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: scripts.map((script) => script.id) });
  const existingIds = new Set(existing.map((script) => script.id));
  const updates = scripts.filter((script) => existingIds.has(script.id));
  const additions = scripts.filter((script) => !existingIds.has(script.id));
  if (updates.length) await chrome.scripting.updateContentScripts(updates);
  if (additions.length) await chrome.scripting.registerContentScripts(additions);
  const stored = await chrome.storage.local.get(STORAGE_KEYS.origins);
  const origins = Array.from(new Set([...(stored[STORAGE_KEYS.origins] || []), origin]));
  await chrome.storage.local.set({ [STORAGE_KEYS.origins]: origins });
}

async function restoreRegistrations() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.origins);
  for (const origin of stored[STORAGE_KEYS.origins] || []) {
    try {
      const permitted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
      if (permitted) await registerOrigin(origin);
    } catch (error) {
      console.warn("Could not restore monitoring for", origin, error);
    }
  }
}

async function recordHistory(entry) {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.history);
  const history = stored[STORAGE_KEYS.history] || [];
  history.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, time: Date.now(), ...entry });
  await chrome.storage.local.set({ [STORAGE_KEYS.history]: history.slice(0, 250) });
}

async function sendPushover({ title, message, url }, settings) {
  if (!settings.pushoverEnabled) return { skipped: true };
  if (!settings.pushoverUserKey || !settings.pushoverAppToken) {
    throw new Error("Pushover is enabled but its User Key or App Token is missing.");
  }
  const body = new URLSearchParams({
    token: settings.pushoverAppToken,
    user: settings.pushoverUserKey,
    title,
    message,
    priority: String(settings.pushoverPriority ?? 1),
    sound: "pushover"
  });
  if (url) {
    body.set("url", url);
    body.set("url_title", "Open auction");
  }
  const response = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.status !== 1) {
    const detail = Array.isArray(result.errors) ? result.errors.join(" ") : `HTTP ${response.status}`;
    throw new Error(`Pushover rejected the alert: ${detail}`);
  }
  return result;
}

async function createDesktopNotification({ title, message, url, notificationId }) {
  const id = notificationId || `easy-live-watch-${Date.now()}`;
  await chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message,
    priority: 2,
    requireInteraction: true
  });
  if (url) {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.links);
    const links = stored[STORAGE_KEYS.links] || {};
    links[id] = { url, createdAt: Date.now() };
    await chrome.storage.local.set({
      [STORAGE_KEYS.links]: Object.fromEntries(
        Object.entries(links).filter(([, value]) => Date.now() - value.createdAt < 7 * 24 * 60 * 60 * 1000)
      )
    });
  }
  return id;
}

async function deliverAlert(payload, options = {}) {
  const settings = await getSettings();
  const errors = [];
  let desktopSent = false;
  let pushoverSent = false;
  if (settings.desktopEnabled || options.forceDesktop) {
    try {
      await createDesktopNotification(payload);
      desktopSent = true;
    } catch (error) {
      errors.push(`Desktop: ${error.message}`);
    }
  }
  try {
    const result = settings.cloudEnabled && !options.forceLocalPushover
      ? { skipped: true, cloudManaged: true }
      : await sendPushover(payload, settings);
    pushoverSent = !result.skipped;
  } catch (error) {
    errors.push(error.message);
    if (!desktopSent) {
      try {
        await createDesktopNotification({
          title: "Easy Live Watcher could not send to Pushover",
          message: error.message,
          notificationId: `easy-live-pushover-error-${Date.now()}`
        });
        desktopSent = true;
      } catch (_desktopError) {}
    }
  }
  return { desktopSent, pushoverSent, errors };
}

async function notifyAndRecord(payload, meta = {}, options = {}) {
  const delivery = await deliverAlert(payload, options);
  await recordHistory({
    type: meta.type || "alert",
    mode: meta.mode || "system",
    auctionKey: meta.auctionKey || "",
    auctionLabel: meta.auctionLabel || "",
    lot: meta.lot || "",
    stage: meta.stage ?? null,
    title: payload.title,
    message: payload.message,
    url: payload.url || "",
    delivery
  });
  return delivery;
}

async function getTab(tabId) {
  if (!tabId || !chrome.tabs?.get) return null;
  try { return await chrome.tabs.get(tabId); } catch (_error) { return null; }
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.href;
  } catch (_error) {
    return String(value || "");
  }
}

async function focusOrOpenUrl(url, preferredTabId = null) {
  const preferred = await getTab(preferredTabId);
  if (preferred?.id != null) {
    await chrome.tabs.update(preferred.id, { active: true });
    if (preferred.windowId != null) await chrome.windows.update(preferred.windowId, { focused: true });
    return preferred;
  }
  const target = canonicalUrl(url);
  const tabs = target && chrome.tabs?.query ? await chrome.tabs.query({}) : [];
  const existing = tabs.find((tab) => tab.id != null && canonicalUrl(tab.url) === target);
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true });
    return existing;
  }
  return url ? chrome.tabs.create({ url }) : null;
}

function configHasLots(config) {
  return Boolean(config && Array.isArray(config.lots) && config.lots.length);
}

async function protectTab(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: false });
    protectedTabIds.add(tabId);
  } catch (_error) {}
}

async function refreshReliabilityState() {
  const settings = await getSettings();
  const stored = await chrome.storage.local.get([STORAGE_KEYS.configs, STORAGE_KEYS.timedConfigs, STORAGE_KEYS.runtime]);
  const configs = { ...(stored[STORAGE_KEYS.configs] || {}), ...(stored[STORAGE_KEYS.timedConfigs] || {}) };
  const runtime = stored[STORAGE_KEYS.runtime] || {};
  const now = Date.now();
  const activeTabIds = new Set();
  if (settings.reliabilityMode) {
    for (const [auctionKey, config] of Object.entries(configs)) {
      const status = runtime[auctionKey];
      const unfinished = !status?.monitoringComplete &&
        (status?.watched || []).some((item) => !terminalLotState(item.state));
      if (configHasLots(config) && status?.tabId && now - Number(status.lastSeen || 0) < 5 * 60 * 1000 && unfinished) {
        activeTabIds.add(status.tabId);
        await protectTab(status.tabId);
      }
    }
  }
  for (const tabId of Array.from(protectedTabIds)) {
    if (!activeTabIds.has(tabId)) {
      try { await chrome.tabs.update(tabId, { autoDiscardable: true }); } catch (_error) {}
      protectedTabIds.delete(tabId);
    }
  }
  if (settings.reliabilityMode && activeTabIds.size) {
    if (!powerHeld && chrome.power?.requestKeepAwake) {
      chrome.power.requestKeepAwake("system");
      powerHeld = true;
    }
  } else if (powerHeld && chrome.power?.releaseKeepAwake) {
    chrome.power.releaseKeepAwake();
    powerHeld = false;
  }
  return { enabled: settings.reliabilityMode, active: powerHeld, protectedTabs: activeTabIds.size };
}

async function updateRuntime(payload, sender, source = "PAGE_STATUS") {
  if (!payload?.auctionKey) return;
  const stored = await chrome.storage.local.get(STORAGE_KEYS.runtime);
  const runtime = stored[STORAGE_KEYS.runtime] || {};
  const previous = runtime[payload.auctionKey] || {};
  if (payload.mode === "timed" && Array.isArray(previous.watched)) {
    for (const item of payload.watched || []) {
      const old = previous.watched.find((candidate) => candidate.targetLot === item.targetLot);
      const oldDeadline = Number(old?.deadlineMs);
      const nextDeadline = Number(item.deadlineMs);
      if (Number.isFinite(oldDeadline) && Number.isFinite(nextDeadline) && nextDeadline > oldDeadline + 1000) {
        await recordHistory({
          type: "extension",
          mode: "timed",
          auctionKey: payload.auctionKey,
          auctionLabel: payload.auctionLabel,
          lot: item.targetLot,
          title: `Lot ${item.targetLot} deadline extended`,
          message: `New closing time: ${new Date(nextDeadline).toLocaleString()}`,
          url: item.bidUrl || item.url || payload.url || "",
          delivery: { desktopSent: false, pushoverSent: false, errors: [] }
        });
      }
    }
  }
  const diagnosticSignature = JSON.stringify({
    mode: payload.mode,
    ready: payload.ready,
    lookupState: payload.lookupState,
    lookupError: payload.lookupError,
    auctionEnded: payload.auctionEnded,
    monitoringComplete: payload.monitoringComplete,
    watched: (payload.watched || []).map((item) => [item.targetLot, item.visible, item.state, item.deadlineMs || null])
  });
  runtime[payload.auctionKey] = {
    ...previous,
    ...payload,
    diagnosticSignature,
    tabId: sender.tab?.id ?? payload.tabId ?? previous.tabId ?? null,
    lastSeen: Date.now()
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.runtime]: runtime });
  await pruneCompletedWatches();
  if (source === "PAGE_STATUS" && diagnosticSignature !== previous.diagnosticSignature) {
    await recordDiagnostic({
      event: "page-status-changed",
      level: payload.lookupError ? "warning" : "info",
      auctionKey: payload.auctionKey,
      details: {
        mode: payload.mode,
        pageKind: payload.pageKind,
        ready: payload.ready,
        lookupState: payload.lookupState,
        lookupError: payload.lookupError || "",
        auctionEnded: payload.auctionEnded,
        monitoringComplete: payload.monitoringComplete,
        watched: (payload.watched || []).map((item) => ({
          lot: item.targetLot,
          visible: item.visible,
          state: item.state,
          deadlineMs: item.deadlineMs || null
        })),
        identity: payload.diagnostics || {},
        tabId: sender.tab?.id ?? null,
        pageUrl: payload.url || ""
      }
    });
  }
  if (sender.tab?.id) {
    const badge = payload.monitoringComplete ? "END" : payload.mode === "timed"
      ? String((payload.watched || []).filter((item) => item.state === "upcoming").length || "ON").slice(0, 4)
      : payload.currentLot ? String(payload.currentLot).slice(0, 4) : "ON";
    const badgeColor = payload.monitoringComplete ? "#68736d" : payload.ready ? "#137333" : "#a5261c";
    await chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: badgeColor });
    await chrome.action.setBadgeText({ tabId: sender.tab.id, text: badge });
  }
  await refreshReliabilityState();
}

async function saveLots({ auctionKey, auctionId, dayId, auctionLabel, url, lots, stages }) {
  const settings = await getSettings();
  const stored = await chrome.storage.local.get([STORAGE_KEYS.configs, STORAGE_KEYS.alerted, STORAGE_KEYS.legacyAlerted]);
  const configs = stored[STORAGE_KEYS.configs] || {};
  const alerted = stored[STORAGE_KEYS.alerted] || {};
  const legacy = stored[STORAGE_KEYS.legacyAlerted] || {};
  const existing = configs[auctionKey] || { lots: [], lotOptions: {} };
  const normalizedLots = lots.map(normalizeLot);
  const nextLots = Array.from(new Set([...(existing.lots || []), ...normalizedLots]));
  const lotOptions = { ...(existing.lotOptions || {}) };
  for (const lot of normalizedLots) {
    lotOptions[lot] = lotOptions[lot] || { stages: normalizeLiveStages(stages, settings.defaultLiveStages) };
    for (const key of Object.keys(alerted)) if (key.startsWith(`${auctionKey}::${lot}::`)) delete alerted[key];
    delete legacy[`${auctionKey}::${lot}`];
  }
  configs[auctionKey] = {
    ...existing,
    mode: "live",
    auctionId: auctionId || existing.auctionId || "",
    dayId: dayId || existing.dayId || "",
    auctionLabel: auctionLabel || existing.auctionLabel || "Easy Live Auction",
    url: url || existing.url || "",
    lots: nextLots,
    lotOptions,
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({
    [STORAGE_KEYS.configs]: configs,
    [STORAGE_KEYS.alerted]: alerted,
    [STORAGE_KEYS.legacyAlerted]: legacy
  });
  await refreshReliabilityState();
  return configs[auctionKey];
}

async function saveTimedLots({ auctionKey, auctionId, dayId, auctionLabel, url, lots, stagesSeconds }) {
  if (!auctionKey) throw new Error("The timed auction has not finished loading yet.");
  const settings = await getSettings();
  const stored = await chrome.storage.local.get([STORAGE_KEYS.timedConfigs, STORAGE_KEYS.timedAlerted]);
  const configs = stored[STORAGE_KEYS.timedConfigs] || {};
  const alerted = stored[STORAGE_KEYS.timedAlerted] || {};
  const existing = configs[auctionKey] || { lots: [], lotOptions: {} };
  const normalizedLots = lots.map(normalizeLot);
  const nextLots = Array.from(new Set([...(existing.lots || []), ...normalizedLots]));
  const lotOptions = { ...(existing.lotOptions || {}) };
  for (const lot of normalizedLots) {
    lotOptions[lot] = lotOptions[lot] || {
      stagesSeconds: normalizeTimedStages(stagesSeconds, settings.defaultTimedStagesSeconds)
    };
    for (const key of Object.keys(alerted)) if (key.startsWith(`${auctionKey}::${lot}::`)) delete alerted[key];
  }
  configs[auctionKey] = {
    ...existing,
    mode: "timed",
    auctionId: auctionId || existing.auctionId || "",
    dayId: dayId || existing.dayId || "",
    auctionLabel: auctionLabel || existing.auctionLabel || "Timed auction",
    url: url || existing.url || "",
    lots: nextLots,
    lotOptions,
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.timedConfigs]: configs, [STORAGE_KEYS.timedAlerted]: alerted });
  await recordDiagnostic({
    event: "timed-watch-saved",
    auctionKey,
    details: {
      auctionId: auctionId || existing.auctionId || "",
      dayId: dayId || existing.dayId || "",
      pageUrl: url || existing.url || "",
      addedLots: normalizedLots,
      beforeLots: existing.lots || [],
      afterLots: nextLots
    }
  });
  await refreshReliabilityState();
  return configs[auctionKey];
}

async function importAccountWatches({ mode, auctionKey, auctionId, dayId, auctionLabel, url, lots }) {
  if (!auctionKey) throw new Error("The auction has not finished loading yet.");
  const settings = await getSettings();
  if (!settings.accountWatchImportEnabled) return { added: 0, disabled: true };
  const timed = mode === "timed";
  const configKey = timed ? STORAGE_KEYS.timedConfigs : STORAGE_KEYS.configs;
  const stored = await chrome.storage.local.get(configKey);
  const configs = stored[configKey] || {};
  const existing = configs[auctionKey] || { lots: [], lotOptions: {} };
  const currentLots = new Set((existing.lots || []).map(normalizeLot));
  const detected = Array.from(new Set((lots || []).map(normalizeLot).filter(Boolean)));
  const addedLots = detected.filter((lot) => !currentLots.has(lot));
  if (!addedLots.length) return { added: 0, total: currentLots.size };
  const lotOptions = { ...(existing.lotOptions || {}) };
  for (const lot of addedLots) {
    currentLots.add(lot);
    lotOptions[lot] = timed
      ? { stagesSeconds: settings.defaultTimedStagesSeconds, importedFromAccount: true }
      : { stages: settings.defaultLiveStages, importedFromAccount: true };
  }
  configs[auctionKey] = {
    ...existing,
    mode: timed ? "timed" : "live",
    auctionId: auctionId || existing.auctionId || "",
    dayId: dayId || existing.dayId || "",
    auctionLabel: auctionLabel || existing.auctionLabel || (timed ? "Timed auction" : "Live auction"),
    url: url || existing.url || "",
    lots: Array.from(currentLots),
    lotOptions,
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({ [configKey]: configs });
  await recordDiagnostic({
    event: "account-watches-imported",
    auctionKey,
    details: { mode: timed ? "timed" : "live", addedLots, totalLots: currentLots.size, pageUrl: configs[auctionKey].url }
  });
  await recordHistory({
    type: "import",
    mode: timed ? "timed" : "live",
    auctionKey,
    auctionLabel: configs[auctionKey].auctionLabel,
    title: `Imported ${addedLots.length} watched lot${addedLots.length === 1 ? "" : "s"}`,
    message: `From the signed-in auction account: ${addedLots.map((lot) => `Lot ${lot}`).join(", ")}`,
    url: configs[auctionKey].url,
    delivery: { desktopSent: false, pushoverSent: false, errors: [] }
  });
  await refreshReliabilityState();
  return { added: addedLots.length, total: currentLots.size, lots: addedLots };
}

async function migrateMisclassifiedLiveConfig(payload) {
  const legacyKey = payload?.legacyTimedAuctionKey;
  if (payload?.mode !== "live" || payload?.livePhase !== "scheduled" || !payload.auctionKey || !legacyKey) return false;
  const settings = await getSettings();
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.configs, STORAGE_KEYS.timedConfigs, STORAGE_KEYS.timedAlerted,
    STORAGE_KEYS.timedAlarmIndex, STORAGE_KEYS.runtime
  ]);
  const liveConfigs = stored[STORAGE_KEYS.configs] || {};
  const timedConfigs = stored[STORAGE_KEYS.timedConfigs] || {};
  const legacy = timedConfigs[legacyKey];
  if (!legacy) return false;
  const existing = liveConfigs[payload.auctionKey] || { lots: [], lotOptions: {} };
  const lots = Array.from(new Set([...(existing.lots || []), ...(legacy.lots || [])].map(normalizeLot)));
  const lotOptions = { ...(existing.lotOptions || {}) };
  for (const lot of lots) {
    if (!lotOptions[lot]?.stages) lotOptions[lot] = { stages: settings.defaultLiveStages };
  }
  liveConfigs[payload.auctionKey] = {
    ...existing,
    mode: "live",
    auctionId: payload.auctionId || existing.auctionId || legacy.auctionId || "",
    dayId: payload.dayId || existing.dayId || legacy.dayId || "",
    auctionLabel: payload.auctionLabel || existing.auctionLabel || legacy.auctionLabel || "Live auction",
    url: payload.url || existing.url || legacy.url || "",
    lots,
    lotOptions,
    updatedAt: Date.now()
  };
  delete timedConfigs[legacyKey];

  const timedAlerted = stored[STORAGE_KEYS.timedAlerted] || {};
  for (const key of Object.keys(timedAlerted)) if (key.startsWith(`${legacyKey}::`)) delete timedAlerted[key];
  const alarmIndex = stored[STORAGE_KEYS.timedAlarmIndex] || {};
  for (const [alarmName, item] of Object.entries(alarmIndex)) {
    if (item.auctionKey === legacyKey) {
      await chrome.alarms.clear(alarmName);
      delete alarmIndex[alarmName];
    }
  }
  const runtime = stored[STORAGE_KEYS.runtime] || {};
  delete runtime[legacyKey];
  await chrome.storage.local.set({
    [STORAGE_KEYS.configs]: liveConfigs,
    [STORAGE_KEYS.timedConfigs]: timedConfigs,
    [STORAGE_KEYS.timedAlerted]: timedAlerted,
    [STORAGE_KEYS.timedAlarmIndex]: alarmIndex,
    [STORAGE_KEYS.runtime]: runtime
  });
  await recordDiagnostic({
    event: "watch-list-identity-migrated",
    auctionKey: payload.auctionKey,
    details: { fromAuctionKey: legacyKey, toAuctionKey: payload.auctionKey, lots, pageUrl: payload.url || "" }
  });
  return true;
}

async function migrateMisclassifiedTimedConfig(payload) {
  const legacyKey = payload?.legacyLiveAuctionKey;
  if (payload?.mode !== "timed" || !payload.auctionKey || !legacyKey) return false;
  const settings = await getSettings();
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.configs, STORAGE_KEYS.timedConfigs, STORAGE_KEYS.runtime,
    STORAGE_KEYS.alerted, STORAGE_KEYS.legacyAlerted
  ]);
  const liveConfigs = stored[STORAGE_KEYS.configs] || {};
  const timedConfigs = stored[STORAGE_KEYS.timedConfigs] || {};
  const legacy = liveConfigs[legacyKey];
  if (!legacy) return false;
  const existing = timedConfigs[payload.auctionKey] || { lots: [], lotOptions: {} };
  const lots = Array.from(new Set([...(existing.lots || []), ...(legacy.lots || [])].map(normalizeLot)));
  const lotOptions = { ...(existing.lotOptions || {}) };
  for (const lot of lots) {
    const oldOptions = legacy.lotOptions?.[lot] || {};
    if (!lotOptions[lot]?.stagesSeconds) {
      lotOptions[lot] = {
        stagesSeconds: settings.defaultTimedStagesSeconds,
        importedFromAccount: Boolean(oldOptions.importedFromAccount)
      };
    }
  }
  timedConfigs[payload.auctionKey] = {
    ...existing,
    mode: "timed",
    auctionId: payload.auctionId || existing.auctionId || legacy.auctionId || "",
    dayId: payload.dayId || existing.dayId || legacy.dayId || "",
    auctionLabel: payload.auctionLabel || existing.auctionLabel || legacy.auctionLabel || "Timed auction",
    url: payload.url || existing.url || legacy.url || "",
    lots, lotOptions, updatedAt: Date.now()
  };
  delete liveConfigs[legacyKey];
  const liveAlerted = stored[STORAGE_KEYS.alerted] || {};
  const legacyAlerted = stored[STORAGE_KEYS.legacyAlerted] || {};
  for (const key of Object.keys(liveAlerted)) if (key.startsWith(`${legacyKey}::`)) delete liveAlerted[key];
  for (const key of Object.keys(legacyAlerted)) if (key.startsWith(`${legacyKey}::`)) delete legacyAlerted[key];
  const runtime = stored[STORAGE_KEYS.runtime] || {};
  delete runtime[legacyKey];
  await chrome.storage.local.set({
    [STORAGE_KEYS.configs]: liveConfigs,
    [STORAGE_KEYS.timedConfigs]: timedConfigs,
    [STORAGE_KEYS.runtime]: runtime,
    [STORAGE_KEYS.alerted]: liveAlerted,
    [STORAGE_KEYS.legacyAlerted]: legacyAlerted
  });
  await recordDiagnostic({
    event: "watch-list-type-corrected",
    auctionKey: payload.auctionKey,
    details: { fromAuctionKey: legacyKey, toAuctionKey: payload.auctionKey, fromMode: "live", toMode: "timed", lots }
  });
  return true;
}

async function removeLot({ auctionKey, lot, mode }) {
  const timed = mode === "timed";
  const configKey = timed ? STORAGE_KEYS.timedConfigs : STORAGE_KEYS.configs;
  const alertedKey = timed ? STORAGE_KEYS.timedAlerted : STORAGE_KEYS.alerted;
  const stored = await chrome.storage.local.get([configKey, alertedKey, STORAGE_KEYS.timedAlarmIndex]);
  const configs = stored[configKey] || {};
  const alerted = stored[alertedKey] || {};
  const alarmIndex = stored[STORAGE_KEYS.timedAlarmIndex] || {};
  const target = normalizeLot(lot);
  if (configs[auctionKey]) {
    configs[auctionKey].lots = (configs[auctionKey].lots || []).filter((value) => value !== target);
    if (configs[auctionKey].lotOptions) delete configs[auctionKey].lotOptions[target];
    configs[auctionKey].updatedAt = Date.now();
  }
  for (const key of Object.keys(alerted)) if (key.startsWith(`${auctionKey}::${target}::`)) delete alerted[key];
  for (const [alarmName, item] of Object.entries(alarmIndex)) {
    if (item.auctionKey === auctionKey && item.targetLot === target) {
      await chrome.alarms.clear(alarmName);
      delete alarmIndex[alarmName];
    }
  }
  await chrome.storage.local.set({ [configKey]: configs, [alertedKey]: alerted, [STORAGE_KEYS.timedAlarmIndex]: alarmIndex });
  await refreshReliabilityState();
  return configs[auctionKey] || null;
}

async function updateLotAlerts({ auctionKey, lot, mode, stages, stagesSeconds }) {
  const timed = mode === "timed";
  const configKey = timed ? STORAGE_KEYS.timedConfigs : STORAGE_KEYS.configs;
  const alertedKey = timed ? STORAGE_KEYS.timedAlerted : STORAGE_KEYS.alerted;
  const stored = await chrome.storage.local.get([configKey, alertedKey, STORAGE_KEYS.legacyAlerted]);
  const configs = stored[configKey] || {};
  const config = configs[auctionKey];
  const target = normalizeLot(lot);
  if (!config || !(config.lots || []).includes(target)) throw new Error("That watched lot could not be found.");
  config.lotOptions = config.lotOptions || {};
  const previousOptions = config.lotOptions[target] || {};
  config.lotOptions[target] = timed
    ? { ...previousOptions, stagesSeconds: normalizeTimedStages(stagesSeconds) }
    : { ...previousOptions, stages: normalizeLiveStages(stages) };
  config.updatedAt = Date.now();
  const alerted = stored[alertedKey] || {};
  for (const key of Object.keys(alerted)) if (key.startsWith(`${auctionKey}::${target}::`)) delete alerted[key];
  const legacyAlerted = stored[STORAGE_KEYS.legacyAlerted] || {};
  if (!timed) delete legacyAlerted[`${auctionKey}::${target}`];
  await chrome.storage.local.set({
    [configKey]: configs,
    [alertedKey]: alerted,
    [STORAGE_KEYS.legacyAlerted]: legacyAlerted
  });
  const runtime = await chrome.storage.local.get(STORAGE_KEYS.runtime);
  const status = (runtime[STORAGE_KEYS.runtime] || {})[auctionKey];
  if (timed && status) await syncTimedSchedules(status);
  return config;
}

async function handleThresholdReached(payload) {
  const stage = Number(payload.stage);
  const stored = await chrome.storage.local.get(STORAGE_KEYS.alerted);
  const alerted = stored[STORAGE_KEYS.alerted] || {};
  const key = liveStageKey(payload.auctionKey, payload.targetLot, stage);
  if (alerted[key]) return { duplicate: true };
  for (const crossed of normalizeLiveStages(payload.stages || [stage])) {
    if (payload.remaining <= crossed && crossed >= stage) {
      alerted[liveStageKey(payload.auctionKey, payload.targetLot, crossed)] = {
        alertedAt: Date.now(), currentLot: payload.currentLot, remaining: payload.remaining
      };
    }
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.alerted]: alerted });
  const distanceText = stage === 0 || payload.remaining === 0
    ? "is live now"
    : `is ${payload.remaining} lot${payload.remaining === 1 ? "" : "s"} away`;
  const delivery = await notifyAndRecord({
    title: `Lot ${payload.targetLot} ${distanceText}`,
    message: `${payload.auctionLabel || "Easy Live Auction"}\nCurrent lot: ${payload.currentLot || "unknown"}`,
    url: payload.url,
    notificationId: `easy-live-${hashText(key)}-${Date.now()}`
  }, {
    type: "alert", mode: "live", auctionKey: payload.auctionKey,
    auctionLabel: payload.auctionLabel, lot: payload.targetLot, stage
  });
  return { duplicate: false, delivery };
}

async function syncTimedSchedules(status) {
  if (status?.mode !== "timed" || !status.auctionKey) return;
  const settings = await getSettings();
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.timedAlerted, STORAGE_KEYS.timedAlarmIndex, STORAGE_KEYS.timedConfigs
  ]);
  const alerted = stored[STORAGE_KEYS.timedAlerted] || {};
  const alarmIndex = stored[STORAGE_KEYS.timedAlarmIndex] || {};
  const config = (stored[STORAGE_KEYS.timedConfigs] || {})[status.auctionKey] || {};
  const now = Date.now();
  if (status.monitoringComplete || status.auctionEnded) {
    for (const [alarmName, scheduled] of Object.entries(alarmIndex)) {
      if (scheduled.auctionKey === status.auctionKey) {
        await chrome.alarms.clear(alarmName);
        delete alarmIndex[alarmName];
      }
    }
    await chrome.storage.local.set({
      [STORAGE_KEYS.timedAlarmIndex]: alarmIndex,
      [STORAGE_KEYS.timedAlerted]: alerted
    });
    return;
  }
  for (const item of status.watched || []) {
    const stages = normalizeTimedStages(
      item.stagesSeconds || config.lotOptions?.[item.targetLot]?.stagesSeconds,
      settings.defaultTimedStagesSeconds
    );
    const deadlineMs = item.deadlineMs === null || item.deadlineMs === undefined || item.deadlineMs === ""
      ? Number.NaN : Number(item.deadlineMs);
    const desiredNames = new Set(stages.map((stage) => timedAlarmName(status.auctionKey, item.targetLot, stage)));
    for (const [alarmName, scheduled] of Object.entries(alarmIndex)) {
      if (scheduled.auctionKey === status.auctionKey && scheduled.targetLot === item.targetLot && !desiredNames.has(alarmName)) {
        await chrome.alarms.clear(alarmName);
        delete alarmIndex[alarmName];
      }
    }
    if (item.visible === false && !Number.isFinite(deadlineMs)) continue;
    const remainingSeconds = (deadlineMs - now) / 1000;
    const dueUnsentStages = Number.isFinite(deadlineMs)
      ? stages.filter((stageSeconds) =>
        remainingSeconds <= stageSeconds &&
        !timedStageProcessed(alerted[timedStageKey(status.auctionKey, item.targetLot, stageSeconds)])
      )
      : [];
    const nearestDueStage = dueUnsentStages.length ? Math.min(...dueUnsentStages) : null;
    for (const stageSeconds of stages) {
      const alarmName = timedAlarmName(status.auctionKey, item.targetLot, stageSeconds);
      const key = timedStageKey(status.auctionKey, item.targetLot, stageSeconds);
      const alreadyProcessed = timedStageProcessed(alerted[key]);
      if (!Number.isFinite(deadlineMs) || deadlineMs <= now || terminalLotState(item.state) || alreadyProcessed) {
        await chrome.alarms.clear(alarmName);
        delete alarmIndex[alarmName];
        continue;
      }
      if (deadlineMs - stageSeconds * 1000 <= now && stageSeconds !== nearestDueStage) {
        alerted[key] = { status: "skipped", deadlineMs, processedAt: now };
        await chrome.alarms.clear(alarmName);
        delete alarmIndex[alarmName];
        continue;
      }
      const when = Math.max(now + 500, deadlineMs - stageSeconds * 1000);
      alarmIndex[alarmName] = {
        auctionKey: status.auctionKey,
        auctionLabel: status.auctionLabel || "Timed auction",
        targetLot: item.targetLot,
        deadlineMs,
        description: item.description || "",
        url: item.bidUrl || item.url || status.url || "",
        stageSeconds,
        scheduledAt: now
      };
      await chrome.alarms.create(alarmName, { when });
    }
  }
  await chrome.storage.local.set({
    [STORAGE_KEYS.timedAlarmIndex]: alarmIndex,
    [STORAGE_KEYS.timedAlerted]: alerted
  });
}

async function handleTimedAlarm(alarm) {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.timedAlarmIndex, STORAGE_KEYS.timedAlerted, STORAGE_KEYS.runtime
  ]);
  const alarmIndex = stored[STORAGE_KEYS.timedAlarmIndex] || {};
  const scheduled = alarmIndex[alarm.name];
  if (!scheduled) return { missing: true };
  const runtime = (stored[STORAGE_KEYS.runtime] || {})[scheduled.auctionKey];
  const current = runtime?.watched?.find((item) => item.targetLot === scheduled.targetLot);
  if (runtime?.monitoringComplete || terminalLotState(current?.state)) {
    delete alarmIndex[alarm.name];
    await chrome.storage.local.set({ [STORAGE_KEYS.timedAlarmIndex]: alarmIndex });
    return { ended: true };
  }
  const currentDeadline = Number(current?.deadlineMs);
  if (current?.visible && Number.isFinite(currentDeadline) && currentDeadline !== Number(scheduled.deadlineMs)) {
    delete alarmIndex[alarm.name];
    await chrome.storage.local.set({ [STORAGE_KEYS.timedAlarmIndex]: alarmIndex });
    await syncTimedSchedules(runtime);
    return { stale: true };
  }
  const now = Date.now();
  const deadlineMs = Number(scheduled.deadlineMs);
  const stageSeconds = Number(scheduled.stageSeconds);
  const targetWhen = deadlineMs - stageSeconds * 1000;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= now) {
    delete alarmIndex[alarm.name];
    await chrome.storage.local.set({ [STORAGE_KEYS.timedAlarmIndex]: alarmIndex });
    return { ended: true };
  }
  if (now + 1000 < targetWhen) {
    await chrome.alarms.create(alarm.name, { when: targetWhen });
    return { rescheduled: true };
  }
  const key = timedStageKey(scheduled.auctionKey, scheduled.targetLot, stageSeconds);
  const alerted = stored[STORAGE_KEYS.timedAlerted] || {};
  if (timedStageProcessed(alerted[key])) return { duplicate: true };
  alerted[key] = { status: "sent", deadlineMs, alertedAt: now };
  delete alarmIndex[alarm.name];
  await chrome.storage.local.set({ [STORAGE_KEYS.timedAlerted]: alerted, [STORAGE_KEYS.timedAlarmIndex]: alarmIndex });
  const detail = scheduled.description ? `\n${scheduled.description}` : "";
  const delivery = await notifyAndRecord({
    title: `Lot ${scheduled.targetLot} ends in about ${formatTimedStage(stageSeconds)}`,
    message: `${scheduled.auctionLabel}${detail}`,
    url: scheduled.url,
    notificationId: `easy-live-timed-${hashText(key)}-${deadlineMs}`
  }, {
    type: "alert", mode: "timed", auctionKey: scheduled.auctionKey,
    auctionLabel: scheduled.auctionLabel, lot: scheduled.targetLot, stage: stageSeconds
  });
  return { duplicate: false, delivery };
}

async function checkHealth() {
  const settings = await getSettings();
  if (settings.cloudEnabled) {
    await chrome.storage.local.set({ [STORAGE_KEYS.healthWarnings]: {} });
    return refreshReliabilityState();
  }
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.configs, STORAGE_KEYS.timedConfigs, STORAGE_KEYS.runtime, STORAGE_KEYS.healthWarnings
  ]);
  const configs = { ...(stored[STORAGE_KEYS.configs] || {}), ...(stored[STORAGE_KEYS.timedConfigs] || {}) };
  const runtime = stored[STORAGE_KEYS.runtime] || {};
  const warnings = stored[STORAGE_KEYS.healthWarnings] || {};
  const now = Date.now();
  for (const [auctionKey, config] of Object.entries(configs)) {
    if (!configHasLots(config)) { delete warnings[auctionKey]; continue; }
    const status = runtime[auctionKey];
    if (status?.monitoringComplete || allWatchedLotsTerminal(status)) {
      delete warnings[auctionKey];
      continue;
    }
    const tab = await getTab(status?.tabId);
    const stale = !status || now - Number(status.lastSeen || 0) > settings.disconnectWarningMinutes * 60 * 1000;
    let problem = "";
    if (!tab && stale) problem = "The monitored auction tab is closed or unavailable.";
    else if (tab?.discarded) problem = "Chrome discarded the monitored auction tab.";
    else if (tab?.frozen) problem = "Chrome froze the monitored auction tab.";
    else if (stale) problem = "The auction page has stopped reporting updates.";
    else if (status?.lookupState === "error" &&
      now - Number(status.lastDataChangeAt || status.lastSeen || 0) > settings.disconnectWarningMinutes * 60 * 1000) {
      problem = `Timed catalogue lookup failed${status.lookupError ? `: ${status.lookupError}` : "."}`;
    } else if (status?.ready === false &&
      now - Number(status.lastDataChangeAt || status.lastSeen || 0) > settings.disconnectWarningMinutes * 60 * 1000) {
      problem = "The auction data feed is not available.";
    }
    if (!problem) {
      const previous = warnings[auctionKey];
      if (!previous) continue;
      const healthySince = Number(previous.healthySince || now);
      if (now - healthySince >= HEALTH_RECOVERY_RESET_MS) {
        delete warnings[auctionKey];
        await recordDiagnostic({
          event: "monitoring-health-recovered",
          auctionKey,
          details: { healthyMinutes: Math.round((now - healthySince) / 60000) }
        });
      } else {
        warnings[auctionKey] = { ...previous, problem: "", healthySince };
      }
      continue;
    }
    const previous = warnings[auctionKey];
    const previousHealthySince = Number(previous?.healthySince || 0);
    const sameIncident = Boolean(previous) &&
      (!previousHealthySince || now - previousHealthySince < HEALTH_RECOVERY_RESET_MS);
    const previousCount = sameIncident
      ? Number(previous.notificationCount || (previous.lastNotified ? 1 : 0))
      : 0;
    const previousLastNotified = sameIncident ? Number(previous.lastNotified || 0) : 0;
    const reminderDue = previousCount === 1 && previousLastNotified > 0 &&
      now - previousLastNotified >= HEALTH_REMINDER_MS;
    const shouldNotify = previousCount === 0 || reminderDue;
    const nextWarning = {
      ...(sameIncident ? previous : {}),
      problem,
      firstSeen: sameIncident ? Number(previous.firstSeen || now) : now,
      healthySince: 0,
      notificationCount: previousCount
    };
    if (shouldNotify) {
      nextWarning.lastNotified = now;
      nextWarning.notificationCount = Math.min(HEALTH_MAX_NOTIFICATIONS, previousCount + 1);
    }
    warnings[auctionKey] = nextWarning;
    if (!sameIncident || previous?.problem !== problem) {
      await recordDiagnostic({
        event: sameIncident ? "monitoring-health-problem-changed" : "monitoring-health-warning",
        level: "warning",
        auctionKey,
        details: {
          problem,
          mode: config.mode || status?.mode || "",
          tabId: status?.tabId ?? null,
          pageUrl: config.url || status?.url || "",
          notificationCount: nextWarning.notificationCount
        }
      });
    }
    if (shouldNotify) {
      const reminder = nextWarning.notificationCount === HEALTH_MAX_NOTIFICATIONS;
      await notifyAndRecord({
        title: reminder ? "Auction monitoring still needs attention" : "Auction monitoring needs attention",
        message: reminder
          ? `${config.auctionLabel || "Watched auction"}\n${problem} Monitoring has been disconnected for at least 10 minutes.`
          : `${config.auctionLabel || "Watched auction"}\n${problem} Alerts may be delayed until it reconnects.`,
        url: config.url || "",
        notificationId: `easy-live-health-${hashText(auctionKey)}-${now}`
      }, { type: "warning", mode: config.mode || status?.mode || "system", auctionKey, auctionLabel: config.auctionLabel }, { forceDesktop: true });
    }
    const trackedWarning = warnings[auctionKey];
    if (settings.autoRecoveryEnabled && !trackedWarning.recoveryAttempted && tab && !tab.active &&
      now - trackedWarning.firstSeen > 60000 && chrome.tabs.reload) {
      try {
        await chrome.tabs.reload(tab.id);
        warnings[auctionKey] = { ...trackedWarning, recoveryAttempted: true, recoveryAttemptedAt: now };
        await recordDiagnostic({ event: "background-tab-reloaded", auctionKey, details: { tabId: tab.id, problem } });
        await recordHistory({
          type: "recovery", mode: config.mode || status?.mode || "system", auctionKey,
          auctionLabel: config.auctionLabel, title: "Background auction tab reloaded",
          message: problem, url: config.url || "", delivery: { desktopSent: false, pushoverSent: false, errors: [] }
        });
      } catch (_error) {}
    }
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.healthWarnings]: warnings });
  await refreshReliabilityState();
}

async function readinessSummary({ auctionKey } = {}) {
  if (!auctionKey) return { state: "idle", label: "No auction", detail: "Open a supported auction page" };
  const settings = await getSettings();
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.configs, STORAGE_KEYS.timedConfigs, STORAGE_KEYS.runtime, STORAGE_KEYS.healthWarnings, STORAGE_KEYS.cloudStatus
  ]);
  const config = (stored[STORAGE_KEYS.configs] || {})[auctionKey] ||
    (stored[STORAGE_KEYS.timedConfigs] || {})[auctionKey] || null;
  const status = (stored[STORAGE_KEYS.runtime] || {})[auctionKey] || null;
  if (settings.cloudEnabled) {
    const cloud = stored[STORAGE_KEYS.cloudStatus] || {};
    const cloudRuntime = cloud.runtime?.[auctionKey] || null;
    const cloudReadiness = cloud.readiness?.[auctionKey] || null;
    if (cloud.connected && Date.now() - Number(cloud.checkedAt || 0) < 3 * 60 * 1000) {
      if (cloudRuntime?.monitoringComplete) {
        return { state: "complete", label: "Cloud complete", detail: "Railway has finished monitoring this auction" };
      }
      if (cloudReadiness?.status === "warning") {
        return { state: "attention", label: "Feed attention", detail: "The scheduled live feed has not appeared yet" };
      }
      if (cloudRuntime?.error) return { state: "attention", label: "Cloud attention", detail: cloudRuntime.error };
      return { state: "ready", label: "Cloud ready", detail: "Railway continues monitoring when this Mac is closed" };
    }
    return { state: "attention", label: "Cloud connecting", detail: cloud.error || "Waiting for Railway synchronization" };
  }
  if (status?.monitoringComplete || allWatchedLotsTerminal(status)) {
    return {
      state: "complete",
      label: "Complete",
      detail: status.auctionEnded ? "Auction ended; monitoring stopped" : "All watched lots completed"
    };
  }
  const tab = await getTab(status?.tabId);
  const freshness = Date.now() - Number(status?.lastSeen || 0);
  if (!status || !tab || freshness >= 90000 || tab.discarded || tab.frozen) {
    return {
      state: "disconnected",
      label: "Disconnected",
      detail: !tab ? "The monitored auction tab is unavailable" : "The auction heartbeat is not current"
    };
  }
  if (status.lookupState === "error") {
    return { state: "attention", label: "Attention", detail: status.lookupError || "Catalogue lookup needs attention" };
  }
  if (!status.ready) {
    return { state: "attention", label: "Connecting", detail: "Waiting for the auction data feed" };
  }
  const expectedLots = config?.lots || [];
  if (!expectedLots.length) {
    return { state: "attention", label: "Add a lot", detail: "No watched lots have been added" };
  }
  const watched = status.watched || [];
  const foundCount = watched.filter((item) => item.visible !== false && item.state !== "waiting").length;
  if (foundCount < expectedLots.length) {
    return { state: "attention", label: "Locating", detail: `${foundCount} of ${expectedLots.length} watched lots found` };
  }
  const permission = chrome.notifications.getPermissionLevel
    ? await chrome.notifications.getPermissionLevel()
    : "granted";
  if (!settings.desktopEnabled || permission !== "granted") {
    return { state: "disconnected", label: "Alerts off", detail: `Desktop notifications: ${permission}` };
  }
  if (settings.pushoverEnabled && (!settings.pushoverUserKey || !settings.pushoverAppToken)) {
    return { state: "attention", label: "Pushover", detail: "Phone notification credentials need attention" };
  }
  if (!settings.reliabilityMode) {
    return { state: "attention", label: "Protection off", detail: "Sleep protection is disabled" };
  }
  const waitingToStart = status.livePhase === "scheduled" ||
    watched.every((item) => ["scheduled", "not-started"].includes(item.state));
  return {
    state: "ready",
    label: "Ready",
    detail: waitingToStart ? "Connected and waiting for the auction to start" : "Connection, watched lots and alerts are ready"
  };
}

async function readinessCheck({ auctionKey } = {}) {
  const settings = await getSettings();
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.configs, STORAGE_KEYS.timedConfigs, STORAGE_KEYS.runtime
  ]);
  const config = (stored[STORAGE_KEYS.configs] || {})[auctionKey] || (stored[STORAGE_KEYS.timedConfigs] || {})[auctionKey];
  const status = (stored[STORAGE_KEYS.runtime] || {})[auctionKey];
  if (status?.monitoringComplete || allWatchedLotsTerminal(status)) {
    return {
      checks: [{
        id: "ended",
        label: status.auctionEnded ? "Auction ended" : "Monitoring complete",
        ok: true,
        detail: "No further page scans or alerts are scheduled."
      }],
      delivery: { desktopSent: false, pushoverSent: false, errors: [] },
      ok: true,
      terminal: true
    };
  }
  const tab = await getTab(status?.tabId);
  const permission = chrome.notifications.getPermissionLevel
    ? await chrome.notifications.getPermissionLevel()
    : "granted";
  const freshness = Date.now() - Number(status?.lastSeen || 0);
  const watched = status?.watched || [];
  const expectedLots = config?.lots || [];
  const foundCount = watched.filter((item) => item.visible !== false && item.state !== "waiting").length;
  const scheduledLive = status?.mode === "live" && status?.livePhase === "scheduled";
  const checks = [
    { id: "connection", label: "Auction connected", ok: Boolean(tab && status && freshness < 90000), detail: tab ? `${Math.round(freshness / 1000)}s since heartbeat` : "Tab not available" },
    {
      id: "updates",
      label: scheduledLive ? "Live auction catalogue" : status?.mode === "live" ? "Current lot feed" : "Countdown feed",
      ok: Boolean(status?.ready),
      detail: status?.ready ? scheduledLive ? "Recognised — waiting to start" : "Detected" : "Not detected"
    },
    {
      id: "lots",
      label: expectedLots.length ? "Watched lots found" : "No watched lots added",
      ok: expectedLots.length > 0 && foundCount === expectedLots.length,
      detail: expectedLots.length ? `${foundCount} of ${expectedLots.length}` : "Add at least one lot before relying on alerts"
    },
    { id: "desktop", label: "Desktop notifications", ok: settings.desktopEnabled && permission === "granted", detail: permission },
    { id: "pushover", label: "Pushover", ok: !settings.pushoverEnabled || Boolean(settings.pushoverUserKey && settings.pushoverAppToken), detail: settings.pushoverEnabled ? "Test sent below" : "Not enabled" },
    { id: "reliability", label: "Sleep protection", ok: settings.reliabilityMode && Boolean(tab && !tab.discarded && !tab.frozen), detail: settings.reliabilityMode ? "Enabled while monitoring" : "Off" }
  ];
  const delivery = await notifyAndRecord({
    title: "Auction readiness test",
    message: `${config?.auctionLabel || status?.auctionLabel || "Watched auction"}\nDesktop and phone alert route checked.`,
    url: config?.url || status?.url || "",
    notificationId: `easy-live-readiness-${Date.now()}`
  }, { type: "test", mode: status?.mode || config?.mode || "system", auctionKey, auctionLabel: config?.auctionLabel }, { forceDesktop: true });
  const pushoverCheck = checks.find((check) => check.id === "pushover");
  if (settings.pushoverEnabled) {
    pushoverCheck.ok = delivery.pushoverSent && !delivery.errors.length;
    pushoverCheck.detail = pushoverCheck.ok ? "Test delivered" : delivery.errors.join(" ") || "Failed";
  }
  return { checks, delivery, ok: checks.every((check) => check.ok) };
}

function urgencyScore(mode, item) {
  if (terminalLotState(item.state)) return Number.MAX_SAFE_INTEGER;
  if (mode === "timed" && item.remainingMs !== null && item.remainingMs !== undefined && item.remainingMs !== "" &&
    Number.isFinite(Number(item.remainingMs))) return Math.max(0, Number(item.remainingMs));
  if (mode === "live" && item.remaining !== null && item.remaining !== undefined && item.remaining !== "" &&
    Number.isFinite(Number(item.remaining))) return Math.max(0, Number(item.remaining)) * 60000;
  return Number.MAX_SAFE_INTEGER - 1;
}

function configuredAuctionEntries(liveConfigs = {}, timedConfigs = {}) {
  return [
    ...Object.entries(liveConfigs).map(([auctionKey, config]) => ({ auctionKey, mode: "live", config })),
    ...Object.entries(timedConfigs).map(([auctionKey, config]) => ({ auctionKey, mode: "timed", config }))
  ].filter((entry) => configHasLots(entry.config));
}

function cloudReconciliation(entries, cloud, enabled) {
  const local = new Map(entries.map((entry) => [entry.auctionKey, {
    auctionKey: entry.auctionKey,
    mode: entry.mode,
    label: entry.config.auctionLabel || "Auction",
    lots: Array.from(new Set((entry.config.lots || []).map(normalizeLot))).sort()
  }]));
  const remote = new Map((cloud.activeAuctions || []).map((auction) => [auction.auctionKey, {
    auctionKey: auction.auctionKey,
    mode: auction.mode,
    label: auction.label || "Auction",
    lots: Array.from(new Set((auction.lots || []).map(normalizeLot))).sort()
  }]));
  const keys = Array.from(new Set([...local.keys(), ...remote.keys()]));
  const auctions = keys.map((auctionKey) => {
    const here = local.get(auctionKey);
    const there = remote.get(auctionKey);
    const localLots = new Set(here?.lots || []);
    const cloudLots = new Set(there?.lots || []);
    const missingInCloud = Array.from(localLots).filter((lot) => !cloudLots.has(lot));
    const cloudOnly = Array.from(cloudLots).filter((lot) => !localLots.has(lot));
    return {
      auctionKey,
      mode: here?.mode || there?.mode || "",
      label: here?.label || there?.label || "Auction",
      localCount: localLots.size,
      cloudCount: cloudLots.size,
      missingInCloud,
      cloudOnly,
      matched: Boolean(here && there && !missingInCloud.length && !cloudOnly.length)
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
  const totals = {
    local: entries.reduce((total, entry) => total + (entry.config.lots || []).length, 0),
    cloud: Array.from(remote.values()).reduce((total, entry) => total + entry.lots.length, 0)
  };
  return {
    enabled,
    connected: Boolean(cloud.connected),
    matched: Boolean(enabled && cloud.connected && auctions.every((auction) => auction.matched)),
    totals,
    auctions
  };
}

function backupSettings(settings) {
  const allowed = [
    "threshold", "timedThresholdMinutes", "defaultLiveStages", "defaultTimedStagesSeconds",
    "accountWatchImportEnabled", "desktopEnabled", "pushoverEnabled", "pushoverPriority",
    "reliabilityMode", "autoRecoveryEnabled", "disconnectWarningMinutes"
  ];
  return Object.fromEntries(allowed.filter((key) => settings[key] !== undefined).map((key) => [key, settings[key]]));
}

async function createBackup() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.settings, STORAGE_KEYS.configs, STORAGE_KEYS.timedConfigs, STORAGE_KEYS.origins
  ]);
  return {
    format: BACKUP_FORMAT,
    schemaVersion: 1,
    extensionVersion: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    notice: "Watch lists and non-secret preferences. Pushover keys and Railway credentials are excluded.",
    settings: backupSettings({ ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) }),
    liveAuctions: stored[STORAGE_KEYS.configs] || {},
    timedAuctions: stored[STORAGE_KEYS.timedConfigs] || {},
    enabledOrigins: stored[STORAGE_KEYS.origins] || []
  };
}

function safeBackupUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.href : "";
  } catch (_error) { return ""; }
}

function sanitizedBackupConfigs(input, mode, settings) {
  const result = {};
  for (const [auctionKey, raw] of Object.entries(input && typeof input === "object" ? input : {}).slice(0, 200)) {
    if (!auctionKey || auctionKey.length > 500 || ["__proto__", "prototype", "constructor"].includes(auctionKey)) continue;
    const lots = Array.from(new Set((Array.isArray(raw?.lots) ? raw.lots : []).map(normalizeLot).filter(Boolean))).slice(0, 500);
    const url = safeBackupUrl(raw?.url);
    if (!lots.length || !url) continue;
    const lotOptions = {};
    for (const lot of lots) {
      const old = raw?.lotOptions?.[lot] || {};
      lotOptions[lot] = mode === "timed"
        ? { stagesSeconds: normalizeTimedStages(old.stagesSeconds, settings.defaultTimedStagesSeconds), importedFromAccount: old.importedFromAccount === true }
        : { stages: normalizeLiveStages(old.stages, settings.defaultLiveStages), importedFromAccount: old.importedFromAccount === true };
    }
    result[auctionKey] = {
      mode,
      auctionId: String(raw?.auctionId || "").slice(0, 500),
      dayId: String(raw?.dayId || "").slice(0, 500),
      auctionLabel: String(raw?.auctionLabel || (mode === "live" ? "Live auction" : "Timed auction")).slice(0, 500),
      url,
      bidLiveUrl: safeBackupUrl(raw?.bidLiveUrl),
      lots,
      lotOptions,
      updatedAt: Date.now()
    };
  }
  return result;
}

async function importBackup(backup) {
  if (!backup || backup.format !== BACKUP_FORMAT || Number(backup.schemaVersion) !== 1) {
    throw new Error("This is not a valid Easy Live Lot Watcher backup.");
  }
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.settings, STORAGE_KEYS.configs, STORAGE_KEYS.timedConfigs, STORAGE_KEYS.origins
  ]);
  const currentSettings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) };
  const restoredSettings = { ...currentSettings, ...backupSettings(backup.settings || {}) };
  const incomingLive = sanitizedBackupConfigs(backup.liveAuctions, "live", restoredSettings);
  const incomingTimed = sanitizedBackupConfigs(backup.timedAuctions, "timed", restoredSettings);
  const merge = (current, incoming) => {
    const result = { ...(current || {}) };
    for (const [key, config] of Object.entries(incoming)) {
      const old = result[key] || { lots: [], lotOptions: {} };
      const lots = Array.from(new Set([...(old.lots || []), ...config.lots].map(normalizeLot)));
      result[key] = {
        ...config, ...old, lots,
        lotOptions: { ...(config.lotOptions || {}), ...(old.lotOptions || {}) },
        updatedAt: Date.now()
      };
    }
    return result;
  };
  const origins = Array.from(new Set([...(stored[STORAGE_KEYS.origins] || []), ...(backup.enabledOrigins || [])
    .filter((origin) => /^https:\/\/[^/]+$/i.test(String(origin)))]));
  const live = merge(stored[STORAGE_KEYS.configs], incomingLive);
  const timed = merge(stored[STORAGE_KEYS.timedConfigs], incomingTimed);
  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: restoredSettings,
    [STORAGE_KEYS.configs]: live,
    [STORAGE_KEYS.timedConfigs]: timed,
    [STORAGE_KEYS.origins]: origins
  });
  await restoreRegistrations();
  await recordDiagnostic({ event: "backup-restored", details: {
    liveAuctions: Object.keys(incomingLive).length,
    timedAuctions: Object.keys(incomingTimed).length
  } });
  if (restoredSettings.cloudEnabled) scheduleCloudSync();
  return {
    liveAuctions: Object.keys(incomingLive).length,
    timedAuctions: Object.keys(incomingTimed).length,
    watchedLots: [...Object.values(incomingLive), ...Object.values(incomingTimed)]
      .reduce((total, config) => total + config.lots.length, 0)
  };
}

async function getDashboard() {
  const settings = await getSettings();
  if (settings.cloudEnabled) await refreshCloudStatus();
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.configs, STORAGE_KEYS.timedConfigs, STORAGE_KEYS.runtime, STORAGE_KEYS.history,
    STORAGE_KEYS.healthWarnings, STORAGE_KEYS.cloudStatus
  ]);
  const runtime = stored[STORAGE_KEYS.runtime] || {};
  const warnings = stored[STORAGE_KEYS.healthWarnings] || {};
  const cloud = stored[STORAGE_KEYS.cloudStatus] || {};
  const source = configuredAuctionEntries(stored[STORAGE_KEYS.configs] || {}, stored[STORAGE_KEYS.timedConfigs] || {});
  const auctions = [];
  for (const entry of source) {
    let status = runtime[entry.auctionKey] || null;
    const cloudRuntime = cloud.runtime?.[entry.auctionKey] || null;
    const cloudReadiness = cloud.readiness?.[entry.auctionKey] || null;
    const cloudFresh = Boolean(settings.cloudEnabled && cloud.connected && cloudRuntime &&
      Date.now() - Number(cloudRuntime.lastSuccessAt || cloudRuntime.lastCheckedAt || 0) < 3 * 60 * 1000);
    if (entry.mode === "live" && cloudFresh && cloudRuntime.currentLot && !status?.currentLot) {
      status = mergeCloudLiveRuntime(entry.auctionKey, entry.config, status || {}, cloudRuntime);
    }
    const tab = await getTab(status?.tabId);
    const freshness = status ? Date.now() - Number(status.lastSeen || 0) : Infinity;
    const monitoringComplete = Boolean(status?.monitoringComplete || allWatchedLotsTerminal(status));
    auctions.push({
      auctionKey: entry.auctionKey,
      mode: entry.mode,
      auctionLabel: entry.config.auctionLabel || status?.auctionLabel || "Auction",
      url: status?.url || entry.config.url || "",
      tabId: status?.tabId || null,
      connected: cloudFresh || Boolean(tab && freshness < settings.disconnectWarningMinutes * 60 * 1000 && !tab.discarded && !tab.frozen),
      cloudManaged: Boolean(status?.cloudManaged || cloudFresh),
      auctionEnded: Boolean(status?.auctionEnded),
      monitoringComplete,
      terminalReason: status?.terminalReason || "",
      healthProblem: monitoringComplete ? "" : cloudReadiness?.status === "warning"
        ? "Scheduled live feed has not appeared yet"
        : warnings[entry.auctionKey]?.problem || "",
      lastSeen: cloudFresh ? Number(cloudRuntime.lastSuccessAt || cloudRuntime.lastCheckedAt || status?.lastSeen || 0) : status?.lastSeen || null,
      currentLot: status?.currentLot || "",
      watched: (status?.watched || (entry.config.lots || []).map((targetLot) => ({ targetLot, state: "waiting", statusText: "Waiting for auction tab" })))
        .map((item) => ({ ...item, urgency: urgencyScore(entry.mode, item) }))
        .sort((a, b) => a.urgency - b.urgency)
    });
  }
  auctions.sort((a, b) => (a.watched[0]?.urgency ?? Infinity) - (b.watched[0]?.urgency ?? Infinity));
  return {
    auctions,
    history: (stored[STORAGE_KEYS.history] || []).slice(0, 30),
    reliability: await refreshReliabilityState(),
    cloud: {
      enabled: settings.cloudEnabled,
      connected: Boolean(cloud.connected),
      checkedAt: cloud.checkedAt || null,
      lastSyncAt: cloud.lastSyncAt || null,
      error: cloud.error || "",
      serviceVersion: cloud.serviceVersion || ""
    },
    reconciliation: cloudReconciliation(source, cloud, settings.cloudEnabled),
    cloudAlertLog: (cloud.alertLog || []).slice(0, 30)
  };
}

async function buildIssueReport({ auctionKey = "" } = {}) {
  const stored = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  const settings = await getSettings();
  const manifest = chrome.runtime.getManifest?.() || {};
  const notificationPermission = chrome.notifications.getPermissionLevel
    ? await chrome.notifications.getPermissionLevel().catch(() => "unknown")
    : "unknown";
  const grantedPermissions = chrome.permissions.getAll
    ? await chrome.permissions.getAll().catch(() => ({ permissions: [], origins: [] }))
    : { permissions: [], origins: stored[STORAGE_KEYS.origins] || [] };
  const alarms = chrome.alarms.getAll ? await chrome.alarms.getAll().catch(() => []) : [];
  const registeredScripts = chrome.scripting.getRegisteredContentScripts
    ? await chrome.scripting.getRegisteredContentScripts().catch(() => [])
    : [];
  const timeZone = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "";
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";

  const report = sanitizeDiagnostic({
    reportFormat: "easy-live-lot-watcher-issue-report",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    notice: "Sanitized local diagnostics. Auction lot numbers and page paths are included; passwords, cookies and Pushover credentials are excluded.",
    focusAuctionKey: auctionKey,
    extension: {
      name: manifest.name || "Easy Live Lot Watcher",
      version: manifest.version || "unknown",
      manifestVersion: manifest.manifest_version || null
    },
    environment: { userAgent, language: typeof navigator !== "undefined" ? navigator.language : "", timeZone },
    settings: {
      threshold: settings.threshold,
      timedThresholdMinutes: settings.timedThresholdMinutes,
      defaultLiveStages: settings.defaultLiveStages,
      defaultTimedStagesSeconds: settings.defaultTimedStagesSeconds,
      accountWatchImportEnabled: settings.accountWatchImportEnabled,
      desktopEnabled: settings.desktopEnabled,
      pushoverEnabled: settings.pushoverEnabled,
      pushoverConfigured: Boolean(settings.pushoverUserKey && settings.pushoverAppToken),
      pushoverPriority: settings.pushoverPriority,
      reliabilityMode: settings.reliabilityMode,
      autoRecoveryEnabled: settings.autoRecoveryEnabled,
      disconnectWarningMinutes: settings.disconnectWarningMinutes
    },
    permissions: {
      notificationPermission,
      extensionPermissions: grantedPermissions.permissions || [],
      origins: grantedPermissions.origins || stored[STORAGE_KEYS.origins] || []
    },
    storageSummary: {
      liveAuctionCount: Object.keys(stored[STORAGE_KEYS.configs] || {}).length,
      timedAuctionCount: Object.keys(stored[STORAGE_KEYS.timedConfigs] || {}).length,
      runtimeAuctionCount: Object.keys(stored[STORAGE_KEYS.runtime] || {}).length,
      historyCount: (stored[STORAGE_KEYS.history] || []).length,
      diagnosticEventCount: (stored[STORAGE_KEYS.diagnostics] || []).length
    },
    liveAuctionConfigs: stored[STORAGE_KEYS.configs] || {},
    timedAuctionConfigs: stored[STORAGE_KEYS.timedConfigs] || {},
    runtime: stored[STORAGE_KEYS.runtime] || {},
    liveAlertedStages: stored[STORAGE_KEYS.alerted] || {},
    legacyLiveAlerted: stored[STORAGE_KEYS.legacyAlerted] || {},
    timedAlertedStages: stored[STORAGE_KEYS.timedAlerted] || {},
    timedAlarmIndex: stored[STORAGE_KEYS.timedAlarmIndex] || {},
    scheduledAlarms: alarms,
    healthWarnings: stored[STORAGE_KEYS.healthWarnings] || {},
    cloudStatus: (() => {
      const cloud = stored[STORAGE_KEYS.cloudStatus] || {};
      return {
        connected: Boolean(cloud.connected),
        checkedAt: cloud.checkedAt || null,
        lastSyncAt: cloud.lastSyncAt || null,
        auctionCount: cloud.auctionCount ?? null,
        watchedLotCount: cloud.watchedLotCount ?? null,
        serviceVersion: cloud.serviceVersion || "",
        error: cloud.error || "",
        runtime: cloud.runtime || {},
        readiness: cloud.readiness || {},
        activeAuctions: cloud.activeAuctions || [],
        alertLog: cloud.alertLog || []
      };
    })(),
    recentHistory: (stored[STORAGE_KEYS.history] || []).slice(0, 80),
    diagnosticLog: stored[STORAGE_KEYS.diagnostics] || [],
    registeredContentScripts: registeredScripts.map((script) => ({ id: script.id, matches: script.matches || [] }))
  });
  const secretValues = [settings.pushoverUserKey, settings.pushoverAppToken]
    .map((value) => String(value || "")).filter((value) => value.length >= 4);
  return redactDiagnosticSecrets(report, secretValues);
}

async function restoreTimedSchedules() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.runtime);
  for (const status of Object.values(stored[STORAGE_KEYS.runtime] || {})) if (status?.mode === "timed") await syncTimedSchedules(status);
}

async function migrateLegacyState() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.legacyTimedAlerted, STORAGE_KEYS.timedAlerted]);
  const legacy = stored[STORAGE_KEYS.legacyTimedAlerted] || {};
  const current = stored[STORAGE_KEYS.timedAlerted] || {};
  const settings = await getSettings();
  const legacyStage = Math.max(60, Number(settings.timedThresholdMinutes || 3) * 60);
  let changed = false;
  for (const [lotKey, deadlineMs] of Object.entries(legacy)) {
    const stageKey = `${lotKey}::${legacyStage}`;
    if (current[stageKey] === undefined) {
      current[stageKey] = deadlineMs;
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ [STORAGE_KEYS.timedAlerted]: current });
}

async function restoreMonitoring() {
  await pruneCompletedWatches();
  await restoreRegistrations();
  await restoreTimedSchedules();
  await chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: 1 });
  await chrome.alarms.create(CLOUD_SYNC_ALARM, { periodInMinutes: 1 });
  await checkHealth();
  await syncCloud().catch(() => null);
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const previous = stored[STORAGE_KEYS.settings] || {};
  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: {
      ...DEFAULT_SETTINGS,
      ...previous,
      defaultLiveStages: previous.defaultLiveStages || [previous.threshold || 5],
      defaultTimedStagesSeconds: previous.defaultTimedStagesSeconds || [(previous.timedThresholdMinutes || 3) * 60]
    }
  });
  await migrateLegacyState();
  await restoreMonitoring();
});

chrome.runtime.onStartup.addListener(restoreMonitoring);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEALTH_ALARM) {
    serializeMutation(checkHealth).catch((error) => {
      console.error("Health check failed", error);
      recordDiagnostic({ event: "health-check-error", level: "error", details: { message: error?.message || String(error) } });
    });
  } else if (alarm.name === CLOUD_SYNC_ALARM) {
    serializeMutation(() => syncCloud()).catch(() => null);
  } else if (alarm.name.startsWith("easy-live-timed-")) {
    serializeMutation(() => handleTimedAlarm(alarm)).catch((error) => {
      console.error("Timed lot alert failed", error);
      recordDiagnostic({ event: "timed-alert-error", level: "error", details: { alarmName: alarm.name, message: error?.message || String(error) } });
    });
  }
});

chrome.tabs.onRemoved?.addListener(() => {
  serializeMutation(checkHealth).catch(() => null);
});

chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
  if (protectedTabIds.has(tabId) && (changeInfo.discarded || changeInfo.frozen)) {
    serializeMutation(checkHealth).catch(() => null);
  }
});

chrome.storage.onChanged?.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[STORAGE_KEYS.configs] || changes[STORAGE_KEYS.timedConfigs] || changes[STORAGE_KEYS.settings]) scheduleCloudSync();
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.links);
  const target = (stored[STORAGE_KEYS.links] || {})[notificationId];
  if (!target?.url) return;
  await focusOrOpenUrl(target.url);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "REGISTER_ORIGIN":
        await serializeMutation(() => registerOrigin(message.origin));
        return { ok: true };
      case "PAGE_STATUS":
      case "PAGE_HEARTBEAT":
        await serializeMutation(async () => {
          await migrateMisclassifiedLiveConfig(message.payload);
          await migrateMisclassifiedTimedConfig(message.payload);
          await updateRuntime(message.payload, sender, message.type);
          if (message.payload?.mode === "timed") await syncTimedSchedules(message.payload);
        });
        return { ok: true };
      case "DIAGNOSTIC_EVENT":
        await serializeMutation(() => recordDiagnostic({
          ...message.payload,
          auctionKey: message.payload?.auctionKey || "",
          details: { ...(message.payload?.details || {}), tabId: sender.tab?.id ?? null, pageUrl: sender.tab?.url || "" }
        }));
        return { ok: true };
      case "THRESHOLD_REACHED":
        return { ok: true, result: await serializeMutation(() => handleThresholdReached(message.payload)) };
      case "ADD_LOTS":
        return { ok: true, config: await serializeMutation(() => saveLots(message.payload)) };
      case "ADD_TIMED_LOTS":
        return { ok: true, config: await serializeMutation(() => saveTimedLots(message.payload)) };
      case "IMPORT_ACCOUNT_WATCHES":
        return { ok: true, result: await serializeMutation(() => importAccountWatches(message.payload)) };
      case "REMOVE_LOT":
        return { ok: true, config: await serializeMutation(() => removeLot({ ...message.payload, mode: "live" })) };
      case "REMOVE_TIMED_LOT":
        return { ok: true, config: await serializeMutation(() => removeLot({ ...message.payload, mode: "timed" })) };
      case "UPDATE_LOT_ALERTS":
        return { ok: true, config: await serializeMutation(() => updateLotAlerts(message.payload)) };
      case "GET_DASHBOARD":
        return { ok: true, dashboard: await serializeMutation(getDashboard) };
      case "REFRESH_RELIABILITY":
        return { ok: true, reliability: await serializeMutation(refreshReliabilityState) };
      case "SYNC_CLOUD":
        return { ok: true, status: await serializeMutation(() => syncCloud()) };
      case "TEST_CLOUD":
        return { ok: true, status: await serializeMutation(() => syncCloud({ test: true })) };
      case "GET_CLOUD_STATUS":
        return { ok: true, status: await serializeMutation(() => refreshCloudStatus()) };
      case "GET_EFFECTIVE_LIVE_STATUS":
        return { ok: true, status: await serializeMutation(() => effectiveLiveStatus(message.payload?.status)) };
      case "RUN_READINESS_CHECK":
        return { ok: true, result: await serializeMutation(() => readinessCheck(message.payload)) };
      case "GET_READINESS_SUMMARY":
        return { ok: true, summary: await readinessSummary(message.payload) };
      case "CREATE_ISSUE_REPORT":
        return { ok: true, report: await serializeMutation(() => buildIssueReport(message.payload)) };
      case "CREATE_BACKUP":
        return { ok: true, backup: await serializeMutation(createBackup) };
      case "IMPORT_BACKUP":
        return { ok: true, result: await serializeMutation(() => importBackup(message.backup)) };
      case "OPEN_AUCTION": {
        await focusOrOpenUrl(message.url, message.tabId);
        return { ok: true };
      }
      case "TEST_ALERTS": {
        const delivery = await notifyAndRecord({
          title: "Easy Live Watcher test",
          message: "Your auction alerts are configured correctly.",
          notificationId: `easy-live-test-${Date.now()}`
        }, { type: "test", mode: "system" }, { forceDesktop: true, forceLocalPushover: true });
        return { ok: delivery.errors.length === 0, delivery };
      }
      default:
        return { ok: false, error: "Unknown message type" };
    }
  })().then(sendResponse).catch(async (error) => {
    console.error(error);
    await recordDiagnostic({
      event: "background-message-error",
      level: "error",
      details: { messageType: message?.type || "unknown", message: error?.message || String(error), tabId: sender.tab?.id ?? null }
    });
    sendResponse({ ok: false, error: error.message || String(error) });
  });
  return true;
});
