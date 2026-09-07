import test from "node:test";
import assert from "node:assert/strict";
import {
  dueStage, hostMatches, isBidLiveUrl, liveDistance, normalizeLot, parseEasyLiveTime, sanitizeAuction
} from "../src/easy-live.js";

test("normalizes lettered and labelled lots", () => {
  assert.equal(normalizeLot(" Lot No. 20 a "), "20A");
});

test("parses Easy Live UTC wall timestamps", () => {
  assert.equal(parseEasyLiveTime("07 Sep 2026 12:34:56"), Date.UTC(2026, 8, 7, 12, 34, 56));
});

test("selects only the nearest useful alert when starting late", () => {
  assert.equal(dueStage([600, 180, 30], 120), 180);
  assert.equal(dueStage([600, 180, 30], 20), 30);
  assert.equal(dueStage([600, 180], 120, new Set([180])), 600);
});

test("uses catalogue order for lettered live lots", () => {
  assert.equal(liveDistance("20", "20A", ["19", "20", "20A", "24"]), 1);
  assert.equal(liveDistance("20A", "24", ["19", "20", "20A", "24"]), 1);
});

test("matches explicit and wildcard auction hosts", () => {
  assert.equal(hostMatches("auctions.wellersauctions.com", ["auctions.wellersauctions.com"]), true);
  assert.equal(hostMatches("demo.easyliveauction.com", ["*.easyliveauction.com"]), true);
  assert.equal(hostMatches("example.com", ["*.easyliveauction.com"]), false);
});

test("distinguishes a direct live feed from a catalogue", () => {
  assert.equal(isBidLiveUrl("https://auctions.example.com/bid-live/auction-id/sale/"), true);
  assert.equal(isBidLiveUrl("https://auctions.example.com/catalogue/auction-id/day/sale/"), false);
});

test("sanitizes extension auction configuration", () => {
  const auction = sanitizeAuction({
    mode: "timed",
    auctionKey: "key",
    label: " Test  sale ",
    url: "https://auctions.wellersauctions.com/catalogue/abc/day/slug/?token=nope",
    lots: [{ lot: "Lot 10", stagesSeconds: [180, 30] }],
    updatedAt: 123
  }, ["auctions.wellersauctions.com"]);
  assert.equal(auction.url.includes("?"), false);
  assert.equal(auction.lots[0].lot, "10");
  assert.deepEqual(auction.lots[0].stages, [180, 30]);
  assert.equal(auction.updatedAt, 123);
});

test("rejects non-auction and unapproved URLs", () => {
  assert.throws(() => sanitizeAuction({ mode: "timed", auctionKey: "x", url: "https://example.com/catalogue/x", lots: [] }, ["auctions.wellersauctions.com"]));
  assert.throws(() => sanitizeAuction({ mode: "timed", auctionKey: "x", url: "http://auctions.wellersauctions.com/catalogue/x", lots: [] }, ["auctions.wellersauctions.com"]));
});
