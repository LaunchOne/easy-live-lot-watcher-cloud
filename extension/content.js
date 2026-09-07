(function startEasyLiveWatcher() {
  "use strict";

  const CONTENT_VERSION = "0.5.3-health-warning-throttle";
  if (globalThis.__easyLiveWatcherContentLoaded === CONTENT_VERSION) return;
  globalThis.__easyLiveWatcherContentLoaded = CONTENT_VERSION;

  const Core = globalThis.EasyLiveWatchCore;
  const pageIdentity = Core?.parsePageIdentity(location.href);
  if (!Core || !pageIdentity) return;

  const SOURCE = "easy-live-lot-watcher";
  const HEARTBEAT_MS = 30000;

  function reportDiagnostic(event, details = {}, level = "error") {
    return chrome.runtime.sendMessage({
      type: "DIAGNOSTIC_EVENT",
      payload: { event, level, details: { contentVersion: CONTENT_VERSION, ...details } }
    }).catch(() => null);
  }

  function cleanAuctionLabel(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/\s*[-|]\s*Easy Live Auction.*$/i, "")
      .trim();
  }

  function liveStageKey(auctionKey, lot, stage) {
    return `${auctionKey}::${Core.normalizeLot(lot)}::${Number(stage)}`;
  }

  function timedStageKey(auctionKey, lot, stage) {
    return `${auctionKey}::${Core.normalizeLot(lot)}::${Number(stage)}`;
  }

  function pageSaysLiveAuctionEnded() {
    const markers = [
      ".auction-ended", ".auction-ended-message", "#auction-ended", "[data-auction-ended='true']",
      "[data-auction-status='ended']", "[data-auction-status='closed']"
    ];
    if (markers.some((selector) => document.querySelector(selector))) return true;
    const pageText = String(document.body?.textContent || "").replace(/\s+/g, " ");
    return /\b(?:this\s+)?(?:auction|sale)\s+(?:(?:has|is)\s+)?(?:now\s+)?(?:ended|closed|finished|complete|completed)\b/i.test(pageText) ||
      /\b(?:this\s+)?(?:auction|sale)\s+is\s+no\s+longer\s+available\b/i.test(pageText);
  }

  if (pageIdentity.mode === "live") startLiveWatcher();
  else startTimedWatcher();

  function startLiveWatcher() {
    const identity = pageIdentity;
    const SELECTORS = {
      currentLot: ["#bid-live-lot-no .lot-list-popup", "#bid-live-lot-no a", "#bid-live-lot-no"],
      lotLinks: ["#bid-live-lot-section .lot-list-popup", "#bid-live-lot-section-more .lot-list-popup"].join(","),
      auctionTitle: ["#bid-live-title strong", "#auction-info h4 strong", "#bid-live-title"]
    };
    let lastFingerprint = "";
    let lastStatus = null;
    let lastDataChangeAt = Date.now();
    let debounceTimer = null;
    let evaluationRunning = false;
    let evaluationQueued = false;
    let cachedCatalogueOrder = [];

    function firstElement(selectors) {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) return element;
      }
      return null;
    }

    function getCurrentLot() {
      const element = firstElement(SELECTORS.currentLot);
      return element ? Core.extractLotNumber(element.textContent) : "";
    }

    function getCatalogueOrder() {
      const visibleOrder = Core.uniqueOrder(Array.from(document.querySelectorAll(SELECTORS.lotLinks))
        .map((element) => Core.extractLotNumber(element.textContent)).filter(Boolean));
      if (visibleOrder.length > cachedCatalogueOrder.length) cachedCatalogueOrder = visibleOrder;
      return cachedCatalogueOrder.length ? cachedCatalogueOrder : visibleOrder;
    }

    function getAuctionLabel() {
      return cleanAuctionLabel(firstElement(SELECTORS.auctionTitle)?.textContent) ||
        cleanAuctionLabel(document.title) || "Easy Live Auction";
    }

    async function getStoredState() {
      return chrome.storage.local.get([
        "settings", "auctionConfigs", "liveAlertedStages", "alertedLots"
      ]);
    }

    async function buildStatus(storedState) {
      const stored = storedState || await getStoredState();
      const settings = {
        threshold: 5,
        defaultLiveStages: null,
        ...(stored.settings || {})
      };
      const config = (stored.auctionConfigs || {})[identity.auctionKey] || { lots: [], lotOptions: {} };
      const currentLot = getCurrentLot();
      const order = getCatalogueOrder();
      const auctionEnded = pageSaysLiveAuctionEnded();
      const alerted = stored.liveAlertedStages || {};
      const legacyAlerted = stored.alertedLots || {};
      const watched = Core.sortLiveWatched((config.lots || []).map((targetLot) => {
        const result = Core.calculateDistance(currentLot, targetLot, order);
        const stages = Core.normalizeLiveStages(
          config.lotOptions?.[targetLot]?.stages,
          settings.defaultLiveStages || [settings.threshold]
        );
        const alertedStages = stages.filter((stage) => Boolean(alerted[liveStageKey(identity.auctionKey, targetLot, stage)]));
        if (legacyAlerted[`${identity.auctionKey}::${targetLot}`] && !alertedStages.includes(settings.threshold)) {
          alertedStages.push(settings.threshold);
        }
        return {
          targetLot,
          ...result,
          ...(auctionEnded && !["passed"].includes(result.state)
            ? { state: "unavailable", remaining: null }
            : {}),
          visible: result.targetIndex !== -1,
          statusText: auctionEnded && result.state !== "passed" ? "Unavailable — auction ended" : Core.formatDistance(result),
          stages,
          alertedStages,
          importedFromAccount: Boolean(config.lotOptions?.[targetLot]?.importedFromAccount),
          alerted: alertedStages.length > 0
        };
      }));
      return {
        ...identity,
        ready: auctionEnded || Boolean(currentLot || order.length),
        auctionEnded,
        monitoringComplete: auctionEnded,
        terminalReason: auctionEnded ? "auction-ended" : "",
        url: location.href,
        auctionLabel: getAuctionLabel(),
        currentLot,
        orderSize: order.length,
        lastDataChangeAt,
        watched
      };
    }

    function stableFingerprint(status) {
      return JSON.stringify({
        currentLot: status.currentLot,
        orderSize: status.orderSize,
        ready: status.ready,
        auctionEnded: status.auctionEnded,
        monitoringComplete: status.monitoringComplete,
        watched: status.watched
      });
    }

    async function evaluate() {
      if (evaluationRunning) { evaluationQueued = true; return; }
      evaluationRunning = true;
      try {
        const stored = await getStoredState();
        const status = await buildStatus(stored);
        const fingerprint = stableFingerprint(status);
        if (fingerprint !== lastFingerprint) {
          lastFingerprint = fingerprint;
          lastDataChangeAt = Date.now();
          status.lastDataChangeAt = lastDataChangeAt;
          lastStatus = status;
          await chrome.runtime.sendMessage({ type: "PAGE_STATUS", payload: status }).catch(() => null);
        } else lastStatus = status;

        for (const item of status.auctionEnded ? [] : status.watched) {
          const stage = Core.nextLiveAlertStage(item.remaining, item.stages, item.alertedStages);
          if (stage !== null) {
            await chrome.runtime.sendMessage({
              type: "THRESHOLD_REACHED",
              payload: {
                auctionKey: identity.auctionKey,
                auctionLabel: status.auctionLabel,
                currentLot: status.currentLot,
                remaining: item.remaining,
                targetLot: item.targetLot,
                stage,
                stages: item.stages,
                url: location.href
              }
            }).catch(() => null);
          }
        }
      } finally {
        evaluationRunning = false;
        if (evaluationQueued) { evaluationQueued = false; scheduleEvaluation(50); }
      }
    }

    function scheduleEvaluation(delay = 250) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(evaluate, delay);
    }

    function observePage() {
      if (!document.documentElement) return;
      const observer = new MutationObserver(() => scheduleEvaluation());
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      scheduleEvaluation(0);
    }

    if (document.documentElement) observePage();
    else document.addEventListener("DOMContentLoaded", observePage, { once: true });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && (
        changes.settings || changes.auctionConfigs || changes.liveAlertedStages || changes.alertedLots
      )) {
        lastFingerprint = "";
        scheduleEvaluation(50);
      }
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "GET_PAGE_STATUS") return false;
      buildStatus().then((status) => sendResponse({ ok: true, status }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    });

    setInterval(async () => {
      const status = lastStatus || await buildStatus().catch(() => null);
      if (status) chrome.runtime.sendMessage({ type: "PAGE_HEARTBEAT", payload: { ...status, lastDataChangeAt } }).catch(() => null);
    }, HEARTBEAT_MS);
  }

  function startTimedWatcher() {
    let latestSnapshot = null;
    let highestBridgeVersion = 0;
    let lastFingerprint = "";
    let lastStatus = null;
    let lastDataChangeAt = Date.now();
    let evaluationRunning = false;
    let evaluationQueued = false;
    let lastAccountImportFingerprint = "";

    async function getStoredState() {
      return chrome.storage.local.get([
        "settings", "auctionConfigs", "timedAuctionConfigs",
        "liveAlertedStages", "alertedLots", "timedAlertedStages"
      ]);
    }

    function catalogueAuctionId(urlValue) {
      return Core.extractTimedAuctionIdFromUrl(urlValue || location.href);
    }

    function catalogueDayId(urlValue) {
      return Core.extractTimedDayIdFromUrl(urlValue || location.href);
    }

    function findStoredIdentity(configs, mode, candidateIds) {
      const normalizedIds = new Set(candidateIds.map(Core.normalizeLot).filter(Boolean));
      const currentRouteId = Core.normalizeLot(catalogueAuctionId(location.href));
      const currentDayId = Core.normalizeLot(catalogueDayId(location.href));
      for (const [auctionKey, config] of Object.entries(configs || {})) {
        if (normalizedIds.has(Core.normalizeLot(config?.auctionId))) {
          return {
            auctionKey,
            auctionId: config.auctionId || candidateIds[0],
            dayId: config.dayId || catalogueDayId(config?.url),
            matchedBy: "saved-auction-id"
          };
        }
      }
      if (currentDayId) {
        for (const [auctionKey, config] of Object.entries(configs || {})) {
          const savedDayId = Core.normalizeLot(config?.dayId || catalogueDayId(config?.url));
          if (savedDayId && savedDayId === currentDayId) {
            return {
              auctionKey,
              auctionId: config.auctionId || candidateIds[0] || "",
              dayId: config.dayId || catalogueDayId(config?.url) || catalogueDayId(location.href),
              matchedBy: "saved-sale-day"
            };
          }
        }
      }
      if (currentRouteId) {
        for (const [auctionKey, config] of Object.entries(configs || {})) {
          if (Core.normalizeLot(catalogueAuctionId(config?.url)) === currentRouteId) {
            return {
              auctionKey,
              auctionId: config.auctionId || candidateIds[0] || catalogueAuctionId(config?.url),
              dayId: config.dayId || catalogueDayId(config?.url),
              matchedBy: "saved-page-route"
            };
          }
        }
      }
      return null;
    }

    function resolveIdentity(stored = {}) {
      if (latestSnapshot?.auctionMode === "live") {
        const candidateIds = [latestSnapshot.liveAuctionId, pageIdentity.auctionId, latestSnapshot.auctionId]
          .map((value) => String(value || "").trim()).filter(Boolean);
        const storedIdentity = findStoredIdentity(stored.auctionConfigs, "live", candidateIds);
        const auctionId = String(storedIdentity?.auctionId || candidateIds[0] || "").trim();
        if (!auctionId) return null;
        return {
          mode: "live",
          auctionId,
          auctionKey: storedIdentity?.auctionKey || `${location.origin}::${auctionId}`,
          dayId: storedIdentity?.dayId || pageIdentity.dayId || catalogueDayId(location.href),
          origin: location.origin,
          registrationMatch: `${location.origin}/*`
        };
      }
      const candidateIds = [latestSnapshot?.auctionId, pageIdentity.auctionId, catalogueAuctionId(location.href)]
        .map((value) => String(value || "").trim()).filter(Boolean);
      const storedIdentity = findStoredIdentity(stored.timedAuctionConfigs, "timed", candidateIds);
      if (storedIdentity) {
        return {
          mode: "timed",
          auctionId: storedIdentity.auctionId,
          auctionKey: storedIdentity.auctionKey,
          dayId: storedIdentity.dayId || pageIdentity.dayId || catalogueDayId(location.href),
          origin: location.origin,
          registrationMatch: `${location.origin}/*`
        };
      }
      if (candidateIds[0]) {
        return {
          mode: "timed",
          ...Core.timedAuctionIdentity(location.origin, candidateIds[0]),
          dayId: pageIdentity.dayId || catalogueDayId(location.href)
        };
      }
      return pageIdentity.auctionKey ? { ...pageIdentity, mode: "timed" } : null;
    }

    function shareWatchList(config) {
      window.postMessage({
        source: SOURCE,
        type: "SET_TIMED_WATCH_LOTS",
        payload: { lots: config.lots || [] }
      }, "*");
    }

    function finiteTime(value) {
      if (value === null || value === undefined || value === "") return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    function scheduledStatusText(startsAtMs, prefix = "Live auction") {
      const start = finiteTime(startsAtMs);
      if (start === null) return `${prefix} not started`;
      if (start <= Date.now()) return `${prefix} is waiting to open`;
      return `${prefix} starts ${new Date(start).toLocaleString()}`;
    }

    async function buildStatus(storedState) {
      const stored = storedState || await getStoredState();
      const settings = {
        threshold: 5,
        defaultLiveStages: null,
        timedThresholdMinutes: 3,
        defaultTimedStagesSeconds: null,
        accountWatchImportEnabled: true,
        ...(stored.settings || {})
      };
      const identity = resolveIdentity(stored);
      const scheduledLive = identity?.mode === "live";
      const legacyTimedIdentity = scheduledLive
        ? Core.timedAuctionIdentity(location.origin, latestSnapshot?.auctionId || identity.auctionId)
        : null;
      const configSource = scheduledLive ? stored.auctionConfigs : stored.timedAuctionConfigs;
      const legacyLiveConfig = scheduledLive && legacyTimedIdentity
        ? (stored.timedAuctionConfigs || {})[legacyTimedIdentity.auctionKey]
        : null;
      const config = identity
        ? (configSource || {})[identity.auctionKey] || legacyLiveConfig || { lots: [], lotOptions: {} }
        : { lots: [], lotOptions: {} };
      const identityDiagnostics = {
        contentVersion: CONTENT_VERSION,
        bridgeVersion: Number(latestSnapshot?.bridgeVersion || 0),
        pageIdentityAuctionId: pageIdentity.auctionId || "",
        pageIdentityDayId: pageIdentity.dayId || "",
        snapshotAuctionId: latestSnapshot?.auctionId || "",
        routeAuctionId: catalogueAuctionId(location.href),
        routeDayId: catalogueDayId(location.href),
        resolvedAuctionId: identity?.auctionId || "",
        resolvedDayId: identity?.dayId || "",
        resolvedAuctionKey: identity?.auctionKey || "",
        savedConfigFound: Boolean(identity && ((configSource || {})[identity.auctionKey] || legacyLiveConfig)),
        savedTimedConfigCount: Object.keys(stored.timedAuctionConfigs || {}).length,
        savedLiveConfigCount: Object.keys(stored.auctionConfigs || {}).length
      };
      shareWatchList(config);
      const snapshotLots = new Map((latestSnapshot?.lots || []).map((item) => [Core.normalizeLot(item.lot), item]));
      const now = Date.now();
      const auctionEnded = Boolean(latestSnapshot?.auctionEnded);

      if (scheduledLive) {
        const alerted = stored.liveAlertedStages || {};
        const legacyAlerted = stored.alertedLots || {};
        const startsAtMs = finiteTime(latestSnapshot?.startsAtMs);
        const watched = Core.sortLiveWatched((config.lots || []).map((targetLot) => {
          const lot = snapshotLots.get(Core.normalizeLot(targetLot));
          const stages = Core.normalizeLiveStages(
            config.lotOptions?.[targetLot]?.stages,
            settings.defaultLiveStages || [settings.threshold || 5]
          );
          const alertedStages = stages.filter((stage) => Boolean(alerted[liveStageKey(identity.auctionKey, targetLot, stage)]));
          if (legacyAlerted[`${identity.auctionKey}::${targetLot}`] && !alertedStages.includes(settings.threshold || 5)) {
            alertedStages.push(settings.threshold || 5);
          }
          return {
            targetLot,
            state: auctionEnded ? "unavailable" : "scheduled",
            remaining: null,
            targetIndex: -1,
            visible: Boolean(lot),
            source: lot?.source || "",
            statusText: auctionEnded ? "Unavailable — auction ended" : scheduledStatusText(startsAtMs),
            stages,
            alertedStages,
            alerted: alertedStages.length > 0,
            importedFromAccount: Boolean(config.lotOptions?.[targetLot]?.importedFromAccount),
            description: lot?.description || "",
            url: lot?.url || latestSnapshot?.pageUrl || location.href,
            bidUrl: latestSnapshot?.bidLiveUrl || latestSnapshot?.pageUrl || location.href
          };
        }));
        return {
          ...identity,
          pageKind: latestSnapshot?.pageKind || "catalogue",
          livePhase: "scheduled",
          ready: Boolean(latestSnapshot && identity && latestSnapshot.lookupState !== "error"),
          auctionEnded,
          monitoringComplete: Boolean(latestSnapshot?.monitoringComplete),
          terminalReason: latestSnapshot?.terminalReason || "",
          url: latestSnapshot?.pageUrl || location.href,
          bidLiveUrl: latestSnapshot?.bidLiveUrl || "",
          startsAtMs,
          auctionLabel: cleanAuctionLabel(latestSnapshot?.auctionLabel) || "Live auction",
          currentLot: "",
          orderSize: latestSnapshot?.lots?.length || 0,
          visibleLotCount: latestSnapshot?.lots?.length || 0,
          lookupState: latestSnapshot?.lookupState || "waiting",
          lookupError: latestSnapshot?.lookupError || "",
          accountWatchDetected: (latestSnapshot?.lots || []).filter((lot) => lot.accountWatched).length,
          diagnostics: identityDiagnostics,
          legacyTimedAuctionKey: legacyLiveConfig ? legacyTimedIdentity.auctionKey : "",
          lastDataChangeAt,
          watched
        };
      }

      const alerted = stored.timedAlertedStages || {};
      const watched = (config.lots || []).map((targetLot) => {
        const lot = snapshotLots.get(Core.normalizeLot(targetLot));
        const deadlineMs = finiteTime(lot?.deadlineMs);
        const timedState = Core.calculateTimedState(deadlineMs, now);
        const state = !lot && auctionEnded ? "unavailable" : lot?.ended ? "ended"
          : lot?.awaitingStart ? "not-started" : timedState.state;
        const stagesSeconds = Core.normalizeTimedStages(
          config.lotOptions?.[targetLot]?.stagesSeconds,
          settings.defaultTimedStagesSeconds || [settings.timedThresholdMinutes * 60]
        );
        const alertedStages = stagesSeconds.filter((stage) => {
          const value = alerted[timedStageKey(identity?.auctionKey, targetLot, stage)];
          return Boolean(value) && (typeof value !== "object" || value.status !== "skipped");
        });
        return {
          targetLot,
          visible: Boolean(lot),
          source: lot?.source || "",
          deadlineMs,
          remainingMs: timedState.remainingMs,
          state,
          statusText: !lot
            ? auctionEnded ? "Unavailable — auction ended"
              : latestSnapshot?.lookupState === "searching" ? "Looking up lot from this catalogue…" : "Waiting for catalogue lookup"
            : state === "ended" ? "Lot ended"
              : state === "not-started" ? scheduledStatusText(latestSnapshot?.startsAtMs, "Auction")
                : Core.formatTimedRemaining(timedState.remainingMs),
          alerted: alertedStages.length > 0,
          importedFromAccount: Boolean(config.lotOptions?.[targetLot]?.importedFromAccount),
          alertedStages,
          stagesSeconds,
          description: lot?.description || "",
          url: lot?.url || latestSnapshot?.pageUrl || location.href,
          bidUrl: lot?.bidUrl || lot?.url || latestSnapshot?.pageUrl || location.href
        };
      });
      return {
        mode: "timed",
        pageKind: latestSnapshot?.pageKind || pageIdentity.pageKind,
        auctionId: identity?.auctionId || null,
        auctionKey: identity?.auctionKey || null,
        dayId: identity?.dayId || pageIdentity.dayId || catalogueDayId(location.href) || null,
        origin: location.origin,
        registrationMatch: `${location.origin}/*`,
        ready: Boolean(latestSnapshot && identity && latestSnapshot.lookupState !== "error"),
        auctionEnded,
        monitoringComplete: Boolean(latestSnapshot?.monitoringComplete),
        terminalReason: latestSnapshot?.terminalReason || "",
        url: latestSnapshot?.pageUrl || location.href,
        startsAtMs: finiteTime(latestSnapshot?.startsAtMs),
        auctionLabel: cleanAuctionLabel(latestSnapshot?.auctionLabel) || "Timed auction",
        pageLot: latestSnapshot?.pageLot || null,
        visibleLotCount: latestSnapshot?.lots?.length || 0,
        lookupState: latestSnapshot?.lookupState || "waiting",
        lookupError: latestSnapshot?.lookupError || "",
        accountWatchDetected: (latestSnapshot?.lots || []).filter((lot) => lot.accountWatched).length,
        diagnostics: identityDiagnostics,
        lastDataChangeAt,
        watched
      };
    }

    function stableFingerprint(status) {
      return JSON.stringify({
        mode: status.mode,
        livePhase: status.livePhase || "",
        auctionKey: status.auctionKey,
        dayId: status.dayId || "",
        auctionLabel: status.auctionLabel,
        pageLot: status.pageLot,
        lookupState: status.lookupState,
        lookupError: status.lookupError,
        auctionEnded: status.auctionEnded,
        monitoringComplete: status.monitoringComplete,
        terminalReason: status.terminalReason,
        startsAtMs: status.startsAtMs || null,
        watched: status.watched.map((item) => ({
          targetLot: item.targetLot,
          visible: item.visible,
          source: item.source,
          deadlineMs: item.deadlineMs,
          state: item.state,
          alertedStages: item.alertedStages,
          stagesSeconds: item.stagesSeconds,
          importedFromAccount: item.importedFromAccount,
          description: item.description,
          url: item.url
        }))
      });
    }

    async function importDetectedAccountWatches(status, stored) {
      if (stored.settings?.accountWatchImportEnabled === false || status.auctionEnded) return;
      const lots = Array.from(new Set((latestSnapshot?.lots || [])
        .filter((lot) => lot.accountWatched)
        .map((lot) => Core.normalizeLot(lot.lot)).filter(Boolean)));
      if (!lots.length) return;
      const fingerprint = `${status.mode}::${status.auctionKey}::${lots.slice().sort().join(",")}`;
      if (fingerprint === lastAccountImportFingerprint) return;
      lastAccountImportFingerprint = fingerprint;
      const response = await chrome.runtime.sendMessage({
        type: "IMPORT_ACCOUNT_WATCHES",
        payload: {
          mode: status.mode,
          auctionKey: status.auctionKey,
          auctionId: status.auctionId,
          dayId: status.dayId,
          auctionLabel: status.auctionLabel,
          url: status.url,
          lots
        }
      }).catch(() => null);
      if (!response?.ok) lastAccountImportFingerprint = "";
    }

    async function evaluate() {
      if (evaluationRunning) { evaluationQueued = true; return; }
      evaluationRunning = true;
      try {
        const stored = await getStoredState();
        const status = await buildStatus(stored);
        if (!status.auctionKey) return;
        const fingerprint = stableFingerprint(status);
        if (fingerprint !== lastFingerprint) {
          lastFingerprint = fingerprint;
          lastDataChangeAt = Date.now();
          status.lastDataChangeAt = lastDataChangeAt;
          lastStatus = status;
          await chrome.runtime.sendMessage({ type: "PAGE_STATUS", payload: status }).catch(() => null);
        } else lastStatus = status;
        await importDetectedAccountWatches(status, stored);
      } catch (error) {
        await reportDiagnostic("timed-content-evaluation-error", {
          message: error?.message || String(error),
          pageKind: pageIdentity.pageKind,
          pageAuctionId: pageIdentity.auctionId || "",
          routeAuctionId: catalogueAuctionId(location.href)
        });
      } finally {
        evaluationRunning = false;
        if (evaluationQueued) { evaluationQueued = false; setTimeout(evaluate, 30); }
      }
    }

    window.addEventListener("message", (event) => {
      if (event.source !== window || event.data?.source !== SOURCE || event.data?.type !== "TIMED_SNAPSHOT") return;
      const bridgeVersion = Number(event.data.payload?.bridgeVersion || 0);
      if (bridgeVersion < highestBridgeVersion) return;
      highestBridgeVersion = Math.max(highestBridgeVersion, bridgeVersion);
      latestSnapshot = event.data.payload;
      evaluate();
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && (
        changes.settings || changes.auctionConfigs || changes.timedAuctionConfigs ||
        changes.liveAlertedStages || changes.alertedLots || changes.timedAlertedStages
      )) {
        lastFingerprint = "";
        evaluate();
      }
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "GET_PAGE_STATUS") return false;
      buildStatus().then((status) => sendResponse({ ok: true, status }))
        .catch((error) => {
          reportDiagnostic("timed-status-request-error", { message: error?.message || String(error) });
          sendResponse({ ok: false, error: error.message });
        });
      return true;
    });

    window.postMessage({ source: SOURCE, type: "REQUEST_TIMED_SNAPSHOT" }, "*");
    setTimeout(() => {
      if (!latestSnapshot) window.postMessage({ source: SOURCE, type: "REQUEST_TIMED_SNAPSHOT" }, "*");
    }, 800);
    setInterval(async () => {
      const status = lastStatus || await buildStatus().catch(() => null);
      if (status) chrome.runtime.sendMessage({ type: "PAGE_HEARTBEAT", payload: { ...status, lastDataChangeAt } }).catch(() => null);
    }, HEARTBEAT_MS);
  }
})();
