"use strict";

const Core = globalThis.EasyLiveWatchCore;
const elements = Object.fromEntries([
  "loadingView", "unsupportedView", "enableView", "auctionView", "enableHost", "enableSite",
  "openSettings", "showAllWatches", "auctionLabel", "currentLot", "summaryEyebrow",
  "summaryMetricLabel", "connectionBadge", "thresholdBadge", "lotInputLabel", "fieldHelp",
  "lotInput", "addLots", "formMessage", "watchList", "emptyState", "watchEyebrow",
  "watchHeading", "footerText", "healthText", "healthDetail", "readinessDisclosure",
  "readinessTest", "readinessResults", "currentView", "dashboardView", "currentTabButton",
  "dashboardTabButton", "dashboardList", "historyDisclosure", "historyList", "historyEmpty",
  "historySummary", "reliabilityBadge", "dashboardHeading", "nextUpPanel", "nextUpLot",
  "nextUpAuction", "nextUpStatus", "nextUpOpen", "readinessIndicator", "readinessLabel",
  "issueReportDisclosure", "createIssueReport", "copyIssueReport", "issueReportMessage"
].map((id) => [id, document.querySelector(`#${id}`)]));

let activeTab = null;
let identity = null;
let pageStatus = null;
let refreshTimer = null;
let dashboardTimer = null;
let readinessRequestAt = 0;
let latestIssueReportText = "";

function setIssueReportMessage(message, isSuccess = false) {
  elements.issueReportMessage.textContent = message || "";
  elements.issueReportMessage.classList.toggle("success", Boolean(message && isSuccess));
}

