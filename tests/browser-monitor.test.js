import test from "node:test";
import assert from "node:assert/strict";
import { BrowserMonitor } from "../src/browser-monitor.js";

function htmlForLot(lot, lotId, description = "Test lot") {
  return `
    <h4 class="blue-text lot-no">
      <div><strong>Lot</strong></div><div><strong>${lot}</strong></div>
    </h4>
    <h1 class="lot-desc-h1">${description}</h1>
    <script>refreshTimedBidding('${lotId}', true);</script>
  `;
}

function response({ url, body, ok = true, status = 200 }) {
  return {
    ok: () => ok,
    status: () => status,
    url: () => url,
    text: async () => body
  };
}

test("static timed lookup repairs a mismatched saved lot URL and reads explicit ended state", async () => {
  const monitor = new BrowserMonitor();
  const catalogueUrl = "https://www.easyliveauction.com/catalogue/AUCTION/DAY/sale/";
  const wrongUrl = "https://www.easyliveauction.com/catalogue/lot/LOT303/DAY/sale-lot-303/";
  const exactUrl = "https://www.easyliveauction.com/catalogue/lot/LOT302/DAY/sale-lot-302/";
  const gets = [];
  const posts = [];
  const context = {
    request: {
      async get(url) {
        gets.push(url);
        if (url === wrongUrl) return response({ url, body: htmlForLot("303", "LOT303") });
        assert.match(url, /searchTerm=302/);
        assert.match(url, /searchOption=2/);
        return response({ url: exactUrl, body: htmlForLot("302", "LOT302", "Recovered lot") });
      },
      async post(url, options) {
        posts.push({ url, options });
        return response({
          url,
          body: '//{"ended":1,"endTime":"Finished","secondsLeft":0,"dateEnd":"September, 14 2026 12:48:10"}'
        });
      }
    }
  };

  const lot = await monitor.staticTimedLot(context, { lot: "302", url: wrongUrl }, { url: catalogueUrl });

  assert.equal(gets.length, 2);
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].options.form.data).lot, "LOT302");
  assert.equal(lot.lot, "302");
  assert.equal(lot.url, exactUrl);
  assert.equal(lot.description, "Recovered lot");
  assert.equal(lot.confirmedEnded, true);
  assert.equal(lot.ended, true);
  assert.equal(lot.awaitingStart, false);
});

test("static timed lookup uses the exact countdown service for an active lot", async () => {
  const monitor = new BrowserMonitor();
  const lotUrl = "https://www.easyliveauction.com/catalogue/lot/LOT10/DAY/sale-lot-10/";
  const before = Date.now();
  const context = {
    request: {
      async get(url) { return response({ url, body: htmlForLot("10", "LOT10") }); },
      async post(url) {
        return response({
          url,
          body: '//{"ended":0,"endTime":"1 hour","secondsLeft":3600,"dateEnd":"September, 20 2026 12:00:00"}'
        });
      }
    }
  };

  const lot = await monitor.staticTimedLot(context, { lot: "10", url: lotUrl }, { url: "" });

  assert.equal(lot.confirmedEnded, false);
  assert.equal(lot.ended, false);
  assert.ok(lot.deadlineMs >= before + 3_599_000);
  assert.equal(lot.awaitingStart, false);
});

test("timed catalogue lots with no deadline are enriched from the exact countdown service", async () => {
  const monitor = new BrowserMonitor();
  const page = { context: () => ({ request: {} }) };
  const lotUrl = "https://www.easyliveauction.com/catalogue/lot/LOT298/DAY/sale-lot-298/";
  monitor.pageFor = async () => page;
  monitor.waitForCatalogue = async () => {};
  monitor.catalogueContext = async () => ({ label: "Current timed sale", ended: false });
  monitor.lookupWithPageData = async () => ({
    supported: true,
    success: true,
    dayId: "DAY",
    found: {
      lot_no: "298",
      encrypt_id: "LOT298",
      encrypt_day_id: "DAY",
      end_lot_time: "",
      description: "Catalogue result without a deadline"
    }
  });
  let exactLookup = null;
  monitor.staticTimedLot = async (_context, watched) => {
    exactLookup = watched;
    return {
      lot: "298",
      lotId: "LOT298",
      deadlineMs: Date.now() + 3_600_000,
      confirmedEnded: false,
      ended: false,
      awaitingStart: false,
      description: "Exact status result",
      url: lotUrl
    };
  };

  const snapshot = await monitor.timedAuction({
    auctionKey: "timed-sale",
    mode: "timed",
    label: "Current timed sale",
    url: "https://www.easyliveauction.com/catalogue/AUCTION/DAY/sale/",
    lots: [{ lot: "298", url: lotUrl, description: "Saved lot" }]
  });

  assert.equal(exactLookup.url, lotUrl);
  assert.equal(snapshot.lots[0].awaitingStart, false);
  assert.ok(snapshot.lots[0].deadlineMs > Date.now());
  assert.equal(snapshot.lots[0].description, "Exact status result");
});

test("historic timed catalogue retention requires both an old sale date and no active deadlines", () => {
  const monitor = new BrowserMonitor();
  const now = Date.UTC(2026, 8, 17, 9);
  assert.equal(monitor.timedRetentionEnded(
    "Unclaimed Airport Lost Property (14 Sep 26)",
    [{ lot: "302", deadlineMs: null, awaitingStart: true, unavailable: true }],
    now
  ), true);
  assert.equal(monitor.timedRetentionEnded(
    "Future sale (20 Sep 26)",
    [{ lot: "10", deadlineMs: null, awaitingStart: true, unavailable: true }],
    now
  ), false);
  assert.equal(monitor.timedRetentionEnded(
    "Old sale (14 Sep 26)",
    [{ lot: "10", deadlineMs: now + 60_000, awaitingStart: false, unavailable: false }],
    now
  ), false);
});
