import test from "node:test";
import assert from "node:assert/strict";
import { Watcher } from "../src/watcher.js";

function fixture(now = 1_000_000) {
  const sent = [];
  const closed = [];
  const state = { auctions: {}, runtime: {}, alerts: {}, incidents: {}, readiness: {}, events: [], revision: 0 };
  const store = {
    state,
    event(type, details, level = "info") { state.events.push({ type, details, level }); },
    async mutate(action) { return action(state); }
  };
  const monitor = { async closeAuction(key) { closed.push(key); }, async stop() {} };
  const pushover = { async send(payload) { sent.push(payload); return { status: 1, request: `request-${sent.length}` }; } };
  return { watcher: new Watcher({ store, monitor, pushover, now: () => now }), state, sent, closed, setNow(value) { now = value; } };
}

test("a stalled auction page is reset without blocking the watcher loop", async () => {
  const f = fixture();
  const auction = {
    auctionKey: "stalled", mode: "timed", updatedAt: 1,
    label: "Stalled sale", url: "https://example/catalogue/stalled", lots: [{ lot: "10", stages: [180] }]
  };
  f.state.auctions.stalled = auction;
  f.watcher.checkTimeoutMs = 20;
  f.watcher.monitor.timedAuction = async () => new Promise(() => {});

  await f.watcher.run();

  assert.equal(f.watcher.running, false);
  assert.equal(f.watcher.lastLoopCompletedAt, 1_000_000);
  assert.match(f.state.runtime.stalled.error, /timed out after 1 second/i);
  assert.deepEqual(f.closed, ["stalled", "stalled:catalogue", "stalled:live"]);
  assert.equal(f.state.incidents.stalled.notificationCount, 1);
});

test("a crashed auction page is discarded and the next check can recover", async () => {
  const f = fixture();
  const auction = {
    auctionKey: "crashed", mode: "live", updatedAt: 1,
    label: "Live sale", url: "https://example/bid-live/crashed", lots: [{ lot: "10", stages: [5] }]
  };
  f.state.auctions.crashed = auction;
  let attempts = 0;
  f.watcher.monitor.liveAuction = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("page.evaluate: Target crashed");
    return { mode: "live", auctionEnded: false, currentLot: "1", order: ["1", "10"] };
  };

  await f.watcher.run();
  assert.match(f.state.runtime.crashed.error, /Target crashed/);
  assert.deepEqual(f.closed, ["crashed", "crashed:catalogue", "crashed:live"]);

  f.setNow(1_030_000);
  await f.watcher.run();
  assert.equal(f.state.runtime.crashed.error, "");
  assert.equal(f.state.runtime.crashed.lastSuccessAt, 1_030_000);
  assert.equal(attempts, 2);
});

test("timed stages send once and do not re-arm after an extension", async () => {
  const f = fixture();
  const auction = { auctionKey: "a", mode: "timed", label: "Sale", url: "https://example", lots: [{ lot: "10", stages: [180], url: "" }] };
  await f.watcher.evaluateTimed(f.state, auction, { label: "Sale", lots: [{ lot: "10", deadlineMs: 1_120_000, ended: false, url: "https://lot" }] });
  await f.watcher.evaluateTimed(f.state, auction, { label: "Sale", lots: [{ lot: "10", deadlineMs: 1_180_000, ended: false, url: "https://lot" }] });
  assert.equal(f.sent.length, 1);
  assert.equal(f.state.events.find((event) => event.type === "alert-sent").details.pushoverRequest, "request-1");
});

test("pre-auction live feed stays silent before the scheduled start", async () => {
  const f = fixture();
  const auction = { auctionKey: "live-a", mode: "live", label: "Live Sale", url: "https://example/live", lots: [{ lot: "20", stages: [5] }] };
  const snapshot = { mode: "live", scheduled: true, currentLot: "", startsAtMs: 1_600_000, auctionEnded: false };
  await f.watcher.evaluatePreAuctionReadiness(f.state, auction, snapshot);
  assert.equal(f.sent.length, 0);
  assert.equal(f.state.readiness["live-a"].status, "scheduled");
});

test("missing live feed warns once after the ten-minute post-start grace period", async () => {
  const f = fixture(2_200_001);
  const auction = { auctionKey: "live-a", mode: "live", label: "Live Sale", url: "https://example/live", lots: [{ lot: "20", stages: [5] }] };
  const snapshot = { mode: "live", scheduled: true, currentLot: "", startsAtMs: 1_600_000, auctionEnded: false };
  await f.watcher.evaluatePreAuctionReadiness(f.state, auction, snapshot);
  await f.watcher.evaluatePreAuctionReadiness(f.state, auction, snapshot);
  assert.equal(f.sent.length, 1);
  assert.equal(f.state.readiness["live-a"].status, "warning");
  assert.equal(f.state.readiness["live-a"].delivery, "accepted");
  assert.match(f.sent[0].message, /passed at least 10 minutes ago/i);
  assert.equal(f.state.events.filter((event) => event.type === "pre-auction-warning").length, 1);
});