function downloadIssueReport(text, generatedAt) {
  const blobUrl = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  const stamp = String(generatedAt || new Date().toISOString()).replace(/[:.]/g, "-");
  link.href = blobUrl;
  link.download = `easy-live-lot-watcher-issue-${stamp}.json`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

async function createIssueReport() {
  elements.createIssueReport.disabled = true;
  elements.createIssueReport.textContent = "Creating report…";
  setIssueReportMessage("");
  try {
    const response = await chrome.runtime.sendMessage({
      type: "CREATE_ISSUE_REPORT",
      payload: { auctionKey: pageStatus?.auctionKey || "" }
    });
    if (!response?.ok || !response.report) throw new Error(response?.error || "The report could not be created.");
    latestIssueReportText = JSON.stringify(response.report, null, 2);
    downloadIssueReport(latestIssueReportText, response.report.generatedAt);
    elements.copyIssueReport.disabled = false;
    setIssueReportMessage("Report downloaded. Attach the JSON file here when describing the problem.", true);
  } catch (error) {
    setIssueReportMessage(error?.message || "The report could not be created.");
  } finally {
    elements.createIssueReport.disabled = false;
    elements.createIssueReport.textContent = "Download issue report";
  }
}

async function copyIssueReport() {
  if (!latestIssueReportText) return;
  try {
    await navigator.clipboard.writeText(latestIssueReportText);
    setIssueReportMessage("Report copied to the clipboard.", true);
  } catch (_error) {
    setIssueReportMessage("Chrome could not copy the report. Use the downloaded JSON file instead.");
  }
}

function setReadinessIndicator(summary) {
  const state = ["ready", "attention", "disconnected", "complete", "idle"].includes(summary?.state)
    ? summary.state : "idle";
  const label = summary?.label || "Checking";
  const detail = summary?.detail || "Checking auction readiness";
  elements.readinessIndicator.className = `readiness-indicator ${state}`;
  elements.readinessLabel.textContent = label;
  elements.readinessIndicator.title = detail;
  elements.readinessIndicator.setAttribute("aria-label", `Readiness status: ${label}. ${detail}`);
}

function provisionalReadiness(status) {
  if (!status) return { state: "idle", label: "Checking", detail: "Checking auction readiness" };
  const watched = status.watched || [];
  if (status.monitoringComplete || (watched.length && watched.every((item) => ["ended", "passed", "unavailable"].includes(item.state)))) {
    return { state: "complete", label: "Complete", detail: "Monitoring has completed" };
  }
  if (status.lookupState === "error") return { state: "attention", label: "Attention", detail: status.lookupError || "Catalogue lookup needs attention" };
  if (!status.ready) return { state: "attention", label: "Connecting", detail: "Waiting for the auction feed" };
  if (!watched.length) return { state: "attention", label: "Add a lot", detail: "No watched lots have been added" };
  const located = watched.filter((item) => item.visible !== false && item.state !== "waiting").length;
  if (located < watched.length) return { state: "attention", label: "Locating", detail: `${located} of ${watched.length} watched lots found` };
  const waiting = status.livePhase === "scheduled" || watched.every((item) => ["scheduled", "not-started"].includes(item.state));
  return { state: "ready", label: "Ready", detail: waiting ? "Connected and waiting for the auction to start" : "Auction monitoring is ready" };
}

async function refreshReadinessSummary(force = false) {
  if (!pageStatus?.auctionKey) return;
  if (!force && Date.now() - readinessRequestAt < 5000) return;
  readinessRequestAt = Date.now();
  const response = await chrome.runtime.sendMessage({
    type: "GET_READINESS_SUMMARY",
    payload: { auctionKey: pageStatus.auctionKey }
  }).catch(() => null);
  if (response?.ok && response.summary) setReadinessIndicator(response.summary);
}

function showCurrentPanel(view) {
  for (const element of [elements.loadingView, elements.unsupportedView, elements.enableView, elements.auctionView]) {
    element.classList.toggle("hidden", element !== view);
  }
}

function switchView(name) {
  const dashboard = name === "dashboard";
  elements.currentView.classList.toggle("hidden", dashboard);
  elements.dashboardView.classList.toggle("hidden", !dashboard);
  elements.currentTabButton.classList.toggle("active", !dashboard);
  elements.dashboardTabButton.classList.toggle("active", dashboard);
  elements.currentTabButton.setAttribute("aria-pressed", String(!dashboard));
  elements.dashboardTabButton.setAttribute("aria-pressed", String(dashboard));
  if (dashboard) refreshDashboard();
}

function setFormMessage(message, isSuccess = false) {
  elements.formMessage.textContent = message || "";
  elements.formMessage.classList.toggle("success", Boolean(message && isSuccess));
}

function setBadge(element, label, tone = "neutral") {
  element.textContent = label;
  element.className = `status-badge ${tone}`;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function sendToTab(message) {
  if (!activeTab?.id) return null;
  try { return await chrome.tabs.sendMessage(activeTab.id, message); }
  catch (_error) { return null; }
}

async function openDestination(tabId, url) {
  return chrome.runtime.sendMessage({ type: "OPEN_AUCTION", tabId: tabId || null, url: url || "" });
}

async function ensureContentScript() {
  await chrome.runtime.sendMessage({ type: "REGISTER_ORIGIN", origin: identity.origin });
  let response = await sendToTab({ type: "GET_PAGE_STATUS" });
  if (!response?.ok) {
    if (identity.mode === "timed") {
      await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: ["page-bridge.js"], world: "MAIN" });
    }
    await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: ["core.js", "content.js"] });
  } else if (identity.mode === "timed" && !response.status?.ready) {
    await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: ["page-bridge.js"], world: "MAIN" });
  }
  const attempts = identity.mode === "timed" ? 16 : 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    response = await sendToTab({ type: "GET_PAGE_STATUS" });
    if (response?.ok && (identity.mode !== "timed" || response.status?.ready)) break;
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  return response;
}

function stageLabel(mode, value) {
  if (mode === "live") return value === 0 ? "Live now" : `${value} lot${value === 1 ? "" : "s"}`;
  return value < 60 ? `${value}s` : `${value / 60}m`;
}

function stageSummary(item, mode) {
  const stages = mode === "timed" ? item.stagesSeconds || [180] : item.stages || [5];
  return stages.map((stage) => stageLabel(mode, stage)).join(" · ");
}

