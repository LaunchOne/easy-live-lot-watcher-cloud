(function installEasyLiveCatalogueBridge() {
  "use strict";

  if (globalThis.__easyLiveCatalogueBridgeInstalledV11) return;
  globalThis.__easyLiveCatalogueBridgeInstalledV11 = true;

  const SOURCE = "easy-live-lot-watcher";
  const BRIDGE_VERSION = 11;
  const xhrLots = new Map();
  const resolvedLots = new Map();
  const lastLookupAt = new Map();
  let watchedLots = new Set();
  let lastFingerprint = "";
  let lookupRunning = false;
  let lookupState = "idle";
  let lookupError = "";
  let lastSnapshot = null;
  let auctionEnded = false;
  let monitoringComplete = false;
  let terminalReason = "";

  function normalize(value) {
    return String(value || "").trim().replace(/^lot\s*(?:no\.?\s*)?/i, "").replace(/\s+/g, "").toUpperCase();
  }

  function text(selector) {
    return String(document.querySelector(selector)?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function textFrom(root, selector) {
    return String(root?.querySelector?.(selector)?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function absoluteUrl(value, base = location.href) {
    try { return new URL(value || base, base).href; }
    catch (_error) { return String(value || ""); }
  }

  function catalogueRoute(urlValue = location.href) {
    try {
      const url = new URL(urlValue, location.origin);
      const match = url.pathname.match(/\/catalogue\/(?!lot(?:\/|$))([^/]+)/i);
      if (!match) return null;
      url.search = "";
      url.hash = "";
      const parts = url.pathname.split("/").filter(Boolean);
      return {
        auctionId: normalize(match[1]), rawAuctionId: match[1],
        dayId: normalize(parts[2] || ""), rawDayId: parts[2] || "",
        slug: parts[3] || "auction", catalogueUrl: url.href
      };
    } catch (_error) {
      return null;
    }
  }

  function lotNumberFrom(root) {
    const candidates = [
      textFrom(root, ".currentPage"),
      textFrom(root, ".lot-no"),
      textFrom(root, ".lot-card__lot-number"),
      textFrom(root, ".catalogue-description h4"),
      textFrom(root, 'a[href*="/catalogue/lot/"]')
    ];
    for (const candidate of candidates) {
      const match = candidate.match(/\bLot\s+(?:No\.?\s*)?([A-Za-z0-9._\/-]+)/i);
      if (match) return normalize(match[1]);
    }
    return "";
  }

  function extractLotNumber() {
    return lotNumberFrom(document);
  }

  function extractAuctionId(root = document, pageUrl = location.href) {
    const direct = catalogueRoute(pageUrl);
    if (direct?.auctionId) return direct.auctionId;
    const registration = root?.querySelector?.('a[href*="/auction-registration/"]')?.getAttribute("href") || "";
    const match = registration.match(/\/auction-registration\/([^/]+)/i);
    if (match) return normalize(match[1]);
    const links = Array.from(root?.querySelectorAll?.('a[href*="/catalogue/"]') || []);
    for (const link of links) {
      const route = catalogueRoute(link.getAttribute?.("href") || link.href || "");
      if (route?.auctionId) return route.auctionId;
    }
    return "";
  }

  function extractDescription(root = document) {
    const structured = root?.querySelector?.('script[type="application/ld+json"]');
    try {
      const data = JSON.parse(structured?.textContent || "{}");
      if (data.name) return String(data.name).replace(/\s+/g, " ").trim();
    } catch (_error) {}
    return textFrom(root, ".lot-description") || textFrom(root, "h1");
  }

  function trueFlag(value) {
    return value === true || Number(value) === 1 || /^(?:true|yes|ended|closed|finished|complete|completed|historic)$/i.test(String(value || "").trim());
  }

  function watchedFlag(value) {
    return value === true || Number(value) === 1 || /^(?:true|yes|watched|watching|active)$/i.test(String(value || "").trim());
  }

  function dataSaysLotWatched(lot) {
    return [
      lot?.is_watched, lot?.watched, lot?.watching, lot?.in_watchlist, lot?.in_watch_list,
      lot?.watch_list, lot?.watchlist, lot?.user_watched, lot?.lot_watched
    ].some(watchedFlag);
  }

  function controlSaysWatching(root) {
    const controls = Array.from(root?.querySelectorAll?.(
      'button, a, [role="button"], input[type="button"], input[type="submit"]'
    ) || []);
    return controls.some((control) => {
      const label = String(
        control.textContent || control.value || control.getAttribute?.("aria-label") || control.getAttribute?.("title") || ""
      ).replace(/\s+/g, " ").trim();
      if (/^(?:watching|unwatch(?:\s+lot)?|remove\s+from\s+(?:my\s+)?watch\s*list)$/i.test(label)) return true;
      const pressed = String(control.getAttribute?.("aria-pressed") || "").toLowerCase() === "true";
      const selectedClass = /(?:^|\s)(?:active|selected|watched|watching)(?:\s|$)/i.test(String(control.className || ""));
      return /\bwatch(?:ing|ed|\s+lot)?\b/i.test(label) && (pressed || selectedClass);
    });
  }

  function dataSaysAuctionEnded(data) {
    const info = data?.auction_info || {};
    const flags = [
      data?.auction_ended, data?.is_ended, data?.ended, data?.closed, data?.finished,
      info.auction_ended, info.is_ended, info.ended, info.closed, info.finished, info.historic
    ];
    if (flags.some(trueFlag)) return true;
    const status = [data?.auction_status, data?.status, info.auction_status, info.status, info.state].join(" ");
    return /\b(?:ended|closed|finished|complete|completed|historic)\b/i.test(status);
  }

  function pageSaysAuctionEnded(root = document) {
    const markers = [
      ".auction-ended", ".auction-ended-message", "#auction-ended", "[data-auction-ended='true']",
      "[data-auction-status='ended']", "[data-auction-status='closed']"
    ];
    if (markers.some((selector) => root?.querySelector?.(selector))) return true;
    const pageText = String(root?.body?.textContent || root?.documentElement?.textContent || "").replace(/\s+/g, " ");
    return /\b(?:this\s+)?(?:auction|sale)\s+(?:(?:has|is)\s+)?(?:now\s+)?(?:ended|closed|finished|complete|completed)\b/i.test(pageText) ||
      /\b(?:this\s+)?(?:auction|sale)\s+is\s+no\s+longer\s+available\b/i.test(pageText);
  }

  function lotMonitoringComplete(lot) {
    if (!lot) return false;
    return Boolean(lot.confirmedEnded || Number(lot.expiredChecks || 0) >= 2);
  }

  function rememberResolvedLot(lotNumber, lot, checked = false) {
    if (!lot) {
      resolvedLots.delete(lotNumber);
      return;
    }
    const previous = resolvedLots.get(lotNumber);
    const sameDeadline = Number.isFinite(Number(previous?.deadlineMs)) &&
      Number(previous.deadlineMs) === Number(lot.deadlineMs);
    let expiredChecks = sameDeadline ? Number(previous?.expiredChecks || 0) : 0;
    if (checked && lot.ended && !lot.confirmedEnded) expiredChecks += 1;
    if (!lot.ended || lot.confirmedEnded) expiredChecks = 0;
    resolvedLots.set(lotNumber, { ...lot, expiredChecks });
  }

  function rememberMissingLot(lotNumber, confirmedMissing = false) {
    const previous = resolvedLots.get(lotNumber);
    const deadlineMs = Number(previous?.deadlineMs);
    if (!previous || !Number.isFinite(deadlineMs) || deadlineMs > Date.now()) {
      resolvedLots.delete(lotNumber);
      return false;
    }
    const expiredChecks = Number(previous.expiredChecks || 0) + 1;
    resolvedLots.set(lotNumber, {
      ...previous,
      ended: true,
      confirmedEnded: Boolean(previous.confirmedEnded || confirmedMissing),
      missingAfterDeadline: true,
      expiredChecks
    });
    return true;
  }

  function addTerminalState(snapshot, lots, explicitAuctionEnd = false) {
    auctionEnded = auctionEnded || explicitAuctionEnd;
    const indexed = new Map((lots || []).map((lot) => [lot.lot, lot]));
    const allWatchedEnded = watchedLots.size > 0 && Array.from(watchedLots).every((lotNumber) =>
      lotMonitoringComplete(indexed.get(lotNumber) || resolvedLots.get(lotNumber))
    );
    monitoringComplete = auctionEnded || allWatchedEnded;
    terminalReason = auctionEnded ? "auction-ended" : allWatchedEnded ? "watched-lots-ended" : "";
    if (monitoringComplete) {
      lookupState = auctionEnded ? "ended" : "complete";
      lookupError = "";
    }
    return {
      ...snapshot,
      lookupState,
      lookupError,
      auctionEnded,
      monitoringComplete,
      terminalReason
    };
  }

  function parseDuration(value) {
    const source = String(value || "").toLowerCase();
    if (!source || /finished|ended|closed/.test(source)) return null;
    const clockMatch = source.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
    if (clockMatch) {
      return (Number(clockMatch[1] || 0) * 3600 + Number(clockMatch[2]) * 60 + Number(clockMatch[3])) * 1000;
    }
    const days = Number(source.match(/(\d+)\s*d/)?.[1] || 0);
    const hours = Number(source.match(/(\d+)\s*h/)?.[1] || 0);
    const minutes = Number(source.match(/(\d+)\s*m/)?.[1] || 0);
    const seconds = Number(source.match(/(\d+)\s*s/)?.[1] || 0);
    if (!(days || hours || minutes || seconds)) return null;
    return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  }

  function parseUtcWallTime(value) {
    const match = String(value || "").trim().match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
    if (!match) return null;
    const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
    const month = months[match[2].toUpperCase()];
    if (month === undefined) return null;
    return Date.UTC(Number(match[3]), month, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6]));
  }

  function cleanDescription(lot) {
    return String(lot.description || lot.short_desc || lot.lot_desc || "")
      .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }

  function parseStaticWallTime(value, fallbackYear, fallbackZone) {
    const match = String(value || "").replace(/\s+/g, " ").match(
      /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})(?:\s+(\d{2,4}))?\s+(?:from|at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(BST|GMT|UTC|IST)?/i
    );
    if (!match) return null;
    const months = {
      JAN:0,JANUARY:0,FEB:1,FEBRUARY:1,MAR:2,MARCH:2,APR:3,APRIL:3,MAY:4,JUN:5,JUNE:5,
      JUL:6,JULY:6,AUG:7,AUGUST:7,SEP:8,SEPT:8,SEPTEMBER:8,OCT:9,OCTOBER:9,
      NOV:10,NOVEMBER:10,DEC:11,DECEMBER:11
    };
    const month = months[match[2].toUpperCase()];
    if (month === undefined) return null;
    let year = Number(match[3] || fallbackYear);
    if (!Number.isFinite(year)) return null;
    if (year < 100) year += 2000;
    let hour = Number(match[4]);
    const minute = Number(match[5] || 0);
    const meridiem = String(match[6] || "").toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    const zone = String(match[7] || fallbackZone || "").toUpperCase();
    const offsetMinutes = zone === "BST" || zone === "IST" ? 60 : 0;
    return Date.UTC(year, month, Number(match[1]), hour, minute, 0) - offsetMinutes * 60000;
  }

  function parseStaticDeadline(root) {
    const bodyText = String(root?.body?.textContent || root?.documentElement?.textContent || "")
      .replace(/\s+/g, " ").trim();
    const yearMatch = bodyText.match(/(?:Auction Ends|Sale Dates)[^\d]*(?:\d{1,2})(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\s+(\d{2,4})/i) ||
      bodyText.match(/\b(20\d{2})\b/);
    const fallbackYear = yearMatch?.[1] || new Date().getUTCFullYear();
    const fallbackZone = bodyText.match(/\b(BST|GMT|UTC|IST)\b/i)?.[1] || "";
    const candidates = [
      textFrom(root, "#timedEndTime"),
      bodyText.match(/Auction Ends:\s*([^\n]{0,100}?\b(?:BST|GMT|UTC|IST)\b)/i)?.[1] || "",
      bodyText.match(/Sale Dates:\s*([^\n]{0,100}?\b(?:BST|GMT|UTC|IST)\b)/i)?.[1] || ""
    ];
    for (const candidate of candidates) {
      const parsed = parseStaticWallTime(candidate, fallbackYear, fallbackZone);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  function parseDateValue(value, root = document) {
    if (Number.isFinite(Number(value)) && Number(value) > 100000000000) return Number(value);
    const source = String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (!source) return null;
    const utc = parseUtcWallTime(source);
    if (Number.isFinite(utc)) return utc;
    const pageText = String(root?.body?.textContent || root?.documentElement?.textContent || "").replace(/\s+/g, " ");
    const fallbackYear = source.match(/\b(20\d{2})\b/)?.[1] || pageText.match(/\b(20\d{2})\b/)?.[1] || new Date().getUTCFullYear();
    const fallbackZone = source.match(/\b(BST|GMT|UTC|IST)\b/i)?.[1] || pageText.match(/\b(BST|GMT|UTC|IST)\b/i)?.[1] || "";
    const wallTime = parseStaticWallTime(source, fallbackYear, fallbackZone);
    if (Number.isFinite(wallTime)) return wallTime;
    const parsed = Date.parse(source);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function auctionStartTime(data, root = document) {
    const info = data?.auction_info || {};
    const candidates = [
      info.start_date_time, info.start_datetime, info.auction_start_time, info.start_auction_time,
      info.start_date, info.start_time, data?.start_date_time, data?.start_datetime,
      data?.auction_start_time, data?.start_auction_time, data?.start_date, data?.start_time
    ];
    const pageText = String(root?.body?.textContent || root?.documentElement?.textContent || "").replace(/\s+/g, " ").trim();
    const metaDescription = String(root?.querySelector?.('meta[name="description" i]')?.getAttribute?.("content") || "").replace(/\s+/g, " ").trim();
    const metaDate = metaDescription.match(/\bSale\s+Date\s*:\s*([^()]+?)(?=\)|\bBID\b|$)/i)?.[1];
    if (metaDate) candidates.push(metaDate);
    const labelled = pageText.match(/(?:Auction|Sale|Live\s+Bidding|Webcast)\s+(?:Starts?|Opens?|Begins?)(?:\s+at)?\s*:?\s*(.{1,100}?(?:\bBST\b|\bGMT\b|\bUTC\b|\bIST\b|\b(?:am|pm)\b))/i)?.[1];
    if (labelled) candidates.push(labelled);
    for (const candidate of candidates) {
      const parsed = parseDateValue(candidate, root);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  function bidLiveDetails(root = document, preferredAuctionId = "") {
    const links = Array.from(root?.querySelectorAll?.('a[href*="/bid-live/"]') || []);
    let fallback = null;
    for (const link of links) {
      const url = absoluteUrl(link.getAttribute?.("href") || link.href || "");
      const match = new URL(url, location.origin).pathname.match(/\/bid-live\/([^/]+)/i);
      if (!match) continue;
      const details = { bidLiveUrl: url, liveAuctionId: match[1] };
      if (preferredAuctionId && normalize(match[1]) === normalize(preferredAuctionId)) return details;
      if (!fallback) fallback = details;
    }
    if (preferredAuctionId) return { bidLiveUrl: "", liveAuctionId: "" };
    return fallback || { bidLiveUrl: "", liveAuctionId: "" };
  }

  function detectAuctionMode(data, root = document, auctionId = "") {
    const type = String(data?.auction_info?.type || data?.auction_type || "").trim();
    if (/^(?:T|TIMED)$/i.test(type)) return "timed";
    if (/^(?:L|LIVE|W|WEBCAST)$/i.test(type)) return "live";
    const liveLink = bidLiveDetails(root, auctionId);
    if (liveLink.bidLiveUrl) return "live";
    const pageText = String(root?.body?.textContent || root?.documentElement?.textContent || "").replace(/\s+/g, " ");
    const metaDescription = String(root?.querySelector?.('meta[name="description" i]')?.getAttribute?.("content") || "");
    if (/\bLIVE\s+AUCTION\b/i.test(metaDescription)) return "live";
    if (/\b(?:live\s+webcast|live\s+auction|watch\s+live|bid\s+live)\b/i.test(pageText)) return "live";
    if (/\b(?:timed\s+auction|timed\s+bidding|auction\s+ends|time\s+remaining)\b/i.test(pageText) || root?.querySelector?.("#timedEndTime")) return "timed";
    return type && !/^(?:T|TIMED)$/i.test(type) ? "live" : "timed";
  }

  function derivedLiveDetails(data, root, auctionMode, preferredAuctionId = "") {
    const visible = bidLiveDetails(root, preferredAuctionId);
    if (visible.bidLiveUrl || auctionMode !== "live") return visible;
    const generated = absoluteUrl(data?.live_bidding_link || "");
    const generatedMatch = generated ? new URL(generated, location.origin).pathname.match(/\/bid-live\/([^/]+)/i) : null;
    if (generatedMatch) return { bidLiveUrl: generated, liveAuctionId: generatedMatch[1] };
    const route = catalogueRoute(location.href);
    if (!route?.rawAuctionId || !route.rawDayId) return visible;
    return {
      bidLiveUrl: new URL(`/bid-live/${route.rawAuctionId}/${route.rawDayId}/${route.slug}/`, location.origin).href,
      liveAuctionId: route.rawAuctionId
    };
  }

  function staticCardLot(card, context) {
    const lot = lotNumberFrom(card);
    const link = card?.querySelector?.('a[href*="/catalogue/lot/"]');
    const url = absoluteUrl(link?.getAttribute?.("href") || link?.href || "");
    const lotId = normalize(url.match(/\/catalogue\/lot\/([^/]+)/i)?.[1] || "");
    if (!lot || !lotId || !context?.auctionId) return null;
    const description = textFrom(card, ".catalogue-description .no-hover p") ||
      textFrom(card, ".catalogue-description p");
    const confirmedEnded = /\b(?:ended|closed|finished)\b/i.test(String(card.textContent || ""));
    return {
      lot,
      lotId,
      auctionId: context.auctionId,
      deadlineMs: null,
      ended: confirmedEnded,
      confirmedEnded,
      accountWatched: controlSaysWatching(card),
      url,
      bidUrl: url,
      description,
      source: "catalogue-page-static"
    };
  }

  function staticCatalogueContext() {
    const route = catalogueRoute(location.href);
    if (!route || /\/catalogue\/lot\//i.test(location.pathname)) return null;
    return route;
  }

  function staticCatalogueLots(context) {
    return Array.from(document.querySelectorAll?.(".grid-lot") || [])
      .map((card) => staticCardLot(card, context)).filter(Boolean);
  }

  function staticIndividualLot(root, pageUrl, auctionId, source = "catalogue-lookup-static") {
    const lot = lotNumberFrom(root);
    const resolvedAuctionId = normalize(auctionId || extractAuctionId(root, pageUrl));
    const lotId = normalize(root?.querySelector?.("#lotID, .lotID")?.value ||
      String(pageUrl || "").match(/\/catalogue\/lot\/([^/]+)/i)?.[1]);
    if (!lot || !lotId || !resolvedAuctionId) return null;
    const deadlineMs = parseStaticDeadline(root);
    const startsAtMs = auctionStartTime(null, root);
    const pageText = String(root?.body?.textContent || "");
    const confirmedEnded = /\b(?:auction ended|bidding closed|lot ended|lot closed|lot finished)\b/i.test(pageText);
    return {
      lot,
      lotId,
      auctionId: resolvedAuctionId,
      deadlineMs,
      ended: confirmedEnded || (Number.isFinite(deadlineMs) && deadlineMs <= Date.now()),
      confirmedEnded,
      accountWatched: controlSaysWatching(root),
      awaitingStart: !confirmedEnded && !Number.isFinite(deadlineMs) &&
        Number.isFinite(startsAtMs) && startsAtMs > Date.now(),
      url: absoluteUrl(pageUrl),
      bidUrl: absoluteUrl(pageUrl),
      description: extractDescription(root),
      source
    };
  }

  function exactLotUrl(lot, data) {
    const provided = new URL(lot.url || location.href, location.origin);
    if (/\/catalogue\/lot\//i.test(provided.pathname)) return provided.href;
    const lotId = String(lot.encrypt_id || "").trim();
    const dayId = String(lot.encrypt_day_id || data?.encrypt_day_id || "").trim();
    const slug = String(lot.url_description || "").trim();
    if (lotId && dayId) {
      return new URL(`/catalogue/lot/${lotId}/${dayId}/${slug}`, location.origin).href;
    }
    return provided.href;
  }

  function mapApiLot(lot, data, source) {
    const lotNumber = normalize(lot.lot_no || lot.lotno || lot.lot_number);
    if (!lotNumber) return null;
    const deadlineMs = parseUtcWallTime(lot.date_info?.end_lot_time || lot.end_lot_time);
    const lotStatus = String(lot.status || "").trim();
    const confirmedEnded = lot.lot_ended === true || Number(lot.lot_ended) === 1 ||
      /^(?:ended|closed|finished|complete|completed)$/i.test(lotStatus);
    return {
      lot: lotNumber,
      lotId: normalize(lot.encrypt_id),
      auctionId: normalize(lot.encrypt_auction_id || data?.encrypt_auction_id),
      deadlineMs,
      ended: confirmedEnded || (Number.isFinite(deadlineMs) && deadlineMs <= Date.now()),
      confirmedEnded,
      accountWatched: dataSaysLotWatched(lot),
      awaitingStart: !confirmedEnded && !Number.isFinite(deadlineMs),
      url: exactLotUrl(lot, data),
      bidUrl: exactLotUrl(lot, data),
      description: cleanDescription(lot),
      source
    };
  }

  function getCatalogueData() {
    const root = document.querySelector('[x-data="auctions"]');
    if (!root || !globalThis.Alpine?.$data) return null;
    try {
      const data = globalThis.Alpine.$data(root);
      return data?.auction_info ? data : null;
    } catch (_error) {
      return null;
    }
  }

  function publish(snapshot, force = false) {
    const clean = JSON.parse(JSON.stringify(snapshot));
    lastSnapshot = clean;
    const fingerprint = JSON.stringify(clean);
    if (!force && fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    window.postMessage({ source: SOURCE, type: "TIMED_SNAPSHOT", payload: clean }, "*");
  }

  function alpineSnapshot() {
    const data = getCatalogueData();
    if (!data) return null;
    const pageLots = Array.from(data.lots || []).map((lot) => mapApiLot(lot, data, "catalogue-page")).filter(Boolean);
    const route = catalogueRoute(location.href);
    const watchedFromDom = new Set((route ? staticCatalogueLots(route) : [])
      .filter((lot) => lot.accountWatched).map((lot) => lot.lot));
    for (const lot of pageLots) if (watchedFromDom.has(lot.lot)) lot.accountWatched = true;
    for (const lot of pageLots) if (watchedLots.has(lot.lot)) rememberResolvedLot(lot.lot, lot);
    const combined = new Map();
    for (const lot of resolvedLots.values()) if (watchedLots.has(lot.lot)) combined.set(lot.lot, lot);
    for (const lot of pageLots) combined.set(lot.lot, lot);
    const lots = Array.from(combined.values());
    const auctionId = normalize(data.encrypt_auction_id || pageLots[0]?.auctionId || route?.auctionId);
    const auctionMode = detectAuctionMode(data, document, auctionId);
    const liveDetails = derivedLiveDetails(data, document, auctionMode, auctionId);
    return addTerminalState({
      bridgeVersion: BRIDGE_VERSION,
      pageKind: "catalogue",
      auctionMode,
      auctionId,
      liveAuctionId: liveDetails.liveAuctionId || route?.rawAuctionId || "",
      bidLiveUrl: liveDetails.bidLiveUrl,
      startsAtMs: auctionStartTime(data, document),
      auctionLabel: String(data.auction_info?.short_desc || document.title).replace(/\s+/g, " ").trim(),
      pageUrl: location.href,
      pageLot: null,
      lots
    }, lots, dataSaysAuctionEnded(data) || pageSaysAuctionEnded(document));
  }

  function staticCatalogueSnapshot() {
    const context = staticCatalogueContext();
    if (!context) return null;
    const auctionMode = detectAuctionMode(null, document, context.auctionId);
    const liveDetails = derivedLiveDetails(null, document, auctionMode, context.auctionId);
    const startsAtMs = auctionStartTime(null, document);
    const pageLots = staticCatalogueLots(context);
    const explicitAuctionEnd = pageSaysAuctionEnded(document);
    if (!pageLots.length && !explicitAuctionEnd && auctionMode !== "live") return null;
    for (const lot of pageLots) {
      if (watchedLots.has(lot.lot)) rememberResolvedLot(lot.lot, lot);
    }
    const combined = new Map(pageLots.map((lot) => [lot.lot, lot]));
    for (const lot of resolvedLots.values()) if (watchedLots.has(lot.lot)) combined.set(lot.lot, lot);
    const lots = Array.from(combined.values());
    return addTerminalState({
      bridgeVersion: BRIDGE_VERSION,
      pageKind: "catalogue",
      auctionMode,
      auctionId: context.auctionId,
      liveAuctionId: liveDetails.liveAuctionId || context.rawAuctionId || "",
      bidLiveUrl: liveDetails.bidLiveUrl,
      startsAtMs,
      auctionLabel: String(document.title || (auctionMode === "live" ? "Live auction" : "Timed auction")).replace(/\s+/g, " ").trim(),
      pageUrl: location.href,
      pageLot: null,
      lots
    }, lots, explicitAuctionEnd);
  }

  function individualSnapshot() {
    const lotId = normalize(document.querySelector("#lotID, .lotID")?.value || location.pathname.match(/\/catalogue\/lot\/([^/]+)/i)?.[1]);
    const lot = xhrLots.get(lotId);
    const lotNumber = extractLotNumber();
    const auctionId = extractAuctionId(document, location.href);
    if (!lotId || !lotNumber || !auctionId) return null;
    let deadlineMs = lot?.deadlineMs || null;
    const countdown = text("#timedEndTime");
    const remainingMs = parseDuration(countdown);
    if (remainingMs !== null) {
      const candidate = Date.now() + remainingMs;
      if (!deadlineMs || Math.abs(candidate - deadlineMs) > 30000) deadlineMs = candidate;
    }
    if (!Number.isFinite(deadlineMs)) deadlineMs = parseStaticDeadline(document);
    const confirmedEnded = Boolean(lot?.ended) || /finished|ended|closed/i.test(countdown);
    const lots = [{
      lot: lotNumber,
      lotId,
      auctionId,
      deadlineMs,
      ended: confirmedEnded || (Number.isFinite(deadlineMs) && deadlineMs <= Date.now()),
      confirmedEnded,
      accountWatched: Boolean(lot?.accountWatched) || controlSaysWatching(document),
      awaitingStart: !confirmedEnded && !Number.isFinite(deadlineMs),
      url: location.href,
      bidUrl: location.href,
      description: extractDescription(),
      source: "individual-page"
    }];
    const auctionMode = detectAuctionMode(null, document, auctionId);
    const liveDetails = bidLiveDetails(document, auctionId);
    return addTerminalState({
      bridgeVersion: BRIDGE_VERSION,
      pageKind: "lot",
      auctionMode,
      auctionId,
      liveAuctionId: liveDetails.liveAuctionId || "",
      bidLiveUrl: liveDetails.bidLiveUrl,
      startsAtMs: auctionStartTime(null, document),
      auctionLabel: text(".auction-title") || document.title,
      pageUrl: location.href,
      pageLot: lotNumber,
      lots
    }, lots, pageSaysAuctionEnded(document));
  }

  function scan(force = false) {
    if (monitoringComplete && !force) return;
    const snapshot = alpineSnapshot() || staticCatalogueSnapshot() || individualSnapshot();
    if (snapshot) publish(snapshot, force);
  }

  function lookupInterval(lot) {
    if (lotMonitoringComplete(lot)) return Number.POSITIVE_INFINITY;
    if (!lot || !Number.isFinite(Number(lot.deadlineMs))) return 60000;
    const remaining = Number(lot.deadlineMs) - Date.now();
    if (remaining <= 0) return 120000;
    if (remaining <= 15 * 60 * 1000) return 10000;
    return 60000;
  }

  async function lookupLot(lotNumber, data) {
    if (typeof globalThis.lotHandler !== "function") throw new Error("Catalogue search is not ready yet.");
    const result = await globalThis.lotHandler({
      search: lotNumber,
      category: "all",
      sortby: "lotno",
      pagination: { pageNo: 1, perPage: 30 },
      page_type: data.page_type || "auction",
      soldStatus: "",
      lotNoSearch: true,
      auctionID: data.encrypt_auction_id,
      dayID: data.encrypt_day_id,
      historic: ""
    });
    if (!result?.success || !Array.isArray(result.response?.lots)) throw new Error("The catalogue lot search did not respond.");
    if (dataSaysAuctionEnded(result.response)) auctionEnded = true;
    const found = result.response.lots
      .map((lot) => mapApiLot(lot, data, "catalogue-lookup"))
      .find((lot) => lot?.lot === lotNumber) || null;
    if (found) rememberResolvedLot(lotNumber, found, true);
    else rememberMissingLot(lotNumber, true);
    lastLookupAt.set(lotNumber, Date.now());
  }

  async function lookupStaticLot(lotNumber, context) {
    const cached = resolvedLots.get(lotNumber);
    let targetUrl = /\/catalogue\/lot\//i.test(cached?.url || "") ? cached.url : "";
    if (!targetUrl) {
      const searchUrl = new URL(context.catalogueUrl, location.origin);
      searchUrl.search = "";
      searchUrl.searchParams.set("searchTerm", lotNumber);
      searchUrl.searchParams.set("searchOption", "2");
      targetUrl = searchUrl.href;
    }
    const response = await fetch(targetUrl, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) {
      if ([404, 410].includes(Number(response.status)) && rememberMissingLot(lotNumber, true)) {
        lastLookupAt.set(lotNumber, Date.now());
        return;
      }
      throw new Error(`Catalogue search returned ${response.status}.`);
    }
    const html = await response.text();
    const resolvedUrl = response.url || targetUrl;
    if (!/\/catalogue\/lot\//i.test(new URL(resolvedUrl, location.origin).pathname)) {
      rememberMissingLot(lotNumber, true);
      lastLookupAt.set(lotNumber, Date.now());
      return;
    }
    const parsed = new DOMParser().parseFromString(html, "text/html");
    if (pageSaysAuctionEnded(parsed)) auctionEnded = true;
    const found = staticIndividualLot(parsed, resolvedUrl, context.auctionId);
    if (found?.lot === lotNumber) rememberResolvedLot(lotNumber, found, true);
    else rememberMissingLot(lotNumber, true);
    lastLookupAt.set(lotNumber, Date.now());
  }

  async function refreshLookups(force = false) {
    if (lookupRunning || !watchedLots.size || monitoringComplete) return;
    const data = getCatalogueData();
    const staticContext = data ? null : staticCatalogueContext();
    if (!data && !staticContext) return;
    lookupRunning = true;
    lookupState = "searching";
    lookupError = "";
    scan(true);
    try {
      const visible = data
        ? new Set(Array.from(data.lots || []).map((lot) => normalize(lot.lot_no || lot.lotno)))
        : new Set(staticCatalogueLots(staticContext).map((lot) => lot.lot));
      let checked = 0;
      for (const lotNumber of Array.from(watchedLots)) {
        const cached = resolvedLots.get(lotNumber);
        if (lotMonitoringComplete(cached)) continue;
        const due = Date.now() - Number(lastLookupAt.get(lotNumber) || 0) >= lookupInterval(cached);
        if (!force && visible.has(lotNumber) && Number.isFinite(Number(cached?.deadlineMs)) &&
          Number(cached.deadlineMs) > Date.now()) continue;
        if (!force && !due) continue;
        try {
          if (data) await lookupLot(lotNumber, data);
          else await lookupStaticLot(lotNumber, staticContext);
        } catch (error) {
          if (!rememberMissingLot(lotNumber, false)) throw error;
          lastLookupAt.set(lotNumber, Date.now());
        }
        checked += 1;
        if (checked) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      lookupState = "ready";
    } catch (error) {
      lookupState = "error";
      lookupError = error.message || String(error);
    } finally {
      lookupRunning = false;
      scan(true);
    }
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    this.__easyLiveWatcherUrl = String(url || "");
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function patchedSend(body) {
    if (/doRefreshTimedBidding/i.test(this.__easyLiveWatcherUrl || "")) {
      let lotId = "";
      try {
        const params = new URLSearchParams(String(body || ""));
        lotId = normalize(JSON.parse(params.get("data") || "{}").lot);
      } catch (_error) {}
      this.addEventListener("load", () => {
        try {
          const raw = String(this.responseText || "").replace(/^\/\//, "");
          const result = JSON.parse(raw);
          const secondsLeft = Number(result.secondsLeft);
          xhrLots.set(lotId, {
            deadlineMs: Number.isFinite(secondsLeft) && secondsLeft > 0 ? Date.now() + secondsLeft * 1000 : null,
            ended: Boolean(Number(result.ended)),
            confirmedEnded: Boolean(Number(result.ended))
          });
          scan();
        } catch (_error) {}
      });
    }
    return originalSend.apply(this, arguments);
  };

  function startObserver() {
    if (!document.documentElement) return;
    const observer = new MutationObserver(() => scan());
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    scan();
    setTimeout(() => refreshLookups(true), 600);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== SOURCE) return;
    if (event.data.type === "REQUEST_TIMED_SNAPSHOT") {
      if (monitoringComplete && lastSnapshot) publish(lastSnapshot, true);
      else scan(true);
    }
    if (event.data.type === "SET_TIMED_WATCH_LOTS") {
      const next = new Set((event.data.payload?.lots || []).map(normalize).filter(Boolean));
      const changed = JSON.stringify(Array.from(next).sort()) !== JSON.stringify(Array.from(watchedLots).sort());
      watchedLots = next;
      for (const lot of Array.from(resolvedLots.keys())) if (!watchedLots.has(lot)) resolvedLots.delete(lot);
      for (const lot of Array.from(lastLookupAt.keys())) if (!watchedLots.has(lot)) lastLookupAt.delete(lot);
      if (changed && !auctionEnded) {
        monitoringComplete = false;
        terminalReason = "";
        lookupState = watchedLots.size ? "idle" : "ready";
        scan(true);
        refreshLookups(true);
      } else if (changed && monitoringComplete && lastSnapshot) publish(lastSnapshot, true);
      else if (!lastSnapshot) scan(true);
    }
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startObserver, { once: true });
  else startObserver();

  setInterval(scan, 1000);
  setInterval(() => refreshLookups(false), 5000);
})();
