import { chromium } from "playwright";
import { catalogueUrlFromLive, isBidLiveUrl, liveFeedExpected, normalizeLot, normalizeTimedLot, parseAuctionLabelDate, parseEasyLiveTime } from "./easy-live.js";
import { requestCurrentLiveLot } from "./live-socket.js";

const LIVE_AUCTION_RETENTION_MS = 72 * 60 * 60 * 1000;
const LIVE_FEED_START_GRACE_MS = 10 * 60 * 1000;
const TIMED_AUCTION_RETENTION_MS = 48 * 60 * 60 * 1000;

export class BrowserMonitor {
  constructor({ navigationTimeoutMs = 45000 } = {}) {
    this.navigationTimeoutMs = navigationTimeoutMs;
    this.browser = null;
    this.pages = new Map();
  }

  async start() {
    if (this.browser) return;
    this.browser = await chromium.launch({
      headless: true,
      args: ["--disable-dev-shm-usage", "--no-sandbox"]
    });
  }

  async stop() {
    for (const page of this.pages.values()) await page.close().catch(() => null);
    this.pages.clear();
    await this.browser?.close().catch(() => null);
    this.browser = null;
  }

  async pageFor(key, url) {
    await this.start();
    let page = this.pages.get(key);
    if (!page || page.isClosed()) {
      page = await this.browser.newPage({
        locale: "en-GB",
        timezoneId: "Europe/London",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/139 Safari/537.36 EasyLiveLotWatcherCloud/1.0"
      });
      page.setDefaultNavigationTimeout(this.navigationTimeoutMs);
      page.setDefaultTimeout(Math.min(this.navigationTimeoutMs, 20000));
      this.pages.set(key, page);
    }
    const current = new URL(page.url());
    const target = new URL(url);
    if (page.url() === "about:blank" || current.origin !== target.origin || !current.pathname.startsWith(target.pathname)) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }
    return page;
  }

  async closeAuction(key) {
    const page = this.pages.get(key);
    this.pages.delete(key);
    await page?.close().catch(() => null);
  }

  async catalogueContext(page) {
    return page.evaluate(() => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const route = location.pathname.match(/\/catalogue\/(?!lot(?:\/|$))([^/]+)\/([^/]+)/i);
      let data = null;
      try {
        const root = document.querySelector('[x-data="auctions"]');
        data = root && globalThis.Alpine?.$data ? globalThis.Alpine.$data(root) : null;
      } catch (_error) {}
      const liveLink = Array.from(document.querySelectorAll('a[href*="/bid-live/"]'))
        .find((link) => /\b(?:bid|watch)\s+live\b/i.test(clean(link.textContent)));
      const metaDescription = clean(document.querySelector('meta[name="description" i]')?.getAttribute("content"));
      const pageText = clean(document.body?.textContent || "");
      const metaLive = /\bLIVE\s+AUCTION\b/i.test(metaDescription);
      const timedPage = /\b(?:TIMED\s+AUCTION|AUCTION\s+(?:ENDED|ENDS)\s*:|TIMED\s+BIDDING)\b/i.test(`${metaDescription} ${pageText}`);
      const type = clean(data?.auction_info?.type || data?.auction_type || (metaLive ? "L" : timedPage ? "T" : ""));
      const generatedLiveLink = clean(data?.live_bidding_link);
      const isLive = /^(?:L|LIVE|W|WEBCAST)$/i.test(type) || /\bLIVE\s+AUCTION\b/i.test(metaDescription);
      const routeLiveLink = route && isLive
        ? `/bid-live/${route[1]}/${route[2]}/${location.pathname.split("/").filter(Boolean)[3] || "auction"}/`
        : "";
      const dateText = metaDescription.match(/\bSale\s+Date\s*:\s*([^()]+?)(?=\)|\bBID\b|$)/i)?.[1]?.trim() ||
        pageText.match(/\b(?:Auction\s+(?:Ended|Ends|Starts)|Sale\s+Dates?)\s*:\s*(?:Ended\s+)?(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\s*([^|]{1,80})/i)?.[1]?.trim() || "";
      const parseMetaDate = (value) => {
        const match = String(value || "").match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\s+(\d{2,4})\s+(?:from|at)?\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
        if (!match) return null;
        const months = { JAN:0,JANUARY:0,FEB:1,FEBRUARY:1,MAR:2,MARCH:2,APR:3,APRIL:3,MAY:4,JUN:5,JUNE:5,JUL:6,JULY:6,AUG:7,AUGUST:7,SEP:8,SEPT:8,SEPTEMBER:8,OCT:9,OCTOBER:9,NOV:10,NOVEMBER:10,DEC:11,DECEMBER:11 };
        const month = months[match[2].toUpperCase()];
        if (month === undefined) return null;
        const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
        let hour = Number(match[4]) % 12;
        if (match[6].toUpperCase() === "PM") hour += 12;
        return new Date(year, month, Number(match[1]), hour, Number(match[5] || 0), 0).getTime();
      };
      const startRaw = data?.auction_info?.start_date_time || data?.auction_info?.start_datetime ||
        data?.auction_info?.start_date || data?.auction_info?.auction_date || dateText || null;
      return {
        auctionId: clean(data?.encrypt_auction_id || route?.[1]),
        dayId: clean(data?.encrypt_day_id || route?.[2]),
        label: clean(data?.auction_info?.short_desc || document.querySelector("h1")?.textContent || document.title),
        type,
        startsAt: startRaw,
        startsAtMs: parseMetaDate(startRaw) || null,
        ended: Boolean(data?.auction_ended || data?.is_ended || data?.auction_info?.ended ||
          /\b(?:this\s+)?(?:auction|sale)\s+(?:has\s+|is\s+)?(?:ended|closed|finished|complete)\b/i.test(pageText)),
        bidLiveUrl: isLive && (liveLink || generatedLiveLink || routeLiveLink)
          ? new URL(liveLink?.getAttribute("href") || generatedLiveLink || routeLiveLink, location.href).href : "",
        hasLotHandler: typeof globalThis.lotHandler === "function" && Boolean(data)
      };
    });
  }

  async waitForCatalogue(page) {
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => document.readyState !== "loading").catch(() => null);
    await page.waitForFunction(() => {
      const root = document.querySelector('[x-data="auctions"]');
      return Boolean(root && globalThis.Alpine?.$data && globalThis.Alpine.$data(root)?.auction_info);
    }, null, { timeout: 15000 }).catch(() => null);
  }

  async lookupWithPageData(page, lotNumber) {
    return page.evaluate(async (targetLot) => {
      const normalize = (value) => String(value || "").trim().replace(/^lot\s*(?:no\.?\s*)?/i, "").replace(/\s+/g, "").toUpperCase();
      const root = document.querySelector('[x-data="auctions"]');
      const data = root && globalThis.Alpine?.$data ? globalThis.Alpine.$data(root) : null;
      if (!data || typeof globalThis.lotHandler !== "function") return { supported: false };
      const result = await globalThis.lotHandler({
        search: targetLot,
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
      const lots = Array.isArray(result?.response?.lots) ? result.response.lots : [];
      const source = lots.find((lot) => normalize(lot.lot_no || lot.lotno || lot.lot_number) === targetLot) || null;
      const found = source ? {
        lot_no: source.lot_no || source.lotno || source.lot_number,
        encrypt_id: source.encrypt_id || "",
        encrypt_day_id: source.encrypt_day_id || data.encrypt_day_id || "",
        date_info: { end_lot_time: source.date_info?.end_lot_time || source.end_lot_time || "" },
        end_lot_time: source.end_lot_time || "",
        lot_ended: source.lot_ended,
        status: source.status || "",
        url_description: source.url_description || "",
        description: source.description || source.short_desc || source.lot_desc || ""
      } : null;
      return {
        supported: true,
        success: Boolean(result?.success),
        auctionEnded: Boolean(result?.response?.auction_ended || result?.response?.is_ended),
        auctionId: data.encrypt_auction_id || "",
        dayId: data.encrypt_day_id || "",
        origin: location.origin,
        found
      };
    }, normalizeLot(lotNumber));
  }

  async timedAuction(auction) {
    const page = await this.pageFor(auction.auctionKey, auction.url);
    await this.waitForCatalogue(page);
    const context = await this.catalogueContext(page);
    const lots = [];
    for (const watched of auction.lots) {
      let result = await this.lookupWithPageData(page, watched.lot).catch(() => ({ supported: false }));
      let found = null;
      if (result.supported && result.success && result.found) {
        found = normalizeTimedLot(result.found, {
          lot: watched.lot,
          origin: new URL(auction.url).origin,
          dayId: result.dayId || auction.dayId,
          url: watched.url,
          description: watched.description
        });
      }
      const needsExactStatus = !found || (!found.confirmedEnded && !found.ended && !Number.isFinite(found.deadlineMs));
      if (needsExactStatus && watched.url) {
        const exactWatch = {
          ...watched,
          url: found?.url || watched.url
        };
        const exact = await this.browserTimedLot(page, exactWatch, auction).catch(() => null) ||
          await this.staticTimedLot(page.context(), exactWatch, auction).catch(() => null);
        if (exact) found = {
          ...found,
          ...exact,
          description: exact.description || found?.description || watched.description,
          url: exact.url || found?.url || watched.url
        };
      }
      lots.push(found || {
        lot: watched.lot,
        deadlineMs: null,
        confirmedEnded: false,
        ended: false,
        awaitingStart: true,
        description: watched.description,
        url: watched.url || auction.url,
        unavailable: !result.supported || !result.success
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const label = context.label || auction.label;
    const retentionEnded = this.timedRetentionEnded(label, lots);
    return {
      mode: "timed",
      label,
      auctionEnded: Boolean(context.ended || retentionEnded),
      terminalReason: retentionEnded ? "historic-timed-retention" : context.ended ? "auction-ended" : "",
      startsAtMs: parseEasyLiveTime(context.startsAt),
      bidLiveUrl: context.bidLiveUrl,
      lots
    };
  }

  async browserTimedLot(page, watched, auction = {}) {
    const targetLot = normalizeLot(watched.lot);
    const result = await page.evaluate(async ({ targetLot, watchedUrl, catalogueUrl }) => {
      const normalize = (value) => String(value || "").trim()
        .replace(/^lot\s*(?:no\.?\s*)?/i, "").replace(/\s+/g, "").toUpperCase();
      const lotFrom = (value) => normalize(String(value || "")
        .match(/\bLot\s*(?:No\.?\s*)?([A-Za-z0-9][A-Za-z0-9._\/-]*)/i)?.[1] || "");
      const candidates = [];
      if (/\/catalogue\/lot\//i.test(watchedUrl)) candidates.push(watchedUrl);
      if (catalogueUrl) {
        const searchUrl = new URL(catalogueUrl, location.href);
        searchUrl.search = "";
        searchUrl.searchParams.set("searchTerm", targetLot);
        searchUrl.searchParams.set("searchOption", "2");
        candidates.push(searchUrl.href);
      }
      if (watchedUrl && !/\/catalogue\/lot\//i.test(watchedUrl)) candidates.push(watchedUrl);

      for (const url of Array.from(new Set(candidates))) {
        const response = await fetch(url, { credentials: "include", cache: "no-store", redirect: "follow" });
        if (!response.ok) continue;
        const html = await response.text();
        const documentCopy = new DOMParser().parseFromString(html, "text/html");
        const exactHeading = Array.from(documentCopy.querySelectorAll(".lot-no"))
          .find((element) => lotFrom(element.textContent) === targetLot);
        if (!exactHeading) continue;
        const resolvedUrl = response.url || url;
        const lotId = String(
          html.match(/refreshTimedBidding\s*\(\s*["']([^"']+)/i)?.[1] ||
          documentCopy.querySelector("#lotID")?.value ||
          resolvedUrl.match(/\/catalogue\/lot\/([^/]+)/i)?.[1] || ""
        ).trim();
        const description = String(documentCopy.querySelector(".lot-desc-h1")?.textContent || "")
          .replace(/\s+/g, " ").trim();
        if (!lotId) continue;
        const statusUrl = new URL("/components/catalogue_components.cfc?method=doRefreshTimedBidding", resolvedUrl);
        const statusResponse = await fetch(statusUrl.href, {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body: new URLSearchParams({ data: JSON.stringify({ lot: lotId }) }).toString()
        });
        if (!statusResponse.ok) continue;
        const raw = (await statusResponse.text()).replace(/^\s*\/\/\s*/, "");
        return { lotId, description, resolvedUrl, status: JSON.parse(raw) };
      }
      return null;
    }, {
      targetLot,
      watchedUrl: String(watched.url || ""),
      catalogueUrl: String(auction.url || "")
    });
    if (!result?.status) return null;
    const status = result.status;
    const confirmedEnded = status.ended === true || Number(status.ended) === 1 ||
      /^(?:ended|closed|finished|complete|completed)$/i.test(String(status.endTime || "").trim());
    const secondsLeft = Number(status.secondsLeft);
    const deadlineMs = !confirmedEnded && Number.isFinite(secondsLeft) && secondsLeft > 0
      ? Date.now() + secondsLeft * 1000 : parseEasyLiveTime(status.dateEnd);
    return {
      lot: targetLot,
      lotId: result.lotId,
      deadlineMs,
      confirmedEnded,
      ended: confirmedEnded || (Number.isFinite(deadlineMs) && deadlineMs <= Date.now()),
      awaitingStart: !confirmedEnded && !Number.isFinite(deadlineMs),
      description: result.description || watched.description || "",
      url: result.resolvedUrl || watched.url || auction.url || ""
    };
  }

  timedRetentionEnded(label, lots, now = Date.now()) {
    const labelDateMs = parseAuctionLabelDate(label);
    const noActiveDeadline = lots.length > 0 && lots.every((lot) =>
      (lot.deadlineMs === null || lot.deadlineMs === undefined || lot.deadlineMs === "" ||
        !Number.isFinite(Number(lot.deadlineMs))) && (lot.awaitingStart || lot.unavailable)
    );
    return noActiveDeadline && Number.isFinite(labelDateMs) &&
      now >= labelDateMs + TIMED_AUCTION_RETENTION_MS;
  }

  async staticTimedLot(context, watched, auction = {}) {
    const targetLot = normalizeLot(watched.lot);
    const catalogueUrl = String(auction.url || "");
    let response = null;
    let html = "";

    const load = async (url) => {
      if (!url) return false;
      const candidate = await context.request.get(url, { timeout: this.navigationTimeoutMs });
      if (!candidate.ok()) throw new Error(`Lot page returned ${candidate.status()}.`);
      const candidateHtml = await candidate.text();
      const candidateLot = this.staticLotNumber(candidateHtml);
      if (candidateLot !== targetLot) return false;
      response = candidate;
      html = candidateHtml;
      return true;
    };

    const watchedUrl = String(watched.url || "");
    const watchedIsIndividual = /\/catalogue\/lot\//i.test(watchedUrl);
    let exact = watchedIsIndividual && await load(watchedUrl);
    if (!exact && catalogueUrl) {
      const searchUrl = new URL(catalogueUrl);
      searchUrl.search = "";
      searchUrl.searchParams.set("searchTerm", targetLot);
      searchUrl.searchParams.set("searchOption", "2");
      exact = await load(searchUrl.href);
    }
    if (!exact && watchedUrl && !watchedIsIndividual) exact = await load(watchedUrl);
    if (!exact || !response) return null;

    const resolvedUrl = typeof response.url === "function" ? response.url() : watchedUrl || catalogueUrl;
    const lotId = String(
      html.match(/refreshTimedBidding\s*\(\s*["']([^"']+)/i)?.[1] ||
      resolvedUrl.match(/\/catalogue\/lot\/([^/]+)/i)?.[1] || ""
    ).trim();
    const description = String(html.match(/<h1[^>]*class=["'][^"']*lot-desc-h1[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1] || watched.description || "")
      .replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#x20;/gi, " ").replace(/\s+/g, " ").trim();

    if (lotId) {
      const statusUrl = new URL("/components/catalogue_components.cfc?method=doRefreshTimedBidding", resolvedUrl).href;
      const statusResponse = await context.request.post(statusUrl, {
        timeout: this.navigationTimeoutMs,
        form: { data: JSON.stringify({ lot: lotId }) }
      }).catch(() => null);
      if (statusResponse?.ok()) {
        const raw = (await statusResponse.text()).replace(/^\s*\/\/\s*/, "");
        const status = JSON.parse(raw);
        const confirmedEnded = status.ended === true || Number(status.ended) === 1 ||
          /^(?:ended|closed|finished|complete|completed)$/i.test(String(status.endTime || "").trim());
        const secondsLeft = Number(status.secondsLeft);
        const deadlineMs = !confirmedEnded && Number.isFinite(secondsLeft) && secondsLeft > 0
          ? Date.now() + secondsLeft * 1000 : parseEasyLiveTime(status.dateEnd);
        return {
          lot: targetLot,
          lotId,
          deadlineMs,
          confirmedEnded,
          ended: confirmedEnded || (Number.isFinite(deadlineMs) && deadlineMs <= Date.now()),
          awaitingStart: !confirmedEnded && !Number.isFinite(deadlineMs),
          description,
          url: resolvedUrl
        };
      }
    }

    const deadlineMatch = html.match(/(?:end_lot_time|data-end-time|datetime)[^>:=]*[>:=]["']?([^"'<}\n]+)/i);
    const ended = /\b(?:bidding closed|lot ended|lot closed|lot finished|auction ended|sale ended|sold for)\b/i.test(html);
    return {
      lot: targetLot,
      lotId,
      deadlineMs: parseEasyLiveTime(deadlineMatch?.[1]?.trim()),
      confirmedEnded: ended,
      ended,
      awaitingStart: !ended && !deadlineMatch,
      description,
      url: resolvedUrl
    };
  }

  staticLotNumber(html) {
    const lotHeading = String(html || "").match(/<h[1-6][^>]*class=["'][^"']*\blot-no\b[^"']*["'][^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1] || "";
    const text = lotHeading.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#x20;/gi, " ").replace(/\s+/g, " ").trim();
    return normalizeLot(text.match(/\bLot\s*(?:No\.?\s*)?([A-Za-z0-9][A-Za-z0-9._\/-]*)/i)?.[1] || "");
  }

  async catalogueOrder(page, context) {
    const result = await page.evaluate(async () => {
      const normalize = (value) => String(value || "").trim().replace(/^lot\s*(?:no\.?\s*)?/i, "").replace(/\s+/g, "").toUpperCase();
      const root = document.querySelector('[x-data="auctions"]');
      const data = root && globalThis.Alpine?.$data ? globalThis.Alpine.$data(root) : null;
      if (!data || typeof globalThis.lotHandler !== "function") {
        return Array.from(document.querySelectorAll('.grid-lot .lot-no, .grid-lot h4, a[href*="/catalogue/lot/"]'))
          .map((element) => normalize(element.textContent.match(/Lot\s+(?:No\.?\s*)?([A-Za-z0-9._\/-]+)/i)?.[1])).filter(Boolean);
      }
      const response = await globalThis.lotHandler({
        search: "", category: "all", sortby: "lotno", pagination: { pageNo: 1, perPage: 2000 },
        page_type: data.page_type || "auction", soldStatus: "", lotNoSearch: false,
        auctionID: data.encrypt_auction_id, dayID: data.encrypt_day_id, historic: ""
      });
      return Array.from(response?.response?.lots || []).map((lot) => normalize(lot.lot_no || lot.lotno || lot.lot_number)).filter(Boolean);
    }).catch(() => []);
    return Array.from(new Set(result));
  }

  async liveAuction(auction) {
    const directLiveUrl = isBidLiveUrl(auction.url) ? auction.url : "";
    let context = { label: auction.label, ended: false, bidLiveUrl: "", startsAt: null, startsAtMs: null };
    let catalogueOrder = [];
    let cataloguePage = null;
    const catalogueUrl = directLiveUrl ? catalogueUrlFromLive(directLiveUrl) : auction.url;
    if (catalogueUrl) {
      cataloguePage = await this.pageFor(`${auction.auctionKey}:catalogue`, catalogueUrl);
      await this.waitForCatalogue(cataloguePage);
      context = await this.catalogueContext(cataloguePage);
      catalogueOrder = await this.catalogueOrder(cataloguePage, context);
    }
    const bidLiveUrl = directLiveUrl || auction.bidLiveUrl || context.bidLiveUrl;
    const hasContextStart = context.startsAtMs !== null && context.startsAtMs !== undefined && context.startsAtMs !== "";
    const startsAtMs = hasContextStart && Number.isFinite(Number(context.startsAtMs))
      ? Number(context.startsAtMs) : parseEasyLiveTime(context.startsAt);
    const retentionEnded = Number.isFinite(startsAtMs) && Date.now() - startsAtMs > LIVE_AUCTION_RETENTION_MS;
    if (/^(?:T|TIMED)$/i.test(context.type || "")) {
      const exactLots = [];
      for (const watched of auction.lots || []) {
        const lot = watched.url && cataloguePage
          ? await this.browserTimedLot(cataloguePage, watched, auction).catch(() => null) ||
            await this.staticTimedLot(cataloguePage.context(), watched, auction).catch(() => null) : null;
        if (lot) exactLots.push(lot);
      }
      const allEnded = exactLots.length === (auction.lots || []).length && exactLots.length > 0 &&
        exactLots.every((lot) => lot.confirmedEnded || lot.ended);
      return {
        mode: "live", misclassifiedMode: "timed", label: context.label || auction.label,
        scheduled: !allEnded, auctionEnded: Boolean(context.ended || retentionEnded || allEnded),
        currentLot: "", startsAtMs, bidLiveUrl: "", order: catalogueOrder, lots: exactLots
      };
    }
    if (!bidLiveUrl) {
      return {
        mode: "live", label: context.label || auction.label, scheduled: true,
        auctionEnded: Boolean(context.ended || retentionEnded), currentLot: "", startsAtMs, order: catalogueOrder
      };
    }
    const livePage = await this.pageFor(`${auction.auctionKey}:live`, bidLiveUrl);
    await livePage.waitForLoadState("domcontentloaded");
    await livePage.waitForFunction(() => {
      const state = globalThis.elaLive;
      return Boolean(state?.Auction?.datastream && state?.Bidder?.token && state?.Lots?.length);
    }, null, { timeout: 20000 }).catch(() => null);
    const live = await livePage.evaluate(() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const lotFrom = (value) => normalize(value).match(/(?:^|\b)Lot\s*(?:No\.?\s*)?([A-Za-z0-9][A-Za-z0-9._\/-]*)/i)?.[1] || "";
      const selectors = ["#bid-live-lot-no .lot-list-popup", "#bid-live-lot-no a", "#bid-live-lot-no"];
      const current = selectors.map((selector) => document.querySelector(selector)).find(Boolean);
      const pageText = document.body?.textContent || "";
      const liveState = globalThis.elaLive || {};
      const currentState = liveState.CurrentLot || {};
      const auctionState = liveState.Auction || {};
      const stateLot = normalize(currentState.lotno || currentState.lot_no || currentState.lot_number || "");
      const stateStatus = normalize(auctionState.status || auctionState.state || auctionState.auction_status || "");
      const hasStartedValue = auctionState.has_started;
      const order = Array.from(document.querySelectorAll(
        "#bid-live-lot-section .lot-list-popup, #bid-live-lot-section-more .lot-list-popup"
      )).map((element) => lotFrom(element.textContent)).filter(Boolean);
      return {
        currentLot: lotFrom(current?.textContent || ""),
        stateLot,
        wsURL: String(globalThis.wsURL || ""),
        auctionToken: String(globalThis.theAuction || ""),
        datastream: String(auctionState.datastream || ""),
        bidderToken: String(liveState.Bidder?.token || ""),
        hasStartedKnown: hasStartedValue !== undefined && hasStartedValue !== null && hasStartedValue !== "",
        hasStarted: hasStartedValue === true || Number(hasStartedValue) === 1 || /^true$/i.test(String(hasStartedValue)),
        lots: Array.from(liveState.Lots || []).map((lot) => ({
          lot_id: String(lot?.lot_id || lot?.id || ""),
          lotno: String(lot?.lotno || lot?.lot_no || lot?.lot_number || "")
        })),
        label: normalize(document.querySelector("#bid-live-title strong, #auction-info h4 strong, #bid-live-title")?.textContent || document.title),
        ended: /\b(?:this\s+)?(?:auction|sale)\s+(?:has\s+|is\s+)?(?:ended|closed|finished|complete)\b/i.test(pageText) ||
          /^(?:ended|closed|finished|complete|completed)$/i.test(stateStatus),
        order
      };
    });
    let currentLot = normalizeLot(live.currentLot || live.stateLot);
    let currentLotSource = currentLot ? "page" : "";
    const feedShouldBeActive = liveFeedExpected(
      startsAtMs, Date.now(), LIVE_FEED_START_GRACE_MS, context.ended || live.ended || retentionEnded
    );
    const socketShouldBeActive = !live.ended && (live.hasStarted || feedShouldBeActive);
    if (live.hasStartedKnown && !live.hasStarted && !feedShouldBeActive) {
      currentLot = "";
      currentLotSource = "";
    }
    if (!currentLot && socketShouldBeActive) {
      currentLot = normalizeLot(await requestCurrentLiveLot({
        wsURL: live.wsURL,
        auction: live.auctionToken,
        datastream: live.datastream,
        token: live.bidderToken,
        lots: live.lots
      }).catch(() => ""));
      if (currentLot) currentLotSource = "socket";
    }
    if (feedShouldBeActive && !currentLot) {
      throw new Error("Live auction has started but the current lot feed is unavailable.");
    }
    return {
      mode: "live",
      label: live.label || context.label || auction.label,
      scheduled: !currentLot && !live.ended,
      auctionEnded: Boolean(context.ended || live.ended || retentionEnded),
      currentLot,
      currentLotSource,
      startsAtMs,
      bidLiveUrl,
      order: catalogueOrder.length ? catalogueOrder : Array.from(new Set(live.order.map(normalizeLot)))
    };
  }
}