function displayTone(item, mode) {
  if (["ended", "passed", "unavailable"].includes(item.state)) return "muted";
  if (["waiting", "scheduled", "not-started"].includes(item.state)) return "neutral";
  if (mode === "live") {
    if (item.state === "live") return "critical";
    if (Number(item.remaining) <= 5) return "warning";
    return "success";
  }
  if (Number(item.remainingMs) <= 60000) return "critical";
  if (Number(item.remainingMs) <= 5 * 60000) return "warning";
  return "success";
}

function displayState(item, mode) {
  if (item.state === "ended") return "Lot ended";
  if (item.state === "unavailable") return "Unavailable";
  if (item.state === "passed") return "Passed";
  if (item.state === "waiting") return "Locating";
  if (["scheduled", "not-started"].includes(item.state)) return "Not started";
  if (mode === "live") return item.state === "live" ? "Live now" : "Upcoming";
  if (Number(item.remainingMs) <= 60000) return "Ending now";
  if (Number(item.remainingMs) <= 5 * 60000) return "Ending soon";
  return "Upcoming";
}

function sortedTimedWatched(watched) {
  return [...(watched || [])].sort((left, right) => {
    const rank = (item) => item.state === "upcoming" ? 0 : item.state === "not-started" ? 1
      : item.state === "ended" ? 2 : item.state === "unavailable" ? 3 : 4;
    const rankDifference = rank(left) - rank(right);
    if (rankDifference) return rankDifference;
    if (left.state === "upcoming") return Number(left.remainingMs) - Number(right.remainingMs);
    return String(left.targetLot).localeCompare(String(right.targetLot), undefined, { numeric: true });
  });
}

function displayWatched(watched, mode) {
  return mode === "live" ? Core.sortLiveWatched(watched) : sortedTimedWatched(watched);
}

function createStageEditor(item, mode, row, button) {
  document.querySelectorAll(".stage-editor").forEach((editor) => editor.remove());
  const timed = mode === "timed";
  const existing = timed ? item.stagesSeconds || [180] : item.stages || [5];
  const candidates = Array.from(new Set([...(timed ? [600, 180, 30] : [10, 5, 0]), ...existing])).sort((a, b) => b - a);
  const editor = document.createElement("div");
  editor.className = "stage-editor";
  const title = document.createElement("strong");
  title.textContent = `Alerts for lot ${item.targetLot}`;
  const help = document.createElement("small");
  help.textContent = "Each selected stage sends once. Timed extensions do not repeat an alert already sent.";
  const choices = document.createElement("div");
  choices.className = "stage-choices";
  for (const stage of candidates) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = String(stage);
    checkbox.checked = existing.includes(stage);
    label.append(checkbox, document.createTextNode(stageLabel(mode, stage)));
    choices.append(label);
  }
  const actions = document.createElement("div");
  actions.className = "editor-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "text-button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => editor.remove());
  const save = document.createElement("button");
  save.type = "button";
  save.className = "primary-button compact-button";
  save.textContent = "Save alerts";
  save.addEventListener("click", async () => {
    const selected = Array.from(editor.querySelectorAll('input[type="checkbox"]:checked')).map((input) => Number(input.value));
    if (!selected.length) { title.textContent = "Choose at least one alert"; return; }
    save.disabled = true;
    const response = await chrome.runtime.sendMessage({
      type: "UPDATE_LOT_ALERTS",
      payload: {
        auctionKey: pageStatus.auctionKey,
        lot: item.targetLot,
        mode,
        ...(timed ? { stagesSeconds: selected } : { stages: selected })
      }
    });
    if (!response?.ok) {
      title.textContent = response?.error || "Could not update alerts";
      save.disabled = false;
      return;
    }
    button.textContent = `Alerts · ${stageSummary({ ...item, ...(timed ? { stagesSeconds: selected } : { stages: selected }) }, mode)}`;
    editor.remove();
    await refreshStatus();
  });
  actions.append(cancel, save);
  editor.append(title, help, choices, actions);
  row.append(editor);
}

