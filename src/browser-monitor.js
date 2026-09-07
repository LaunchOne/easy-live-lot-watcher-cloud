import { chromium } from "playwright";
import { isBidLiveUrl, normalizeLot, normalizeTimedLot, parseEasyLiveTime } from "./easy-live.js";

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
      return {
        auctionId: clean(data?.encrypt_auction_id || route?.[1]),
        dayId: clean(data?.encrypt_day_id || route?.[2]),
        label: clean(data?.auction_info?.short_desc || document.querySelector("h1")?.textContent || document.title),
        type: clean(data?.auction_info?.type || data?.auction_type),
        startsAt: data?.auction_info?.start_date || data?.auction_info?.auction_date || null,
        ended: Boolean(data?.auction_ended || data?.is_ended || data?.auction_info?.ended ||
          /\b(?:this\s+)?(?:auction|sale)\s+(?:has\s+|is\s+)?(?:ended|closed|finished|complete)\b/i.test(document.body?.textContent || "")),
        bidLiveUrl: liveLink ? new URL(liveLink.getAttribute("href"), location.href).href : "",
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
      } else if (watched.url) {
        found = await this.staticTimedLot(page.context(), watched).catch(() => null);
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
    return {
      mode: "timed",
      label: context.label || auction.label,
      auctionEnded: context.ended,
      startsAtMs: parseEasyLiveTime(context.startsAt),
      bidLiveUrl: context.bidLiveUrl,
      lots
    };
  }

  async staticTimedLot(context, watched) {
    const response = await context.request.get(watched.url, { timeout: this.navigationTimeoutMs });
    if (!response.ok()) throw new Error(`Lot page returned ${response.status()}.`);
    const html = await response.text();
    const deadlineMatch = html.match(/(?:end_lot_time|data-end-time|datetime)[^>:=]*[>:=]["']?([^"'<}\n]+)/i);
    const ended = /\b(?:bidding closed|lot ended|lot closed|lot finished)\b/i.test(html);
    return {
      lot: watched.lot,
      deadlineMs: parseEasyLiveTime(deadlineMatch?.[1]?.trim()),
      confirmedEnded: ended,
      ended,
      awaitingStart: !ended && !deadlineMatch,
      description: watched.description,
      url: watched.url
    };
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
    let context = { label: auction.label, ended: false, bidLiveUrl: "" };
    let catalogueOrder = [];
    if (!directLiveUrl) {
      const cataloguePage = await this.pageFor(`${auction.auctionKey}:catalogue`, auction.url);
      await this.waitForCatalogue(cataloguePage);
      context = await this.catalogueContext(cataloguePage);
      catalogueOrder = await this.catalogueOrder(cataloguePage, context);
    }
    const bidLiveUrl = directLiveUrl || auction.bidLiveUrl || context.bidLiveUrl;
    if (!bidLiveUrl) {
      return { mode: "live", label: context.label || auction.label, scheduled: true, auctionEnded: context.ended, currentLot: "", order: catalogueOrder };
    }
    const livePage = await this.pageFor(`${auction.auctionKey}:live`, bidLiveUrl);
    await livePage.waitForLoadState("domcontentloaded");
    const live = await livePage.evaluate(() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const lotFrom = (value) => normalize(value).match(/(?:^|\b)Lot\s*(?:No\.?\s*)?([A-Za-z0-9][A-Za-z0-9._\/-]*)/i)?.[1] || "";
      const selectors = ["#bid-live-lot-no .lot-list-popup", "#bid-live-lot-no a", "#bid-live-lot-no"];
      const current = selectors.map((selector) => document.querySelector(selector)).find(Boolean);
      const pageText = document.body?.textContent || "";
      const order = Array.from(document.querySelectorAll(
        "#bid-live-lot-section .lot-list-popup, #bid-live-lot-section-more .lot-list-popup"
      )).map((element) => lotFrom(element.textContent)).filter(Boolean);
      return {
        currentLot: lotFrom(current?.textContent || ""),
        label: normalize(document.querySelector("#bid-live-title strong, #auction-info h4 strong, #bid-live-title")?.textContent || document.title),
        ended: /\b(?:this\s+)?(?:auction|sale)\s+(?:has\s+|is\s+)?(?:ended|closed|finished|complete)\b/i.test(pageText),
        order
      };
    });
    return {
      mode: "live",
      label: live.label || context.label || auction.label,
      scheduled: !live.currentLot && !live.ended,
      auctionEnded: Boolean(context.ended || live.ended),
      currentLot: normalizeLot(live.currentLot),
      bidLiveUrl,
      order: catalogueOrder.length ? catalogueOrder : Array.from(new Set(live.order.map(normalizeLot)))
    };
  }
}
