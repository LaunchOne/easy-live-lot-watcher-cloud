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

const fields = Object.fromEntries([
  "liveStage10", "liveStage5", "liveStage0", "timedStage600", "timedStage180", "timedStage30",
  "desktopEnabled", "pushoverEnabled", "pushoverUserKey", "pushoverAppToken", "pushoverPriority",
  "accountWatchImportEnabled", "reliabilityMode", "autoRecoveryEnabled", "disconnectWarningMinutes", "saveSettings", "testAlerts",
  "toggleSecrets", "statusMessage", "cloudEnabled", "cloudServiceUrl", "cloudApiKey", "cloudStatus", "testCloud",
  "toggleCloudSecret", "monitoringLimitTitle", "monitoringLimitText"
].map((id) => [id, document.querySelector(`#${id}`)]));

function normalizeCloudUrl(value) {
  const url = new URL(String(value || "").trim());
  if (url.protocol !== "https:") throw new Error("The Railway service URL must use HTTPS.");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

function selectedStages(mapping) {
  return Object.entries(mapping).filter(([, field]) => field.checked).map(([value]) => Number(value));
}

function readForm() {
  const defaultLiveStages = selectedStages({ 10: fields.liveStage10, 5: fields.liveStage5, 0: fields.liveStage0 });
  const defaultTimedStagesSeconds = selectedStages({ 600: fields.timedStage600, 180: fields.timedStage180, 30: fields.timedStage30 });
  if (!defaultLiveStages.length) throw new Error("Choose at least one default live alert.");
  if (!defaultTimedStagesSeconds.length) throw new Error("Choose at least one default timed alert.");
  const disconnectWarningMinutes = Math.max(1, Math.min(15, Number.parseInt(fields.disconnectWarningMinutes.value, 10) || 2));
  return {
    threshold: defaultLiveStages.includes(5) ? 5 : defaultLiveStages.find((stage) => stage > 0) || 5,
    timedThresholdMinutes: defaultTimedStagesSeconds.includes(180)
      ? 3 : Math.max(1, Math.round((defaultTimedStagesSeconds.find((stage) => stage >= 60) || 180) / 60)),
    defaultLiveStages,
    defaultTimedStagesSeconds,
    accountWatchImportEnabled: fields.accountWatchImportEnabled.checked,
    desktopEnabled: fields.desktopEnabled.checked,
    pushoverEnabled: fields.pushoverEnabled.checked,
    pushoverUserKey: fields.pushoverUserKey.value.trim(),
    pushoverAppToken: fields.pushoverAppToken.value.trim(),
    pushoverPriority: Number.parseInt(fields.pushoverPriority.value, 10) || 0,
    reliabilityMode: fields.reliabilityMode.checked,
    autoRecoveryEnabled: fields.autoRecoveryEnabled.checked,
    disconnectWarningMinutes,
    cloudEnabled: fields.cloudEnabled.checked,
    cloudServiceUrl: fields.cloudServiceUrl.value.trim(),
    cloudApiKey: fields.cloudApiKey.value.trim()
  };
}

function writeForm(settings) {
  const live = Array.isArray(settings.defaultLiveStages) ? settings.defaultLiveStages : [settings.threshold || 5];
  const timed = Array.isArray(settings.defaultTimedStagesSeconds)
    ? settings.defaultTimedStagesSeconds : [(settings.timedThresholdMinutes || 3) * 60];
  fields.liveStage10.checked = live.includes(10);
  fields.liveStage5.checked = live.includes(5) || !live.some((stage) => [10, 5, 0].includes(stage));
  fields.liveStage0.checked = live.includes(0);
  fields.timedStage600.checked = timed.includes(600);
  fields.timedStage180.checked = timed.includes(180) || !timed.some((stage) => [600, 180, 30].includes(stage));
  fields.timedStage30.checked = timed.includes(30);
  fields.accountWatchImportEnabled.checked = settings.accountWatchImportEnabled !== false;
  fields.desktopEnabled.checked = settings.desktopEnabled;
  fields.pushoverEnabled.checked = settings.pushoverEnabled;
  fields.pushoverUserKey.value = settings.pushoverUserKey;
  fields.pushoverAppToken.value = settings.pushoverAppToken;
  fields.pushoverPriority.value = String(settings.pushoverPriority);
  fields.reliabilityMode.checked = settings.reliabilityMode;
  fields.autoRecoveryEnabled.checked = settings.autoRecoveryEnabled;
  fields.disconnectWarningMinutes.value = settings.disconnectWarningMinutes;
  fields.cloudEnabled.checked = settings.cloudEnabled === true;
  fields.cloudServiceUrl.value = settings.cloudServiceUrl || "";
  fields.cloudApiKey.value = settings.cloudApiKey || "";
  updateLimitCopy(settings.cloudEnabled === true);
}

function updateLimitCopy(cloudEnabled) {
  fields.monitoringLimitTitle.textContent = cloudEnabled ? "Cloud monitoring enabled" : "Local monitoring limit";
  fields.monitoringLimitText.textContent = cloudEnabled
    ? "Railway continues Pushover monitoring when Chrome or this Mac is closed. Open Chrome only to add, edit or remove watched lots."
    : "Keep one auction tab open with Chrome and the Mac running. Enable Railway above to continue Pushover monitoring when the Mac is closed.";
}

function setCloudStatus(message, tone = "") {
  fields.cloudStatus.textContent = message;
  fields.cloudStatus.className = `cloud-status ${tone}`.trim();
}

function setStatus(message, isError = false) {
  fields.statusMessage.textContent = message;
  fields.statusMessage.style.color = isError ? "#a5261c" : "#0d5725";
}

async function save() {
  const next = readForm();
  if (next.pushoverEnabled && (!next.pushoverUserKey || !next.pushoverAppToken)) {
    throw new Error("Enter both Pushover keys or turn Pushover off.");
  }
  if (next.cloudEnabled) {
    if (!next.cloudServiceUrl || !next.cloudApiKey) throw new Error("Enter the Railway service URL and Cloud API key.");
    next.cloudServiceUrl = normalizeCloudUrl(next.cloudServiceUrl);
    if (next.cloudApiKey.length < 24) throw new Error("The Cloud API key must be at least 24 characters.");
    const origin = `${new URL(next.cloudServiceUrl).origin}/*`;
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) throw new Error("Chrome needs permission to connect to the Railway service.");
  }
  fields.disconnectWarningMinutes.value = next.disconnectWarningMinutes;
  const stored = await chrome.storage.local.get("settings");
  const settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}), ...next };
  await chrome.storage.local.set({ settings });
  await chrome.runtime.sendMessage({ type: "REFRESH_RELIABILITY" }).catch(() => null);
  updateLimitCopy(settings.cloudEnabled);
  return settings;
}