function addDistanceTrack(row, item) {
  if (pageStatus.mode !== "live" || !["upcoming", "live"].includes(item.state)) return;
  const maxDistance = Math.max(10, ...(item.stages || [5]));
  const remaining = item.state === "live" ? 0 : Number(item.remaining);
  const progress = Math.max(0, Math.min(100, (1 - Math.min(maxDistance, remaining) / maxDistance) * 100));
  const track = document.createElement("div");
  track.className = "distance-track";
  track.setAttribute("aria-label", `Approach progress for lot ${item.targetLot}`);
  const fill = document.createElement("span");
  fill.style.width = `${progress}%`;
  track.append(fill);
  row.append(track);
}

function renderWatchList(watched) {
  elements.watchList.replaceChildren();
  const ordered = displayWatched(watched, pageStatus.mode);
  elements.emptyState.classList.toggle("hidden", ordered.length > 0);
  elements.thresholdBadge.textContent = `${ordered.length} watched`;
  for (const item of ordered) {
    const tone = displayTone(item, pageStatus.mode);
    const row = document.createElement("article");
    row.className = `watch-item tone-${tone}`;

    const top = document.createElement("div");
    top.className = "watch-item-top";
    const lot = document.createElement("strong");
    lot.className = "watch-lot";
    lot.textContent = `Lot ${item.targetLot}`;
    const badge = document.createElement("span");
    setBadge(badge, displayState(item, pageStatus.mode), tone);
    top.append(lot, badge);

    const status = document.createElement("div");
    status.className = `watch-metric ${pageStatus.mode === "timed" ? "countdown-value" : ""}`;
    status.textContent = item.statusText;

    const meta = document.createElement("div");
    meta.className = "watch-meta";
    if (item.alerted) {
      const sent = document.createElement("span");
      sent.textContent = "Alert sent";
      meta.append(sent);
    }
    if (item.importedFromAccount) {
      const imported = document.createElement("span");
      imported.textContent = "Imported from auction account";
      meta.append(imported);
    }
    if (item.source === "catalogue-lookup" || item.source === "catalogue-lookup-static") {
      const found = document.createElement("span");
      found.textContent = "Found from main catalogue";
      meta.append(found);
    }
    if (item.description) {
      const description = document.createElement("span");
      description.className = "lot-description";
      description.textContent = item.description;
      meta.append(description);
    }

    row.append(top, status, meta);
    addDistanceTrack(row, item);

    const actions = document.createElement("div");
    actions.className = "watch-actions";
    if (!["ended", "passed", "unavailable"].includes(item.state)) {
      const stages = document.createElement("button");
      stages.type = "button";
      stages.className = "stage-button";
      stages.title = "Edit this lot’s alert stages";
      stages.textContent = `Alerts · ${stageSummary(item, pageStatus.mode)}`;
      stages.addEventListener("click", () => createStageEditor(item, pageStatus.mode, row, stages));
      actions.append(stages);
    }

    if ((pageStatus.mode === "timed" || pageStatus.livePhase === "scheduled") && item.bidUrl) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "text-button open-lot-button";
      open.textContent = pageStatus.livePhase === "scheduled" ? "Open live page" : "Open lot";
      open.addEventListener("click", () => openDestination(null, item.bidUrl));
      actions.append(open);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-button";
    remove.setAttribute("aria-label", `Remove lot ${item.targetLot}`);
    remove.title = `Remove lot ${item.targetLot}`;
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      const response = await chrome.runtime.sendMessage({
        type: pageStatus.mode === "timed" ? "REMOVE_TIMED_LOT" : "REMOVE_LOT",
        payload: { auctionKey: pageStatus.auctionKey, lot: item.targetLot }
      });
      if (!response?.ok) setFormMessage(response?.error || "Could not remove that lot.");
      await refreshStatus();
      await refreshDashboard();
    });
    actions.append(remove);
    row.append(actions);
    elements.watchList.append(row);
  }
}

