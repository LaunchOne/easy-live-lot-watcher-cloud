"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../core.js");

test("normalizes common lot-number input", () => {
  assert.equal(Core.normalizeLot(" Lot No. 208a "), "208A");
  assert.equal(Core.normalizeLot("  14-b "), "14-B");
});

test("extracts lot numbers from live-console labels", () => {
  assert.equal(Core.extractLotNumber("Lot 125 - Est: £20 to £30"), "125");
  assert.equal(Core.extractLotNumber("Lot 208A (Qty 2)"), "208A");
  assert.equal(Core.extractLotNumber("No live lot"), "");
});

test("parses several watched lots without duplicates", () => {
  assert.deepEqual(Core.parseWatchedInput("12, 14A\nLot 12,  19"), ["12", "14A", "19"]);
});

test("identifies a white-label Easy Live auction from its bid-live URL", () => {
  const result = Core.parseAuctionIdentity(
    "https://auctions.example.com/bid-live/auction-123/web-id/example-sale/"
  );
  assert.deepEqual(result, {
    mode: "live",
    pageKind: "live",
    auctionId: "auction-123",
    auctionKey: "https://auctions.example.com::auction-123",
    origin: "https://auctions.example.com",
    registrationMatch: "https://auctions.example.com/*"
  });
  assert.equal(Core.parseAuctionIdentity("https://auctions.example.com/catalogue/123"), null);
});

test("identifies timed catalogue and individual-lot pages", () => {
  assert.deepEqual(
    Core.parsePageIdentity("https://auctions.example.com/catalogue/auction-123/day-1/example-sale/"),
    {
      mode: "timed",
      pageKind: "catalogue",
      auctionId: "auction-123",
      auctionKey: "https://auctions.example.com::timed::AUCTION-123",
      dayId: "day-1",
      lotId: null,
      origin: "https://auctions.example.com",
      registrationMatch: "https://auctions.example.com/*"
    }
  );
  assert.deepEqual(
    Core.parsePageIdentity("https://auctions.example.com/catalogue/lot/encrypted-lot-id"),
    {
      mode: "timed",
      pageKind: "lot",
      auctionId: null,
      auctionKey: null,
      dayId: null,
      lotId: "ENCRYPTED-LOT-ID",
      origin: "https://auctions.example.com",
      registrationMatch: "https://auctions.example.com/*"
    }
  );
  assert.deepEqual(
    Core.parsePageIdentity("https://auctions.example.com/catalogue/lot/ENCRYPTED-42/DAY-ABC/example-lot/"),
    {
      mode: "timed",
      pageKind: "lot",
      auctionId: null,
      auctionKey: null,
      dayId: "DAY-ABC",
      lotId: "ENCRYPTED-42",
      origin: "https://auctions.example.com",
      registrationMatch: "https://auctions.example.com/*"
    }
  );
  assert.equal(
    Core.extractTimedAuctionIdFromUrl("https://auctions.example.com/catalogue/lot/ENCRYPTED-42/DAY-ABC/example-lot/"),
    ""
  );
  assert.equal(
    Core.extractTimedDayIdFromUrl("https://auctions.example.com/catalogue/lot/ENCRYPTED-42/DAY-ABC/example-lot/"),
    "DAY-ABC"
  );
});

test("parses Easy Live UTC deadlines and countdown text", () => {
  assert.equal(
    Core.parseEasyLiveEndTime("17 Aug 2026 09:14:00"),
    Date.UTC(2026, 7, 17, 9, 14, 0)
  );
  assert.equal(Core.parseDurationText("Time left: 1h 2m 3s"), 3723000);
  assert.equal(Core.parseDurationText("02:03"), 123000);
  assert.equal(Core.parseDurationText("Ended"), null);
});