fields.saveSettings.addEventListener("click", async () => {
  fields.saveSettings.disabled = true;
  try {
    await save();
    setStatus("Settings saved. New lots will use the selected default stages.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    fields.saveSettings.disabled = false;
  }
});

fields.testAlerts.addEventListener("click", async () => {
  fields.testAlerts.disabled = true;
  try {
    const settings = await save();
    setStatus("Sending test…");
    const response = await chrome.runtime.sendMessage({ type: "TEST_ALERTS" });
    if (!response?.ok) throw new Error(response?.delivery?.errors?.join(" ") || response?.error || "Test failed.");
    setStatus(settings.pushoverEnabled
      ? "Desktop and Pushover test alerts sent and added to history."
      : "Desktop test sent and added to history. Pushover is off.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    fields.testAlerts.disabled = false;
  }
});

fields.testCloud.addEventListener("click", async () => {
  fields.testCloud.disabled = true;
  setCloudStatus("Connecting…");
  try {
    const settings = await save();
    if (!settings.cloudEnabled) throw new Error("Turn on cloud monitoring first.");
    const response = await chrome.runtime.sendMessage({ type: "TEST_CLOUD" });
    if (!response?.ok) throw new Error(response?.error || "Railway cloud test failed.");
    const count = response.status?.watchedLotCount;
    setCloudStatus(`Connected — test sent${Number.isFinite(count) ? ` · ${count} active lots` : ""}`, "connected");
    setStatus("Railway received your active watch list and sent a Pushover test alert.");
  } catch (error) {
    setCloudStatus(error.message || "Connection failed", "error");
    setStatus(error.message, true);
  } finally {
    fields.testCloud.disabled = false;
  }
});

fields.toggleSecrets.addEventListener("click", () => {
  const showing = fields.pushoverUserKey.type === "text";
  fields.pushoverUserKey.type = showing ? "password" : "text";
  fields.pushoverAppToken.type = showing ? "password" : "text";
  fields.toggleSecrets.textContent = showing ? "Show keys" : "Hide keys";
});

fields.toggleCloudSecret.addEventListener("click", () => {
  const showing = fields.cloudApiKey.type === "text";
  fields.cloudApiKey.type = showing ? "password" : "text";
  fields.toggleCloudSecret.textContent = showing ? "Show key" : "Hide key";
});

fields.cloudEnabled.addEventListener("change", () => updateLimitCopy(fields.cloudEnabled.checked));

(async () => {
  const stored = await chrome.storage.local.get("settings");
  const settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  writeForm(settings);
  if (settings.cloudEnabled) {
    const response = await chrome.runtime.sendMessage({ type: "GET_CLOUD_STATUS" }).catch(() => null);
    if (response?.status?.connected) {
      const count = response.status.watchedLotCount;
      setCloudStatus(`Connected${Number.isFinite(count) ? ` · ${count} active lots` : ""}`, "connected");
    }
    else setCloudStatus(response?.status?.error || "Not connected", response?.status?.error ? "error" : "");
  }
})().catch((error) => setStatus(error.message, true));