function renderStatus(status) {
  pageStatus = status;
  setReadinessIndicator(provisionalReadiness(status));
  refreshReadinessSummary();
  const timed = status.mode === "timed";
  const scheduledLive = status.mode === "live" && status.livePhase === "scheduled";
  const complete = Boolean(status.monitoringComplete);
  const watched = displayWatched(status.watched || [], status.mode);
  const nextTimed = timed ? watched.find((item) => item.state === "upcoming") : null;
  elements.auctionLabel.textContent = status.auctionLabel || (timed ? "Timed auction" : "Live auction");
  elements.currentLot.textContent = complete ? "Ended" : scheduledLive ? "Scheduled"
    : timed ? nextTimed ? `#${nextTimed.targetLot}` : "—" : status.currentLot || "—";
  elements.summaryEyebrow.textContent = timed ? "Timed auction" : "Live auction";
  elements.summaryMetricLabel.textContent = complete || scheduledLive ? "Status" : timed ? "Next close" : "Current lot";
  setBadge(
    elements.connectionBadge,
    complete ? status.auctionEnded ? "Auction ended" : "Complete"
      : scheduledLive && status.ready ? "Scheduled live" : status.ready ? "Connected" : "Waiting",
    complete ? "muted" : scheduledLive ? "neutral" : status.ready ? "success" : "warning"
  );
  elements.lotInputLabel.textContent = timed ? "Timed lots to watch" : "Live lots to watch";
  elements.fieldHelp.textContent = status.auctionEnded
    ? "This auction has ended, so no further lots will be searched or alerted."
    : scheduledLive ? "Add live lot numbers now. The same watch list carries over when you open the live bidding page."
    : timed ? "Add any lot numbers from this sale. One main catalogue tab can find them across all pages."
      : "Add one or more lot numbers. They will be ordered from closest to furthest.";
  elements.watchEyebrow.textContent = timed ? "Closing-time alerts" : scheduledLive ? "Pre-live watch list" : "Catalogue-distance alerts";
  elements.watchHeading.textContent = timed ? "Watched timed lots" : scheduledLive ? "Watched live lots" : "Closest watched lots";
  const found = watched.filter((item) => item.visible).length;
  const startDetail = status.startsAtMs !== null && status.startsAtMs !== undefined && status.startsAtMs !== "" && Number.isFinite(Number(status.startsAtMs))
    ? `Starts ${new Date(Number(status.startsAtMs)).toLocaleString()}` : "Start time is shown by the auction page";
  elements.healthDetail.textContent = complete
    ? status.auctionEnded ? "Auction finished · page scanning and alerts stopped"
      : "All watched lots ended · page scanning and alerts stopped"
    : scheduledLive ? `${startDetail} · ${found} of ${watched.length} watched lots found`
    : timed ? `${found} of ${watched.length} watched lots found · ${status.lookupState || "checking"}`
      : `Current lot ${status.currentLot || "not detected"} · ${watched.length} watched`;
  elements.healthText.textContent = complete
    ? status.auctionEnded ? "Auction ended — monitoring stopped" : "All watched lots ended — monitoring stopped"
    : scheduledLive ? "Live auction recognised — waiting to start"
    : status.ready ? "Auction connected and reporting" : "Auction data is still loading";
  elements.footerText.textContent = complete
    ? "Monitoring is complete. Your watch list and alert history remain available."
    : scheduledLive ? "Keep this catalogue open before the sale. Open the live bidding page when the webcast starts to receive lot-distance alerts."
    : timed ? "Keep this sale’s main catalogue tab open. Clicking an alert opens the exact lot page."
      : "You can browse other tabs. Clicking an alert returns to this live bidding page.";
  elements.lotInput.disabled = Boolean(status.auctionEnded);
  elements.addLots.disabled = Boolean(status.auctionEnded);
  elements.readinessDisclosure.classList.toggle("hidden", complete);
  if (timed && status.pageLot && !elements.lotInput.value &&
      !watched.some((item) => item.targetLot === status.pageLot)) {
    elements.lotInput.value = status.pageLot;
  }
  renderWatchList(watched);
  showCurrentPanel(elements.auctionView);
}

async function refreshStatus() {
  const response = await sendToTab({ type: "GET_PAGE_STATUS" });
  if (response?.ok && response.status) renderStatus(response.status);
}