test("a timed alert stage does not re-arm after an extension", () => {
  const now = Date.UTC(2026, 7, 17, 9, 11, 30);
  const firstDeadline = Date.UTC(2026, 7, 17, 9, 14, 0);
  const extendedDeadline = Date.UTC(2026, 7, 17, 9, 16, 0);
  assert.equal(Core.shouldTimedAlert({
    alertedDeadline: null,
    deadlineMs: firstDeadline,
    now,
    thresholdMinutes: 3
  }), true);
  assert.equal(Core.shouldTimedAlert({
    alertedDeadline: firstDeadline,
    deadlineMs: firstDeadline,
    now,
    thresholdMinutes: 3
  }), false);
  assert.equal(Core.shouldTimedAlert({
    alertedDeadline: firstDeadline,
    deadlineMs: extendedDeadline,
    now: extendedDeadline - 2 * 60 * 1000,
    thresholdMinutes: 3
  }), false);
  assert.equal(Core.formatTimedRemaining(125000), "2m 5s remaining");
  assert.equal(Core.calculateTimedState(null).state, "waiting");
  assert.equal(Core.shouldTimedAlert({ deadlineMs: null, thresholdMinutes: 3 }), false);
  assert.equal(Core.calculateTimedState(firstDeadline, firstDeadline).state, "ended");
  assert.equal(Core.formatTimedRemaining(0), "Lot ended");
});

test("calculates catalogue distance rather than subtracting lot numbers", () => {
  const order = ["100", "104", "104A", "110", "125", "200"];
  assert.deepEqual(Core.calculateDistance("104", "125", order), {
    remaining: 3,
    state: "upcoming",
    currentIndex: 1,
    targetIndex: 4
  });
  assert.equal(Core.calculateDistance("125", "104A", order).state, "passed");
  assert.equal(Core.calculateDistance("125", "125", order).state, "live");
});

test("alerts at or inside the threshold but only when not already alerted", () => {
  assert.equal(Core.shouldAlert({ alerted: false, remaining: 5, threshold: 5 }), true);
  assert.equal(Core.shouldAlert({ alerted: false, remaining: 3, threshold: 5 }), true);
  assert.equal(Core.shouldAlert({ alerted: false, remaining: 6, threshold: 5 }), false);
  assert.equal(Core.shouldAlert({ alerted: true, remaining: 2, threshold: 5 }), false);
  assert.equal(Core.shouldAlert({ alerted: false, remaining: -1, threshold: 5 }), false);
  assert.equal(Core.shouldAlert({ alerted: false, remaining: null, threshold: 5 }), false);
});

test("formats watch-list states for the popup", () => {
  assert.equal(Core.formatDistance({ state: "waiting", remaining: null }), "Waiting for catalogue position");
  assert.equal(Core.formatDistance({ state: "upcoming", remaining: 1 }), "1 lot away");
  assert.equal(Core.formatDistance({ state: "upcoming", remaining: 5 }), "5 lots away");
  assert.equal(Core.formatDistance({ state: "live", remaining: 0 }), "Live now");
  assert.equal(Core.formatDistance({ state: "passed", remaining: -2 }), "Passed");
});

test("selects the closest unsent live stage without replaying early warnings", () => {
  assert.equal(Core.nextLiveAlertStage(9, [10, 5, 0], []), 10);
  assert.equal(Core.nextLiveAlertStage(3, [10, 5, 0], []), 5);
  assert.equal(Core.nextLiveAlertStage(3, [10, 5, 0], [10, 5]), null);
  assert.equal(Core.nextLiveAlertStage(0, [10, 5, 0], [10, 5]), 0);
});

test("normalizes configurable alert stages", () => {
  assert.deepEqual(Core.normalizeLiveStages([5, 10, 5, 0]), [10, 5, 0]);
  assert.deepEqual(Core.normalizeTimedStages([30, 600, 180, 30]), [600, 180, 30]);
  assert.equal(Core.formatTimedStage(30), "30 seconds");
  assert.equal(Core.formatTimedStage(180), "3 minutes");
});

test("sorts live watched lots from most urgent to least urgent", () => {
  const sorted = Core.sortLiveWatched([
    { targetLot: "20A", state: "upcoming", remaining: 4, targetIndex: 6 },
    { targetLot: "8", state: "passed", remaining: -2, targetIndex: 1 },
    { targetLot: "14", state: "live", remaining: 0, targetIndex: 3 },
    { targetLot: "30", state: "waiting", remaining: null, targetIndex: -1 },
    { targetLot: "18", state: "upcoming", remaining: 2, targetIndex: 5 }
  ]);
  assert.deepEqual(sorted.map((item) => item.targetLot), ["14", "18", "20A", "8", "30"]);
});
