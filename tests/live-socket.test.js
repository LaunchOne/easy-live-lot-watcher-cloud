import test from "node:test";
import assert from "node:assert/strict";
import { liveSocketEndpoint, lotNumberForSocketEvent, requestCurrentLiveLot } from "../src/live-socket.js";

test("normalizes Easy Live socket endpoints to the bidder namespace", () => {
  assert.equal(liveSocketEndpoint("live3.easyliveauction.com:3001"), "https://live3.easyliveauction.com:3001/bidder");
  assert.equal(liveSocketEndpoint("https://live3.easyliveauction.com:3001/"), "https://live3.easyliveauction.com:3001/bidder");
});

test("maps current-lot socket IDs back to catalogue lot numbers", () => {
  assert.equal(lotNumberForSocketEvent(
    { action: "cL", lot_id: "encrypted-current" },
    [{ lot_id: "encrypted-current", lotno: "4862" }]
  ), "4862");
  assert.equal(lotNumberForSocketEvent({ action: "cL", lotno: "20A" }, []), "20A");
});

test("subscribes to the read-only live feed and resolves its current lot", async () => {
  const handlers = {};
  const emitted = [];
  const fakeSocket = {
    on(event, handler) { handlers[event] = handler; return this; },
    emit(event, payload) {
      emitted.push([event, payload]);
      if (event === "bS") queueMicrotask(() => handlers.bR({ action: "cL", lot_id: "current-id" }));
    },
    close() { emitted.push(["close"]); }
  };
  const pending = requestCurrentLiveLot({
    wsURL: "live3.easyliveauction.com:3001", auction: "auction-token",
    datastream: "stream-token", token: "anonymous-token",
    lots: [{ lot_id: "current-id", lotno: "4930" }], timeoutMs: 1000,
    socketFactory: () => fakeSocket
  });
  queueMicrotask(() => handlers.connect());
  assert.equal(await pending, "4930");
  assert.equal(emitted[0][0], "subscribe");
  assert.equal(emitted.some(([event]) => event === "bS"), true);
  assert.equal(emitted.at(-1)[0], "close");
});
