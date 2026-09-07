"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("resolves an off-page watched lot through the catalogue data layer", async () => {
  const listeners = {};
  const snapshots = [];
  const root = {};
  const catalogueData = {
    auction_info: { type: "T", short_desc: "Example timed sale" },
    encrypt_auction_id: "AUCTION1",
    encrypt_day_id: "DAY1",
    page_type: "auction",
    lots: [{
      lot_no: "1",
      encrypt_id: "LOT1",
      encrypt_auction_id: "AUCTION1",
      date_info: { end_lot_time: "20 Aug 2026 12:00:00" },
      description: "Visible lot"
    }]
  };
  class MockXhr {
    addEventListener() {}
  }
  MockXhr.prototype.open = function open() {};
  MockXhr.prototype.send = function send() {};

  const sandbox = {
    console,
    URL,
    URLSearchParams,
    XMLHttpRequest: MockXhr,
    MutationObserver: class { observe() {} },
    location: {
      href: "https://auctions.example.com/catalogue/AUCTION1/DAY1/example-sale/",
      origin: "https://auctions.example.com",
      pathname: "/catalogue/AUCTION1/DAY1/example-sale/"
    },
    document: {
      readyState: "complete",
      documentElement: {},
      title: "Example timed sale",
      querySelector(selector) { return selector === '[x-data="auctions"]' ? root : null; },
      addEventListener() {}
    },
    Alpine: { $data(value) { return value === root ? catalogueData : null; } },
    async lotHandler(filters) {
      assert.equal(filters.search, "42");
      assert.equal(filters.lotNoSearch, true);
      assert.equal(filters.auctionID, "AUCTION1");
      assert.equal(filters.dayID, "DAY1");
      return {
        success: true,
        response: {
          lots: [{
            lot_no: "42",
            encrypt_id: "LOT42",
            encrypt_auction_id: "AUCTION1",
            date_info: { end_lot_time: "20 Aug 2026 12:42:00" },
            description: "Off-page watched lot",
            is_watched: 1,
            url: "/catalogue/lot/LOT42/DAY1/off-page-watched-lot"
          }]
        }
      };
    },
    addEventListener(type, listener) { listeners[type] = listener; },
    postMessage(message) { if (message?.type === "TIMED_SNAPSHOT") snapshots.push(message.payload); },
    setInterval() { return 1; },
    setTimeout(callback) { Promise.resolve().then(callback); return 1; }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const source = fs.readFileSync(path.resolve(__dirname, "../page-bridge.js"), "utf8");
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  sandbox.__messageListener = listeners.message;
  vm.runInContext(`__messageListener({
    source: window,
    data: { source: "easy-live-lot-watcher", type: "SET_TIMED_WATCH_LOTS", payload: { lots: ["42"] } }
  })`, context);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const latest = snapshots.at(-1);
  const watched = latest.lots.find((lot) => lot.lot === "42");
  assert.equal(latest.bridgeVersion, 11);
  assert.equal(latest.lookupState, "ready");
  assert.equal(watched.source, "catalogue-lookup");
  assert.equal(watched.description, "Off-page watched lot");
  assert.equal(watched.accountWatched, true);
  assert.equal(watched.bidUrl, "https://auctions.example.com/catalogue/lot/LOT42/DAY1/off-page-watched-lot");
  assert.equal(sandbox.location.href, "https://auctions.example.com/catalogue/AUCTION1/DAY1/example-sale/");
});