function formatLastSeen(value) {
  if (!value) return "No heartbeat yet";
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
}

function createDashboardLot(item, mode) {
  const row = document.createElement("div");
  row.className = "dashboard-lot";
  const identityElement = document.createElement("strong");
  identityElement.textContent = `Lot ${item.targetLot}`;
  const detail = document.createElement("span");
  detail.className = mode === "timed" ? "countdown-value" : "";
  detail.textContent = item.statusText || (mode === "timed"
    ? Core.formatTimedRemaining(item.remainingMs) : Core.formatDistance(item));
  const badge = document.createElement("span");
  setBadge(badge, displayState(item, mode), displayTone(item, mode));
  row.append(identityElement, detail, badge);
  return row;
}

function createDashboardCard(auction) {
  const card = document.createElement("section");
  card.className = `panel dashboard-card ${auction.monitoringComplete ? "complete" : auction.connected ? "connected" : "disconnected"}`;
  const header = document.createElement("div");
  header.className = "dashboard-card-header";
  const heading = document.createElement("div");
  const meta = document.createElement("div");
  meta.className = "dashboard-card-meta";
  const mode = document.createElement("span");
  mode.className = `mode-pill ${auction.mode}`;
  mode.textContent = auction.mode === "timed" ? "Timed" : "Live";
  const connection = document.createElement("span");
  setBadge(
    connection,
    auction.monitoringComplete ? auction.auctionEnded ? "Auction ended" : "Complete" : auction.connected ? "Connected" : "Attention",
    auction.monitoringComplete ? "muted" : auction.connected ? "success" : "critical"
  );
  meta.append(mode, connection);
  const title = document.createElement("h2");
  title.textContent = auction.auctionLabel;
  const heartbeat = document.createElement("small");
  heartbeat.textContent = auction.monitoringComplete
    ? auction.auctionEnded ? "Auction finished · monitoring stopped" : "All watched lots ended · monitoring stopped"
    : auction.healthProblem || `Updated ${formatLastSeen(auction.lastSeen)}`;
  heading.append(meta, title, heartbeat);
  const open = document.createElement("button");
  open.type = "button";
  open.className = "secondary-button compact-button";
  open.textContent = "Open";
  open.addEventListener("click", () => openDestination(auction.tabId, auction.url));
  header.append(heading, open);
  card.append(header);
  const lots = document.createElement("div");
  lots.className = "dashboard-lots";
  for (const item of auction.watched.slice(0, 5)) lots.append(createDashboardLot(item, auction.mode));
  if (auction.watched.length > 5) {
    const more = document.createElement("small");
    more.className = "more-lots";
    more.textContent = `+ ${auction.watched.length - 5} more watched lots`;
    lots.append(more);
  }
  card.append(lots);
  return card;
}

function renderNextUp(dashboard) {
  const candidates = [];
  for (const auction of dashboard.auctions || []) {
    for (const item of auction.watched || []) {
      if (["upcoming", "live"].includes(item.state)) candidates.push({ auction, item });
    }
  }
  candidates.sort((left, right) => Number(left.item.urgency) - Number(right.item.urgency));
  const next = candidates[0];
  elements.nextUpPanel.classList.toggle("hidden", !next);
  if (!next) return;
  elements.nextUpLot.textContent = `Lot ${next.item.targetLot}`;
  elements.nextUpAuction.textContent = next.auction.auctionLabel;
  elements.nextUpStatus.textContent = next.item.statusText || displayState(next.item, next.auction.mode);
  elements.nextUpOpen.onclick = () => openDestination(
    next.auction.tabId,
    next.auction.mode === "timed" ? next.item.bidUrl || next.item.url || next.auction.url : next.auction.url
  );
}

