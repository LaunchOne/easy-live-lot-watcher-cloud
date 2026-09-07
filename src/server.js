import { createServer } from "node:http";
import { config, validateProductionConfig } from "./config.js";
import { BrowserMonitor } from "./browser-monitor.js";
import { Pushover } from "./pushover.js";
import { sanitizeAuction } from "./easy-live.js";
import { StateStore } from "./store.js";
import { Watcher } from "./watcher.js";

const store = new StateStore(config.dataFile);
await store.load();

const pushover = new Pushover({
  userKey: config.pushoverUserKey,
  appToken: config.pushoverAppToken,
  priority: config.pushoverPriority
});
const monitor = new BrowserMonitor({ navigationTimeoutMs: config.navigationTimeoutMs });
const watcher = new Watcher({ store, monitor, pushover, pollIntervalMs: config.pollIntervalMs });
const missingConfiguration = validateProductionConfig();
const COMPLETION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS"
  });
  response.end(JSON.stringify(body));
}

function authorized(request) {
  const supplied = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!config.apiKey || supplied.length !== config.apiKey.length) return false;
  let difference = 0;
  for (let index = 0; index < supplied.length; index += 1) difference |= supplied.charCodeAt(index) ^ config.apiKey.charCodeAt(index);
  return difference === 0;
}

async function body(request, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function publicHealth() {
  const loop = watcher.status();
  const healthyLoop = !loop.lastLoopAt || Date.now() - loop.lastLoopAt < Math.max(5 * 60 * 1000, config.pollIntervalMs * 5);
  const auctions = Object.values(store.state.auctions);
  const count = (mode) => auctions.filter((auction) => auction.mode === mode);
  const liveAuctions = count("live");
  const timedAuctions = count("timed");
  return {
    ok: missingConfiguration.length === 0 && healthyLoop,
    service: "easy-live-lot-watcher-cloud",
    version: "1.0.2",
    configured: missingConfiguration.length === 0,
    watcher: loop,
    auctionCount: auctions.length,
    auctionModes: { live: liveAuctions.length, timed: timedAuctions.length },
    watchedLots: {
      live: liveAuctions.reduce((total, auction) => total + auction.lots.length, 0),
      timed: timedAuctions.reduce((total, auction) => total + auction.lots.length, 0),
      total: auctions.reduce((total, auction) => total + auction.lots.length, 0)
    },
    serverTime: Date.now()
  };
}

function privateStatus() {
  return {
    ...publicHealth(),
    revision: store.state.revision,
    syncedAt: store.state.syncedAt,
    runtime: store.state.runtime,
    incidents: store.state.incidents,
    completedAuctions: store.state.completedAuctions,
    completedLots: store.state.completedLots,
    events: store.state.events.slice(0, 50),
    pushoverConfigured: pushover.configured
  };
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") return json(response, 204, {});
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") return json(response, 200, publicHealth());
    if (!authorized(request)) return json(response, 401, { ok: false, error: "Unauthorized" });

    if (request.method === "GET" && url.pathname === "/api/status") return json(response, 200, privateStatus());

    if (request.method === "PUT" && url.pathname === "/api/sync") {
      const input = await body(request);
      if (!Array.isArray(input.auctions)) throw new Error("auctions must be an array.");
      const incoming = input.auctions.map((item) => {
        const auction = sanitizeAuction(item, config.allowedHosts);
        if (!auction.auctionKey) throw new Error("Every auction requires an auctionKey.");
        return auction;
      });
      await store.mutate((state) => {
        const now = Date.now();
        state.completedAuctions ||= {};
        state.completedLots ||= {};
        for (const [key, completed] of Object.entries(state.completedAuctions)) {
          if (now - Number(completed.completedAt || 0) > COMPLETION_RETENTION_MS) delete state.completedAuctions[key];
        }
        for (const [key, lots] of Object.entries(state.completedLots)) {
          for (const [lot, completed] of Object.entries(lots || {})) {
            if (now - Number(completed.completedAt || 0) > COMPLETION_RETENTION_MS) delete state.completedLots[key][lot];
          }
          if (!Object.keys(state.completedLots[key] || {}).length) delete state.completedLots[key];
        }

        const auctions = {};
        for (const auction of incoming) {
          const completedAuction = state.completedAuctions[auction.auctionKey];
          if (completedAuction && auction.updatedAt <= Number(completedAuction.configUpdatedAt || 0)) continue;
          if (completedAuction) delete state.completedAuctions[auction.auctionKey];
          const completedLots = state.completedLots[auction.auctionKey] || {};
          const lots = auction.lots.filter((lot) => {
            const completed = completedLots[lot.lot];
            if (!completed) return true;
            if (auction.updatedAt <= Number(completed.configUpdatedAt || 0)) return false;
            delete completedLots[lot.lot];
            return true;
          });
          if (!Object.keys(completedLots).length) delete state.completedLots[auction.auctionKey];
          if (lots.length) auctions[auction.auctionKey] = { ...auction, lots };
        }
        const removed = Object.keys(state.auctions).filter((key) => !auctions[key]);
        state.auctions = auctions;
        state.syncedAt = Date.now();
        for (const key of removed) {
          delete state.runtime[key];
          delete state.incidents[key];
          for (const alert of Object.keys(state.alerts)) if (alert.startsWith(`${key}::`)) delete state.alerts[alert];
        }
        store.event("extension-synced", { auctionCount: Object.keys(auctions).length, removedCount: removed.length });
      });
      watcher.run().catch((error) => console.error("Post-sync check failed", error));
      return json(response, 200, {
        ok: true,
        revision: store.state.revision,
        auctionCount: Object.keys(store.state.auctions).length,
        watchedLotCount: Object.values(store.state.auctions).reduce((total, auction) => total + auction.lots.length, 0)
      });
    }

    if (request.method === "POST" && url.pathname === "/api/test") {
      await pushover.send({ title: "Easy Live cloud test", message: "Railway monitoring and Pushover are connected correctly." });
      store.event("test-alert-sent", {});
      await store.save();
      return json(response, 200, { ok: true });
    }

    if (request.method === "POST" && url.pathname === "/api/check") {
      await watcher.run();
      return json(response, 200, { ok: true, status: privateStatus() });
    }

    return json(response, 404, { ok: false, error: "Not found" });
  } catch (error) {
    console.error(error);
    return json(response, 400, { ok: false, error: error.message || String(error) });
  }
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`Easy Live cloud watcher listening on ${config.port}`);
  if (missingConfiguration.length) console.error(`Missing configuration: ${missingConfiguration.join(", ")}`);
  watcher.start();
});

async function shutdown(signal) {
  console.log(`${signal} received; shutting down.`);
  server.close();
  await watcher.stop();
  await store.save();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