test("detects a server-rendered catalogue and resolves a watched lot through its normal search route", async () => {
  const listeners = {};
  const snapshots = [];
  const visibleAnchor = {
    href: "/catalogue/lot/LOT1/DAY1/example-sale-lot-1/",
    getAttribute(name) { return name === "href" ? this.href : ""; }
  };
  const unrelatedLiveAnchor = {
    href: "/bid-live/OTHER-AUCTION/webcast/other-sale/",
    getAttribute(name) { return name === "href" ? this.href : ""; }
  };
  const visibleCard = {
    textContent: "Lot 1 Visible static lot Ends: 20 Aug",
    querySelector(selector) {
      if (selector === '.catalogue-description h4') return { textContent: "Lot 1" };
      if (selector === 'a[href*="/catalogue/lot/"]') return visibleAnchor;
      if (selector === '.catalogue-description .no-hover p') return { textContent: "Visible static lot" };
      return null;
    }
  };
  const watchingControl = { textContent: "Watching", getAttribute() { return ""; }, className: "" };
  const parsedLotDocument = {
    body: { textContent: "Lot 225 Auction Ends: 20th Aug 26 from 12pm BST Ends: 20 Aug from 12:25 BST" },
    documentElement: { textContent: "" },
    querySelector(selector) {
      if (selector === ".lot-no") return { textContent: "Lot 225" };
      if (selector === "#timedEndTime") return { textContent: "20 Aug from 12:25 BST" };
      if (selector === "#lotID, .lotID") return { value: "LOT225" };
      if (selector === ".lot-description") return { textContent: "Static off-page lot" };
      return null;
    },
    querySelectorAll(selector) { return selector.includes("button") ? [watchingControl] : []; }
  };
  class MockXhr { addEventListener() {} }
  MockXhr.prototype.open = function open() {};
  MockXhr.prototype.send = function send() {};
  class MockDOMParser { parseFromString() { return parsedLotDocument; } }

  const sandbox = {
    console,
    Date,
    URL,
    URLSearchParams,
    DOMParser: MockDOMParser,
    XMLHttpRequest: MockXhr,
    MutationObserver: class { observe() {} },
    location: {
      href: "https://www.easyliveauction.com/catalogue/AUCTION1/DAY1/example-sale/?currentPage=1",
      origin: "https://www.easyliveauction.com",
      pathname: "/catalogue/AUCTION1/DAY1/example-sale/"
    },
    document: {
      readyState: "complete",
      documentElement: { textContent: "" },
      body: { textContent: "Example timed catalogue" },
      title: "Example server-rendered timed sale",
      querySelector(selector) { return selector === '[x-data="auctions"]' ? null : null; },
      querySelectorAll(selector) {
        if (selector === ".grid-lot") return [visibleCard];
        if (selector === 'a[href*="/bid-live/"]') return [unrelatedLiveAnchor];
        return [];
      },
      addEventListener() {}
    },
    async fetch(url) {
      const requested = new URL(url);
      assert.equal(requested.searchParams.get("searchTerm"), "225");
      assert.equal(requested.searchParams.get("searchOption"), "2");
      return {
        ok: true,
        status: 200,
        url: "https://www.easyliveauction.com/catalogue/lot/LOT225/DAY1/example-sale-lot-225/",
        async text() { return "<html>lot 225</html>"; }
      };
    },
    addEventListener(type, listener) { listeners[type] = listener; },
    postMessage(message) { if (message?.type === "TIMED_SNAPSHOT") snapshots.push(message.payload); },
    setInterval() { return 1; },
    setTimeout(callback) { Promise.resolve().then(callback); return 1; }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const source = fs.readFileSync(path.resolve(__dirname, "../page-bridge.js"), "utf8");
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  sandbox.__messageListener = listeners.message;
  vm.runInContext(`__messageListener({
    source: window,
    data: { source: "easy-live-lot-watcher", type: "SET_TIMED_WATCH_LOTS", payload: { lots: ["225"] } }
  })`, context);
  await new Promise((resolve) => setTimeout(resolve, 30));

  const latest = snapshots.at(-1);
  const watched = latest.lots.find((lot) => lot.lot === "225");
  assert.equal(latest.bridgeVersion, 11);
  assert.equal(latest.auctionMode, "timed");
  assert.equal(latest.auctionId, "AUCTION1");
  assert.equal(latest.lookupState, "ready");
  assert.equal(watched.source, "catalogue-lookup-static");
  assert.equal(watched.description, "Static off-page lot");
  assert.equal(watched.accountWatched, true);
  assert.equal(watched.deadlineMs, Date.UTC(2026, 7, 20, 11, 25, 0));
  assert.equal(watched.bidUrl, "https://www.easyliveauction.com/catalogue/lot/LOT225/DAY1/example-sale-lot-225/");
});

test("an explicitly ended auction stops unresolved catalogue searches", async () => {
  const listeners = {};
  const snapshots = [];
  let fetchCount = 0;
  class MockXhr { addEventListener() {} }
  MockXhr.prototype.open = function open() {};
  MockXhr.prototype.send = function send() {};

  const sandbox = {
    console,
    Date,
    URL,
    URLSearchParams,
    DOMParser: class {},
    XMLHttpRequest: MockXhr,
    MutationObserver: class { observe() {} },
    location: {
      href: "https://www.easyliveauction.com/catalogue/AUCTION1/DAY1/example-sale/",
      origin: "https://www.easyliveauction.com",
      pathname: "/catalogue/AUCTION1/DAY1/example-sale/"
    },
    document: {
      readyState: "complete",
      documentElement: { textContent: "This auction has ended" },
      body: { textContent: "This auction has ended" },
      title: "Ended timed sale",
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {}
    },
    async fetch() { fetchCount += 1; throw new Error("An ended auction must not be fetched"); },
    addEventListener(type, listener) { listeners[type] = listener; },
    postMessage(message) { if (message?.type === "TIMED_SNAPSHOT") snapshots.push(message.payload); },
    setInterval() { return 1; },
    setTimeout(callback) { Promise.resolve().then(callback); return 1; }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const source = fs.readFileSync(path.resolve(__dirname, "../page-bridge.js"), "utf8");
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  sandbox.__messageListener = listeners.message;
  vm.runInContext(`__messageListener({
    source: window,
    data: { source: "easy-live-lot-watcher", type: "SET_TIMED_WATCH_LOTS", payload: { lots: ["999"] } }
  })`, context);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const latest = snapshots.at(-1);
  assert.equal(latest.bridgeVersion, 11);
  assert.equal(latest.auctionEnded, true);
  assert.equal(latest.monitoringComplete, true);
  assert.equal(latest.terminalReason, "auction-ended");
  assert.equal(latest.lookupState, "ended");
  assert.equal(fetchCount, 0);
});

test("confirmed ended watched lots are not looked up again", async () => {
  const listeners = {};
  const snapshots = [];
  const root = {};
  let lookupCount = 0;
  const catalogueData = {
    auction_info: { type: "T", short_desc: "Example timed sale" },
    encrypt_auction_id: "AUCTION1",
    encrypt_day_id: "DAY1",
    page_type: "auction",
    lots: [{
      lot_no: "1",
      encrypt_id: "LOT1",
      encrypt_auction_id: "AUCTION1",
      date_info: { end_lot_time: "20 Aug 2026 12:00:00" }
    }]
  };
  class MockXhr { addEventListener() {} }
  MockXhr.prototype.open = function open() {};
  MockXhr.prototype.send = function send() {};
  const sandbox = {
    console,
    Date,
    URL,
    URLSearchParams,
    XMLHttpRequest: MockXhr,
    MutationObserver: class { observe() {} },
    location: {
      href: "https://auctions.example.com/catalogue/AUCTION1/DAY1/example-sale/",
      origin: "https://auctions.example.com",
      pathname: "/catalogue/AUCTION1/DAY1/example-sale/"
    },
    document: {
      readyState: "complete",
      documentElement: {},
      body: { textContent: "Example active auction" },
      title: "Example timed sale",
      querySelector(selector) { return selector === '[x-data="auctions"]' ? root : null; },
      addEventListener() {}
    },
    Alpine: { $data(value) { return value === root ? catalogueData : null; } },
    async lotHandler() {
      lookupCount += 1;
      return {
        success: true,
        response: { lots: [{ lot_no: "42", encrypt_id: "LOT42", encrypt_auction_id: "AUCTION1", lot_ended: 1 }] }
      };
    },
    addEventListener(type, listener) { listeners[type] = listener; },
    postMessage(message) { if (message?.type === "TIMED_SNAPSHOT") snapshots.push(message.payload); },
    setInterval() { return 1; },
    setTimeout(callback) { Promise.resolve().then(callback); return 1; }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const source = fs.readFileSync(path.resolve(__dirname, "../page-bridge.js"), "utf8");
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  sandbox.__messageListener = listeners.message;
  const setWatch = `__messageListener({
    source: window,
    data: { source: "easy-live-lot-watcher", type: "SET_TIMED_WATCH_LOTS", payload: { lots: ["42"] } }
  })`;
  vm.runInContext(setWatch, context);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const snapshotCountAfterCompletion = snapshots.length;
  vm.runInContext(setWatch, context);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const latest = snapshots.at(-1);
  assert.equal(latest.auctionEnded, false);
  assert.equal(latest.monitoringComplete, true);
  assert.equal(latest.terminalReason, "watched-lots-ended");
  assert.equal(latest.lookupState, "complete");
  assert.equal(latest.lots.find((lot) => lot.lot === "42").confirmedEnded, true);
  assert.equal(lookupCount, 1);
  assert.equal(snapshots.length, snapshotCountAfterCompletion);
});

test("a watched lot missing after its known deadline remains ended and stops lookup alerts", async () => {
  const listeners = {};
  const snapshots = [];
  const root = {};
  let endedLotLookups = 0;
  const catalogueData = {
    auction_info: { type: "T", short_desc: "Example completed-lot sale" },
    encrypt_auction_id: "AUCTION1",
    encrypt_day_id: "DAY1",
    page_type: "auction",
    lots: [{ lot_no: "1", encrypt_id: "LOT1", encrypt_auction_id: "AUCTION1" }]
  };
  class MockXhr { addEventListener() {} }
  MockXhr.prototype.open = function open() {};
  MockXhr.prototype.send = function send() {};
  const sandbox = {
    console,
    Date,
    URL,
    URLSearchParams,
    XMLHttpRequest: MockXhr,
    MutationObserver: class { observe() {} },
    location: {
      href: "https://auctions.example.com/catalogue/AUCTION1/DAY1/example-sale/",
      origin: "https://auctions.example.com",
      pathname: "/catalogue/AUCTION1/DAY1/example-sale/"
    },
    document: {
      readyState: "complete",
      documentElement: {},
      body: { textContent: "Example active auction" },
      title: "Example completed-lot sale",
      querySelector(selector) { return selector === '[x-data="auctions"]' ? root : null; },
      querySelectorAll() { return []; },
      addEventListener() {}
    },
    Alpine: { $data(value) { return value === root ? catalogueData : null; } },
    async lotHandler(filters) {
      if (filters.search === "42") {
        endedLotLookups += 1;
        if (endedLotLookups === 1) {
          return {
            success: true,
            response: { lots: [{
              lot_no: "42",
              encrypt_id: "LOT42",
              encrypt_auction_id: "AUCTION1",
              date_info: { end_lot_time: "20 Aug 2026 12:42:00" },
              description: "Ended watched lot"
            }] }
          };
        }
      }
      return { success: true, response: { lots: [] } };
    },
    addEventListener(type, listener) { listeners[type] = listener; },
    postMessage(message) { if (message?.type === "TIMED_SNAPSHOT") snapshots.push(message.payload); },
    setInterval() { return 1; },
    setTimeout(callback) { Promise.resolve().then(callback); return 1; }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const source = fs.readFileSync(path.resolve(__dirname, "../page-bridge.js"), "utf8");
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  sandbox.__messageListener = listeners.message;
  const setWatch = (lots) => vm.runInContext(`__messageListener({
    source: window,
    data: { source: "easy-live-lot-watcher", type: "SET_TIMED_WATCH_LOTS", payload: { lots: ${JSON.stringify(lots)} } }
  })`, context);

  setWatch(["42"]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  setWatch(["42", "99"]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  setWatch(["42"]);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const latest = snapshots.at(-1);
  const ended = latest.lots.find((lot) => lot.lot === "42");
  assert.equal(endedLotLookups, 2);
  assert.equal(ended.ended, true);
  assert.equal(ended.confirmedEnded, true);
  assert.equal(ended.missingAfterDeadline, true);
  assert.equal(latest.lookupError, "");
  assert.equal(latest.lookupState, "complete");
  assert.equal(latest.monitoringComplete, true);
  assert.equal(latest.terminalReason, "watched-lots-ended");
});

test("recognises an Alpine live catalogue before the webcast starts", () => {
  const snapshots = [];
  const root = {};
  const liveLink = {
    href: "/bid-live/auction-live/webcast/example-sale/",
    getAttribute(name) { return name === "href" ? this.href : ""; }
  };
  const catalogueData = {
    auction_info: {
      type: "L",
      short_desc: "Monday live customer returns",
      start_date_time: "31 Aug 2026 10:00:00"
    },
    encrypt_auction_id: "AUCTION-LIVE",
    encrypt_day_id: "DAY1",
    lots: [{
      lot_no: "15",
      encrypt_id: "LOT15",
      encrypt_auction_id: "AUCTION-LIVE",
      description: "A future live lot"
    }]
  };
  class MockXhr { addEventListener() {} }
  MockXhr.prototype.open = function open() {};
  MockXhr.prototype.send = function send() {};
  const sandbox = {
    console,
    Date,
    URL,
    URLSearchParams,
    XMLHttpRequest: MockXhr,
    MutationObserver: class { observe() {} },
    location: {
      href: "https://auctions.example.com/catalogue/auction-live/DAY1/example-sale/",
      origin: "https://auctions.example.com",
      pathname: "/catalogue/auction-live/DAY1/example-sale/"
    },
    document: {
      readyState: "complete",
      documentElement: { textContent: "Live Webcast" },
      body: { textContent: "Live Webcast Auction Starts: 31 Aug 2026 at 10am BST" },
      title: "Monday live customer returns",
      querySelector(selector) { return selector === '[x-data="auctions"]' ? root : null; },
      querySelectorAll(selector) { return selector === 'a[href*="/bid-live/"]' ? [liveLink] : []; },
      addEventListener() {}
    },
    Alpine: { $data(value) { return value === root ? catalogueData : null; } },
    addEventListener() {},
    postMessage(message) { if (message?.type === "TIMED_SNAPSHOT") snapshots.push(message.payload); },
    setInterval() { return 1; },
    setTimeout() { return 1; }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const source = fs.readFileSync(path.resolve(__dirname, "../page-bridge.js"), "utf8");
  vm.runInContext(source, vm.createContext(sandbox));

  const latest = snapshots.at(-1);
  assert.equal(latest.bridgeVersion, 11);
  assert.equal(latest.auctionMode, "live");
  assert.equal(latest.liveAuctionId, "auction-live");
  assert.equal(latest.bidLiveUrl, "https://auctions.example.com/bid-live/auction-live/webcast/example-sale/");
  assert.equal(latest.startsAtMs, Date.UTC(2026, 7, 31, 10, 0, 0));
  assert.equal(latest.lots[0].awaitingStart, true);
  assert.equal(latest.lots[0].confirmedEnded, false);
  assert.equal(latest.monitoringComplete, false);
});

test("recognises a server-rendered live webcast catalogue from its Bid Live route", () => {
  const snapshots = [];
  const liveLink = {
    href: "/bid-live/21de1e2957a0ba6dee26470899e61af7/webcast/monday-customer-returns/",
    getAttribute(name) { return name === "href" ? this.href : ""; }
  };
  class MockXhr { addEventListener() {} }
  MockXhr.prototype.open = function open() {};
  MockXhr.prototype.send = function send() {};
  const sandbox = {
    console,
    Date,
    URL,
    URLSearchParams,
    XMLHttpRequest: MockXhr,
    MutationObserver: class { observe() {} },
    location: {
      href: "https://auctions.wellersauctions.com/catalogue/21de1e2957a0ba6dee26470899e61af7/DAY1/monday-customer-returns/",
      origin: "https://auctions.wellersauctions.com",
      pathname: "/catalogue/21de1e2957a0ba6dee26470899e61af7/DAY1/monday-customer-returns/"
    },
    document: {
      readyState: "complete",
      documentElement: { textContent: "Monday customer returns Live Webcast" },
      body: { textContent: "Monday customer returns Live Webcast Watch Live" },
      title: "Monday customer returns",
      querySelector() { return null; },
      querySelectorAll(selector) {
        if (selector === 'a[href*="/bid-live/"]') return [liveLink];
        if (selector === ".grid-lot") return [];
        return [];
      },
      addEventListener() {}
    },
    addEventListener() {},
    postMessage(message) { if (message?.type === "TIMED_SNAPSHOT") snapshots.push(message.payload); },
    setInterval() { return 1; },
    setTimeout() { return 1; }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const source = fs.readFileSync(path.resolve(__dirname, "../page-bridge.js"), "utf8");
  vm.runInContext(source, vm.createContext(sandbox));

  const latest = snapshots.at(-1);
  assert.equal(latest.auctionMode, "live");
  assert.equal(latest.liveAuctionId, "21de1e2957a0ba6dee26470899e61af7");
  assert.match(latest.bidLiveUrl, /\/bid-live\/21de1e2957a0ba6dee26470899e61af7\//);
  assert.equal(latest.monitoringComplete, false);
});

test("derives a Wellers live route from catalogue metadata when no Bid Live anchor is rendered", () => {
  const snapshots = [];
  class MockXhr { addEventListener() {} }
  MockXhr.prototype.open = function open() {};
  MockXhr.prototype.send = function send() {};
  const meta = {
    getAttribute(name) {
      return name === "content"
        ? "LIVE AUCTION - customer returns (Sale Date: 7 Sep 26 10:00AM) BID NOW"
        : "";
    }
  };
  const sandbox = {
    console, Date, URL, URLSearchParams, XMLHttpRequest: MockXhr,
    MutationObserver: class { observe() {} },
    location: {
      href: "https://auctions.wellersauctions.com/catalogue/cd43e8f69c615e1b48a69b7c0e0144b1/45205ABDBB84D2DF36D33A64CD5790B5/monday-customer-returns/",
      origin: "https://auctions.wellersauctions.com",
      pathname: "/catalogue/cd43e8f69c615e1b48a69b7c0e0144b1/45205ABDBB84D2DF36D33A64CD5790B5/monday-customer-returns/"
    },
    document: {
      readyState: "complete",
      documentElement: { textContent: "Monday customer returns" },
      body: { textContent: "Monday customer returns" },
      title: "Monday customer returns",
      querySelector(selector) { return selector === 'meta[name="description" i]' ? meta : null; },
      querySelectorAll() { return []; },
      addEventListener() {}
    },
    addEventListener() {},
    postMessage(message) { if (message?.type === "TIMED_SNAPSHOT") snapshots.push(message.payload); },
    setInterval() { return 1; }, setTimeout() { return 1; }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const source = fs.readFileSync(path.resolve(__dirname, "../page-bridge.js"), "utf8");
  vm.runInContext(source, vm.createContext(sandbox));

  const latest = snapshots.at(-1);
  assert.equal(latest.bridgeVersion, 11);
  assert.equal(latest.auctionMode, "live");
  assert.equal(latest.liveAuctionId, "cd43e8f69c615e1b48a69b7c0e0144b1");
  assert.equal(latest.bidLiveUrl,
    "https://auctions.wellersauctions.com/bid-live/cd43e8f69c615e1b48a69b7c0e0144b1/45205ABDBB84D2DF36D33A64CD5790B5/monday-customer-returns/");
  assert.equal(latest.monitoringComplete, false);
});

test("a future timed lot without a closing time is not classified as ended", () => {
  const snapshots = [];
  const root = {};
  const catalogueData = {
    auction_info: { type: "T", short_desc: "Future timed sale", start_date_time: "31 Aug 2026 10:00:00" },
    encrypt_auction_id: "TIMED-FUTURE",
    encrypt_day_id: "DAY1",
    lots: [{ lot_no: "88", encrypt_id: "LOT88", encrypt_auction_id: "TIMED-FUTURE" }]
  };
  class MockXhr { addEventListener() {} }
  MockXhr.prototype.open = function open() {};
  MockXhr.prototype.send = function send() {};
  const sandbox = {
    console,
    Date,
    URL,
    URLSearchParams,
    XMLHttpRequest: MockXhr,
    MutationObserver: class { observe() {} },
    location: {
      href: "https://auctions.example.com/catalogue/TIMED-FUTURE/DAY1/future-sale/",
      origin: "https://auctions.example.com",
      pathname: "/catalogue/TIMED-FUTURE/DAY1/future-sale/"
    },
    document: {
      readyState: "complete",
      documentElement: {},
      body: { textContent: "Future timed auction" },
      title: "Future timed sale",
      querySelector(selector) { return selector === '[x-data="auctions"]' ? root : null; },
      querySelectorAll() { return []; },
      addEventListener() {}
    },
    Alpine: { $data(value) { return value === root ? catalogueData : null; } },
    addEventListener() {},
    postMessage(message) { if (message?.type === "TIMED_SNAPSHOT") snapshots.push(message.payload); },
    setInterval() { return 1; },
    setTimeout() { return 1; }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const source = fs.readFileSync(path.resolve(__dirname, "../page-bridge.js"), "utf8");
  vm.runInContext(source, vm.createContext(sandbox));

  const latest = snapshots.at(-1);
  assert.equal(latest.auctionMode, "timed");
  assert.equal(latest.lots[0].awaitingStart, true);
  assert.equal(latest.lots[0].ended, false);
  assert.equal(latest.lots[0].confirmedEnded, false);
  assert.equal(latest.monitoringComplete, false);
});