function renderHistory(history) {
  elements.historyList.replaceChildren();
  elements.historyEmpty.classList.toggle("hidden", history.length > 0);
  elements.historySummary.textContent = history.length
    ? `${history.length} recent event${history.length === 1 ? "" : "s"} stored locally`
    : "Local delivery and connection log";
  for (const entry of history.slice(0, 15)) {
    const row = document.createElement("div");
    row.className = `history-item ${entry.type || ""}`;
    const mark = document.createElement("span");
    mark.className = "history-mark";
    const content = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = entry.title || "Watcher event";
    const detail = document.createElement("small");
    const channels = [entry.delivery?.desktopSent ? "desktop" : "", entry.delivery?.pushoverSent ? "Pushover" : ""]
      .filter(Boolean).join(" + ");
    const deliveryText = entry.delivery?.errors?.length
      ? `delivery issue: ${entry.delivery.errors.join(" ")}` : channels;
    detail.textContent = `${new Date(entry.time).toLocaleString()}${deliveryText ? ` · ${deliveryText}` : ""}`;
    content.append(title, detail);
    row.append(mark, content);
    elements.historyList.append(row);
  }
}

async function refreshDashboard() {
  const response = await chrome.runtime.sendMessage({ type: "GET_DASHBOARD" });
  if (!response?.ok) return null;
  const dashboard = response.dashboard;
  if (!pageStatus) {
    const active = dashboard.auctions.filter((auction) => !auction.monitoringComplete);
    if (!dashboard.auctions.length) setReadinessIndicator({ state: "idle", label: "No watches", detail: "No watched auctions yet" });
    else if (!active.length) setReadinessIndicator({ state: "complete", label: "Complete", detail: "All monitored auctions are complete" });
    else if (active.some((auction) => !auction.connected)) setReadinessIndicator({ state: "attention", label: "Attention", detail: "One or more auction tabs need attention" });
    else setReadinessIndicator({ state: "ready", label: "Ready", detail: "Watched auction tabs are connected" });
  }
  elements.dashboardList.replaceChildren();
  if (!dashboard.auctions.length) {
    const empty = document.createElement("section");
    empty.className = "panel state-panel empty-dashboard";
    const icon = document.createElement("div");
    icon.className = "state-icon";
    icon.textContent = "+";
    const title = document.createElement("h2");
    title.textContent = "No watched auctions yet";
    const description = document.createElement("p");
    description.textContent = "Open an auction catalogue or live page and add your lot numbers.";
    empty.append(icon, title, description);
    elements.dashboardList.append(empty);
  } else {
    for (const auction of dashboard.auctions) elements.dashboardList.append(createDashboardCard(auction));
  }
  elements.dashboardHeading.textContent = `${dashboard.auctions.length} watched auction${dashboard.auctions.length === 1 ? "" : "s"}`;
  elements.reliabilityBadge.textContent = dashboard.reliability.active
    ? `Protected · ${dashboard.reliability.protectedTabs} tab${dashboard.reliability.protectedTabs === 1 ? "" : "s"}`
    : dashboard.reliability.enabled ? "Protection ready" : "Protection off";
  elements.reliabilityBadge.classList.toggle("active", dashboard.reliability.active);
  renderNextUp(dashboard);
  renderHistory(dashboard.history || []);
  return dashboard;
}

function renderReadiness(result) {
  elements.readinessResults.replaceChildren();
  elements.readinessResults.classList.remove("hidden");
  elements.readinessDisclosure.open = true;
  for (const check of result.checks || []) {
    const row = document.createElement("div");
    row.className = check.ok ? "check-pass" : "check-fail";
    const icon = document.createElement("span");
    icon.textContent = check.ok ? "✓" : "!";
    const copy = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = check.label;
    const detail = document.createElement("small");
    detail.textContent = check.detail;
    copy.append(label, detail);
    row.append(icon, copy);
    elements.readinessResults.append(row);
  }
}

async function initialize() {
  showCurrentPanel(elements.loadingView);
  const dashboard = await refreshDashboard();
  activeTab = await getActiveTab();
  identity = Core.parsePageIdentity(activeTab?.url || "");
  if (!activeTab?.id || !identity) {
    showCurrentPanel(elements.unsupportedView);
    if (dashboard?.auctions?.length) switchView("dashboard");
    return;
  }
  elements.enableHost.textContent = identity.origin;
  const allowed = await chrome.permissions.contains({ origins: [identity.registrationMatch] });
  if (!allowed) { showCurrentPanel(elements.enableView); return; }
  const response = await ensureContentScript();
  if (response?.ok && response.status && (identity.mode !== "timed" || response.status.ready)) {
    renderStatus(response.status);
    refreshTimer = setInterval(refreshStatus, 1200);
  } else showCurrentPanel(elements.unsupportedView);
}

