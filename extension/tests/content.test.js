"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Core = require("../core.js");

function loadCatalogueContent(storageState, url = "https://auctions.example.com/catalogue/auction-live/DAY1/example-sale/") {
  const pageMessages = [];
  const windowListeners = {};
  const runtimeListeners = [];
  const location = new URL(url);
  const sandbox = {
    console,
    Date,
    URL,
    EasyLiveWatchCore: Core,
    location: { href: location.href, origin: location.origin, pathname: location.pathname },
    document: { documentElement: {}, addEventListener() {} },
    chrome: {
      storage: {
        local: {
          async get(keys) {
            return Object.fromEntries((keys || []).filter((key) => key in storageState).map((key) => [key, storageState[key]]));
          }
        },
        onChanged: { addListener() {} }
      },
      runtime: {
        async sendMessage(message) { pageMessages.push(message); return { ok: true }; },
        onMessage: { addListener(listener) { runtimeListeners.push(listener); } }
      }
    },
    addEventListener(type, listener) { windowListeners[type] = listener; },
    postMessage() {},
    setInterval() { return 1; },
    setTimeout(callback) { Promise.resolve().then(callback); return 1; },
    clearTimeout() {}
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const source = fs.readFileSync(path.resolve(__dirname, "../content.js"), "utf8");
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  function dispatchSnapshot(payload) {
    sandbox.__snapshotPayload = payload;
    sandbox.__messageListener = windowListeners.message;
    vm.runInContext(`__messageListener({
      source: window,
      data: { source: "easy-live-lot-watcher", type: "TIMED_SNAPSHOT", payload: __snapshotPayload }
    })`, context);
  }
  return { pageMessages, windowListeners, runtimeListeners, sandbox, dispatchSnapshot };
}

test("a pre-live catalogue uses the same live auction key as its Bid Live page", async () => {
  const auctionKey = "https://auctions.example.com::auction-live";
  const harness = loadCatalogueContent({
    settings: { defaultLiveStages: [5] },
    auctionConfigs: {
      [auctionKey]: { lots: ["42"], lotOptions: { "42": { stages: [5] } } }
    },
    timedAuctionConfigs: {},
    liveAlertedStages: {},
    alertedLots: {},
    timedAlertedStages: {}
  });

  harness.dispatchSnapshot({
        bridgeVersion: 7,
        auctionMode: "live",
        auctionId: "AUCTION-LIVE",
        liveAuctionId: "auction-live",
        pageKind: "catalogue",
        pageUrl: harness.sandbox.location.href,
        auctionLabel: "Example scheduled webcast",
        startsAtMs: Date.now() + 86400000,
        lookupState: "ready",
        lots: [{ lot: "42", description: "Watched live lot", source: "catalogue-page" }]
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const status = harness.pageMessages.filter((message) => message.type === "PAGE_STATUS").at(-1).payload;
  assert.equal(status.mode, "live");
  assert.equal(status.livePhase, "scheduled");
  assert.equal(status.auctionKey, auctionKey);
  assert.equal(status.watched[0].state, "scheduled");
  assert.match(status.watched[0].statusText, /Live auction starts/);
});

test("a new live sale is not merged with an old sale that reuses the auction-house route id", async () => {
  const currentUrl = "https://auctions.example.com/catalogue/NEW-LIVE/HOUSE-ID/current-sale/";
  const oldKey = "https://auctions.example.com::OLD-LIVE";
  const harness = loadCatalogueContent({
    settings: { defaultLiveStages: [5] },
    auctionConfigs: {
      [oldKey]: {
        auctionId: "OLD-LIVE",
        dayId: "HOUSE-ID",
        url: "https://auctions.example.com/bid-live/OLD-LIVE/HOUSE-ID/old-sale/",
        lots: ["900"]
      }
    },
    timedAuctionConfigs: {}, liveAlertedStages: {}, alertedLots: {}, timedAlertedStages: {}
  }, currentUrl);

  harness.dispatchSnapshot({
    bridgeVersion: 11,
    auctionMode: "live",
    auctionId: "NEW-LIVE",
    liveAuctionId: "NEW-LIVE",
    pageKind: "catalogue",
    pageUrl: currentUrl,
    auctionLabel: "Current live sale",
    startsAtMs: Date.now() - 60000,
    lookupState: "ready",
    lots: [{ lot: "42", description: "Current sale lot", source: "catalogue-page" }]
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const status = harness.pageMessages.filter((message) => message.type === "PAGE_STATUS").at(-1).payload;
  assert.equal(status.auctionKey, "https://auctions.example.com::NEW-LIVE");
  assert.notEqual(status.auctionKey, oldKey);
});

test("a timed catalogue recovers a watch that an older detector saved as live", async () => {
  const catalogueUrl = "https://auctions.example.com/catalogue/AUCTION-TIMED/DAY1/timed-sale/";
  const legacyKey = "https://auctions.example.com::AUCTION-TIMED";
  const harness = loadCatalogueContent({
    settings: { defaultTimedStagesSeconds: [180] },
    auctionConfigs: {
      [legacyKey]: {
        mode: "live", auctionId: "AUCTION-TIMED", dayId: "DAY1", url: catalogueUrl,
        lots: ["115"], lotOptions: { "115": { stages: [5], importedFromAccount: true } }
      }
    },
    timedAuctionConfigs: {}, liveAlertedStages: {}, alertedLots: {}, timedAlertedStages: {}
  }, catalogueUrl);

  harness.dispatchSnapshot({
    bridgeVersion: 12, auctionMode: "timed", auctionId: "AUCTION-TIMED",
    pageKind: "catalogue", pageUrl: catalogueUrl, auctionLabel: "Timed auction",
    lookupState: "ready", auctionEnded: true,
    lots: [{ lot: "115", ended: true, confirmedEnded: true, source: "catalogue-page" }]
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const status = harness.pageMessages.filter((message) => message.type === "PAGE_STATUS").at(-1).payload;
  assert.equal(status.mode, "timed");
  assert.equal(status.legacyLiveAuctionKey, legacyKey);
  assert.equal(status.watched[0].targetLot, "115");
  assert.equal(status.watched[0].state, "ended");
});

test("a future timed lot remains not started when no deadline is available", async () => {
  const auctionKey = "https://auctions.example.com::timed::TIMED-FUTURE";
  const harness = loadCatalogueContent({
    settings: { defaultTimedStagesSeconds: [180] },
    auctionConfigs: {},
    timedAuctionConfigs: {
      [auctionKey]: { lots: ["88"], lotOptions: { "88": { stagesSeconds: [180] } } }
    },
    liveAlertedStages: {},
    alertedLots: {},
    timedAlertedStages: {}
  }, "https://auctions.example.com/catalogue/TIMED-FUTURE/DAY1/future-sale/");

  harness.dispatchSnapshot({
        bridgeVersion: 7,
        auctionMode: "timed",
        auctionId: "TIMED-FUTURE",
        pageKind: "catalogue",
        pageUrl: harness.sandbox.location.href,
        auctionLabel: "Future timed sale",
        startsAtMs: Date.now() + 86400000,
        lookupState: "ready",
        lots: [{ lot: "88", deadlineMs: null, awaitingStart: true, ended: false, source: "catalogue-page" }]
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const status = harness.pageMessages.filter((message) => message.type === "PAGE_STATUS").at(-1).payload;
  assert.equal(status.mode, "timed");
  assert.equal(status.watched[0].state, "not-started");
  assert.match(status.watched[0].statusText, /Auction starts/);
  assert.equal(status.monitoringComplete, false);
});

test("a timed watch list survives reload when the page reports an alternate auction id", async () => {
  const savedKey = "https://auctions.example.com::timed::DATA-AUCTION-ID";
  const catalogueUrl = "https://auctions.example.com/catalogue/route-auction-id/DAY1/timed-sale/";
  const harness = loadCatalogueContent({
    settings: { defaultTimedStagesSeconds: [180] },
    auctionConfigs: {},
    timedAuctionConfigs: {
      [savedKey]: {
        auctionId: "DATA-AUCTION-ID",
        url: catalogueUrl,
        lots: ["125"],
        lotOptions: { "125": { stagesSeconds: [180] } }
      }
    },
    liveAlertedStages: {},
    alertedLots: {},
    timedAlertedStages: {}
  }, catalogueUrl);

  harness.dispatchSnapshot({
    bridgeVersion: 7,
    auctionMode: "timed",
    auctionId: "ROUTE-AUCTION-ID",
    pageKind: "catalogue",
    pageUrl: catalogueUrl,
    auctionLabel: "Reloaded timed sale",
    lookupState: "ready",
    lots: [{
      lot: "125",
      deadlineMs: Date.now() + 3600000,
      ended: false,
      source: "catalogue-page"
    }]
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const status = harness.pageMessages.filter((message) => message.type === "PAGE_STATUS").at(-1).payload;
  assert.equal(status.auctionKey, savedKey);
  assert.equal(status.watched.length, 1);
  assert.equal(status.watched[0].targetLot, "125");
  assert.equal(status.watched[0].state, "upcoming");
});

test("a timed watch list survives an individual-lot page refresh before catalogue data is ready", async () => {
  const savedKey = "https://auctions.example.com::timed::AUCTION-ABC";
  const lotUrl = "https://auctions.example.com/catalogue/lot/LOT-125/DAY-ABC/example-lot/";
  const harness = loadCatalogueContent({
    settings: { defaultTimedStagesSeconds: [180] },
    auctionConfigs: {},
    timedAuctionConfigs: {
      [savedKey]: {
        auctionId: "AUCTION-ABC",
        dayId: "DAY-ABC",
        url: lotUrl,
        lots: ["125"],
        lotOptions: { "125": { stagesSeconds: [180] } }
      }
    },
    liveAlertedStages: {},
    alertedLots: {},
    timedAlertedStages: {}
  }, lotUrl);

  harness.dispatchSnapshot({
    bridgeVersion: 9,
    auctionMode: "timed",
    auctionId: "",
    pageKind: "lot",
    pageLot: "125",
    pageUrl: lotUrl,
    auctionLabel: "Reloaded individual lot",
    lookupState: "ready",
    lots: [{ lot: "125", deadlineMs: Date.now() + 3600000, source: "individual-page" }]
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const status = harness.pageMessages.filter((message) => message.type === "PAGE_STATUS").at(-1).payload;
  assert.equal(status.auctionKey, savedKey);
  assert.equal(status.watched.length, 1);
  assert.equal(status.watched[0].targetLot, "125");
  assert.equal(status.diagnostics.routeAuctionId, "");
  assert.equal(status.diagnostics.routeDayId, "DAY-ABC");
  assert.equal(status.diagnostics.resolvedAuctionId, "AUCTION-ABC");
  assert.equal(status.diagnostics.savedConfigFound, true);
});

test("a lot marked Watching on the auction page is offered for one-way account import", async () => {
  const catalogueUrl = "https://auctions.example.com/catalogue/AUTO-WATCH/DAY1/timed-sale/";
  const harness = loadCatalogueContent({
    settings: { accountWatchImportEnabled: true, defaultTimedStagesSeconds: [180] },
    auctionConfigs: {},
    timedAuctionConfigs: {},
    liveAlertedStages: {},
    alertedLots: {},
    timedAlertedStages: {}
  }, catalogueUrl);

  harness.dispatchSnapshot({
    bridgeVersion: 9,
    auctionMode: "timed",
    auctionId: "AUTO-WATCH",
    pageKind: "catalogue",
    pageUrl: catalogueUrl,
    auctionLabel: "Automatic watch import sale",
    lookupState: "ready",
    lots: [{ lot: "77", accountWatched: true, deadlineMs: Date.now() + 3600000, source: "catalogue-page" }]
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const message = harness.pageMessages.find((item) => item.type === "IMPORT_ACCOUNT_WATCHES");
  assert.ok(message);
  assert.equal(message.payload.mode, "timed");
  assert.deepEqual(Array.from(message.payload.lots), ["77"]);
});