test("pre-auction check stays quiet when the sale is not imminent and recovers when the feed appears", async () => {
  const f = fixture();
  const auction = { auctionKey: "live-a", mode: "live", label: "Live Sale", url: "https://example/live", lots: [{ lot: "20", stages: [5] }] };
  await f.watcher.evaluatePreAuctionReadiness(f.state, auction, {
    mode: "live", scheduled: true, currentLot: "", startsAtMs: 3_000_000, auctionEnded: false
  });
  assert.equal(f.sent.length, 0);
  assert.equal(f.state.readiness["live-a"].status, "scheduled");
  f.state.readiness["live-a"] = { status: "warning", warningSentAt: 900_000, startsAtMs: 1_500_000 };
  await f.watcher.evaluatePreAuctionReadiness(f.state, auction, {
    mode: "live", scheduled: false, currentLot: "18", startsAtMs: 1_500_000, auctionEnded: false
  });
  assert.equal(f.state.readiness["live-a"].status, "ready");
  assert.equal(f.state.events.some((event) => event.type === "pre-auction-feed-ready"), true);
});

test("connection incident sends initial and ten-minute reminder only", async () => {
  const f = fixture();
  const auction = { auctionKey: "a", mode: "timed", label: "Sale", url: "https://example" };
  await f.watcher.handleFailure(auction, new Error("offline"));
  f.setNow(1_300_000);
  await f.watcher.handleFailure(auction, new Error("offline"));
  f.setNow(1_600_001);
  await f.watcher.handleFailure(auction, new Error("offline"));
  f.setNow(3_000_000);
  await f.watcher.handleFailure(auction, new Error("offline"));
  assert.equal(f.sent.length, 2);
  assert.equal(f.state.incidents.a.notificationCount, 2);
});

test("brief recovery does not reset the incident notification limit", async () => {
  const f = fixture();
  const auction = { auctionKey: "a", mode: "timed", label: "Sale", url: "https://example" };
  await f.watcher.handleFailure(auction, new Error("offline"));
  f.setNow(1_100_000);
  await f.watcher.recoverIncident(f.state, auction);
  f.setNow(1_200_000);
  await f.watcher.handleFailure(auction, new Error("offline"));
  assert.equal(f.sent.length, 1);
});

test("incident resets after ten healthy minutes", async () => {
  const f = fixture();
  const auction = { auctionKey: "a", mode: "timed", label: "Sale", url: "https://example" };
  await f.watcher.handleFailure(auction, new Error("offline"));
  f.setNow(1_100_000);
  await f.watcher.recoverIncident(f.state, auction);
  f.setNow(1_700_001);
  await f.watcher.recoverIncident(f.state, auction);
  f.setNow(1_800_000);
  await f.watcher.handleFailure(auction, new Error("offline again"));
  assert.equal(f.sent.length, 2);
});

test("an expired timed deadline needs two matching checks before monitoring completes", () => {
  const f = fixture();
  const auction = { mode: "timed" };
  const first = f.watcher.confirmTerminalLots({ mode: "timed", lots: [{ lot: "10", deadlineMs: 900000, ended: true, confirmedEnded: false }] }, {});
  assert.equal(f.watcher.isComplete(auction, first), false);
  const second = f.watcher.confirmTerminalLots({ mode: "timed", lots: [{ lot: "10", deadlineMs: 900000, ended: true, confirmedEnded: false }] }, first);
  assert.equal(f.watcher.isComplete(auction, second), true);
});

test("live monitoring completes after every watched lot has passed", () => {
  const f = fixture();
  const auction = { mode: "live", lots: [{ lot: "10" }, { lot: "12" }] };
  assert.equal(f.watcher.isComplete(auction, { mode: "live", currentLot: "13", order: ["10", "11", "12", "13"] }), true);
  assert.equal(f.watcher.isComplete(auction, { mode: "live", currentLot: "11", order: ["10", "11", "12", "13"] }), false);
});

test("terminal lots are removed without removing future timed lots", () => {
  const f = fixture();
  const auction = {
    auctionKey: "a", mode: "timed", updatedAt: 123,
    lots: [{ lot: "10" }, { lot: "20" }]
  };
  f.state.auctions.a = auction;
  f.state.runtime.a = {};
  f.state.alerts["a::10::180"] = { status: "sent" };
  const removed = f.watcher.retireTerminalLots(f.state, auction, new Set(["10"]), { auctionEnded: false });
  assert.equal(removed, false);
  assert.deepEqual(f.state.auctions.a.lots, [{ lot: "20" }]);
  assert.equal(f.state.alerts["a::10::180"], undefined);
  assert.equal(f.state.completedLots.a["10"].configUpdatedAt, 123);
});

test("a completed auction is removed from active cloud counts", () => {
  const f = fixture();
  const auction = { auctionKey: "a", mode: "live", updatedAt: 456, lots: [{ lot: "10" }] };
  f.state.auctions.a = auction;
  f.state.runtime.a = {};
  const removed = f.watcher.retireTerminalLots(f.state, auction, new Set(["10"]), { auctionEnded: false });
  assert.equal(removed, true);
  assert.equal(f.state.auctions.a, undefined);
  assert.equal(f.state.runtime.a, undefined);
  assert.equal(f.state.completedAuctions.a.configUpdatedAt, 456);
});