elements.currentTabButton.addEventListener("click", () => switchView("current"));
elements.dashboardTabButton.addEventListener("click", () => switchView("dashboard"));
elements.showAllWatches.addEventListener("click", () => switchView("dashboard"));
elements.enableSite.addEventListener("click", async () => {
  elements.enableSite.disabled = true;
  elements.enableSite.textContent = "Enabling…";
  try {
    const granted = await chrome.permissions.request({ origins: [identity.registrationMatch] });
    if (!granted) throw new Error("Site permission was not granted.");
    const response = await ensureContentScript();
    if (!response?.ok || !response.status || (identity.mode === "timed" && !response.status.ready)) {
      throw new Error(response?.error || "The auction details could not be detected yet.");
    }
    renderStatus(response.status);
    refreshTimer = setInterval(refreshStatus, 1200);
  } catch (error) {
    elements.enableSite.textContent = "Try again";
    elements.enableSite.disabled = false;
    elements.enableHost.textContent = error.message;
  }
});

elements.addLots.addEventListener("click", async () => {
  if (!pageStatus) return;
  const lots = Core.parseWatchedInput(elements.lotInput.value);
  if (!lots.length) { setFormMessage("Enter at least one lot number."); return; }
  elements.addLots.disabled = true;
  const response = await chrome.runtime.sendMessage({
    type: pageStatus.mode === "timed" ? "ADD_TIMED_LOTS" : "ADD_LOTS",
    payload: {
      auctionKey: pageStatus.auctionKey,
      auctionId: pageStatus.auctionId,
      dayId: pageStatus.dayId,
      auctionLabel: pageStatus.auctionLabel,
      url: pageStatus.url,
      lots
    }
  });
  elements.addLots.disabled = false;
  if (!response?.ok) { setFormMessage(response?.error || "Could not save those lots."); return; }
  elements.lotInput.value = "";
  setFormMessage(`${lots.length} lot${lots.length === 1 ? "" : "s"} added.`, true);
  await refreshStatus();
  await refreshDashboard();
});

elements.readinessTest.addEventListener("click", async () => {
  if (!pageStatus?.auctionKey) return;
  elements.readinessTest.disabled = true;
  elements.readinessTest.textContent = "Testing…";
  const response = await chrome.runtime.sendMessage({ type: "RUN_READINESS_CHECK", payload: { auctionKey: pageStatus.auctionKey } });
  elements.readinessTest.disabled = false;
  elements.readinessTest.textContent = "Run readiness test";
  if (response?.ok) renderReadiness(response.result);
  else setFormMessage(response?.error || "Readiness test failed.");
  await refreshDashboard();
  await refreshReadinessSummary(true);
});

elements.readinessIndicator.addEventListener("click", () => {
  if (!pageStatus || elements.readinessDisclosure.classList.contains("hidden")) {
    switchView("dashboard");
    return;
  }
  switchView("current");
  elements.readinessDisclosure.open = true;
  elements.readinessDisclosure.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

elements.lotInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") elements.addLots.click();
});
elements.createIssueReport.addEventListener("click", createIssueReport);
elements.copyIssueReport.addEventListener("click", copyIssueReport);
elements.openSettings.addEventListener("click", () => chrome.runtime.openOptionsPage());
window.addEventListener("unload", () => {
  clearInterval(refreshTimer);
  clearInterval(dashboardTimer);
});

dashboardTimer = setInterval(() => {
  if (!elements.dashboardView.classList.contains("hidden")) refreshDashboard();
}, 4000);

initialize().catch((error) => {
  console.error(error);
  showCurrentPanel(elements.unsupportedView);
});
