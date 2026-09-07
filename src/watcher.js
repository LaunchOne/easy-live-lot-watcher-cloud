import { dueStage, liveDistance } from "./easy-live.js";

const TEN_MINUTES = 10 * 60 * 1000;

function alertKey(auctionKey, lot, stage) {
  return `${auctionKey}::${lot}::${Number(stage)}`;
}

function formatTimedStage(seconds) {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = seconds / 60;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} minute${minutes === 1 ? "" : "s"}`;
}

export class Watcher {
  constructor({ store, monitor, pushover, pollIntervalMs = 30000, now = () => Date.now() }) {
    this.store = store;
    this.monitor = monitor;
    this.pushover = pushover;
    this.pollIntervalMs = pollIntervalMs;
    this.now = now;
    this.timer = null;
    this.running = false;
    this.lastLoopAt = null;
    this.lastLoopCompletedAt = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.run().catch((error) => console.error("Watcher loop failed", error)), this.pollIntervalMs);
    this.timer.unref?.();
    this.run().catch((error) => console.error("Initial watcher loop failed", error));
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    await this.monitor.stop();
  }

  async run() {
    if (this.running) return;
    this.running = true;
    this.lastLoopAt = this.now();
    try {
      for (const auction of Object.values(this.store.state.auctions)) {
        if (!auction.lots?.length) continue;
        await this.checkAuction(auction);
      }
      this.lastLoopCompletedAt = this.now();
    } finally {
      this.running = false;
    }
  }

  async checkAuction(auction) {
    const previous = this.store.state.runtime[auction.auctionKey] || {};
    if (previous.monitoringComplete && previous.configUpdatedAt === auction.updatedAt) return;
    try {
      const rawSnapshot = auction.mode === "timed"
        ? await this.monitor.timedAuction(auction)
        : await this.monitor.liveAuction(auction);
      const snapshot = this.confirmTerminalLots(rawSnapshot, previous);
      await this.store.mutate(async (state) => {
        state.runtime[auction.auctionKey] = {
          ...snapshot,
          auctionKey: auction.auctionKey,
          lastCheckedAt: this.now(),
          lastSuccessAt: this.now(),
          error: "",
          configUpdatedAt: auction.updatedAt,
          monitoringComplete: this.isComplete(auction, snapshot)
        };
        await this.recoverIncident(state, auction);
        await this.evaluateAlerts(state, auction, snapshot);
        if (state.runtime[auction.auctionKey].monitoringComplete) {
          this.store.event("monitoring-complete", { auctionKey: auction.auctionKey, label: auction.label });
          await this.monitor.closeAuction(auction.auctionKey);
          await this.monitor.closeAuction(`${auction.auctionKey}:catalogue`);
          await this.monitor.closeAuction(`${auction.auctionKey}:live`);
        }
      });
    } catch (error) {
      await this.handleFailure(auction, error);
    }
  }

  isComplete(auction, snapshot) {
    if (snapshot.auctionEnded) return true;
    if (auction.mode !== "timed" || !snapshot.lots?.length) return false;
    return snapshot.lots.every((lot) => lot.confirmedEnded || Number(lot.expiredChecks || 0) >= 2);
  }

  confirmTerminalLots(snapshot, previous) {
    if (snapshot.mode !== "timed") return snapshot;
    const priorLots = new Map((previous.lots || []).map((lot) => [lot.lot, lot]));
    return {
      ...snapshot,
      lots: (snapshot.lots || []).map((lot) => {
        const prior = priorLots.get(lot.lot);
        const sameExpiredDeadline = lot.ended && !lot.confirmedEnded && Number.isFinite(lot.deadlineMs) &&
          Number(prior?.deadlineMs) === Number(lot.deadlineMs);
        return {
          ...lot,
          expiredChecks: lot.confirmedEnded ? 0
            : sameExpiredDeadline ? Number(prior?.expiredChecks || 0) + 1
              : lot.ended && Number.isFinite(lot.deadlineMs) ? 1 : 0
        };
      })
    };
  }

  async evaluateAlerts(state, auction, snapshot) {
    if (snapshot.auctionEnded) return;
    if (auction.mode === "timed") await this.evaluateTimed(state, auction, snapshot);
    else await this.evaluateLive(state, auction, snapshot);
  }

  async evaluateTimed(state, auction, snapshot) {
    for (const watched of auction.lots) {
      const lot = snapshot.lots.find((candidate) => candidate.lot === watched.lot);
      if (!lot || lot.ended || !Number.isFinite(lot.deadlineMs)) continue;
      const remainingSeconds = Math.ceil((lot.deadlineMs - this.now()) / 1000);
      if (remainingSeconds <= 0) continue;
      const processed = new Set(watched.stages.filter((stage) => state.alerts[alertKey(auction.auctionKey, watched.lot, stage)]));
      const stage = dueStage(watched.stages, remainingSeconds, processed);
      if (stage === null) continue;
      for (const skipped of watched.stages.filter((candidate) => candidate > stage && candidate >= remainingSeconds)) {
        state.alerts[alertKey(auction.auctionKey, watched.lot, skipped)] = { status: "skipped", at: this.now() };
      }
      const key = alertKey(auction.auctionKey, watched.lot, stage);
      state.alerts[key] = { status: "sending", deadlineMs: lot.deadlineMs, at: this.now() };
      try {
        await this.pushover.send({
          title: `Lot ${watched.lot} ends in about ${formatTimedStage(stage)}`,
          message: `${snapshot.label || auction.label}${lot.description ? `\n${lot.description}` : ""}`,
          url: lot.url || watched.url || auction.url
        });
        state.alerts[key] = { status: "sent", deadlineMs: lot.deadlineMs, sentAt: this.now() };
        this.store.event("alert-sent", { mode: "timed", auctionKey: auction.auctionKey, lot: watched.lot, stage });
      } catch (error) {
        delete state.alerts[key];
        this.store.event("alert-failed", { auctionKey: auction.auctionKey, lot: watched.lot, stage, error: error.message }, "error");
      }
    }
  }

  async evaluateLive(state, auction, snapshot) {
    if (!snapshot.currentLot) return;
    for (const watched of auction.lots) {
      const remaining = liveDistance(snapshot.currentLot, watched.lot, snapshot.order);
      if (!Number.isFinite(remaining) || remaining < 0) continue;
      const processed = new Set(watched.stages.filter((stage) => state.alerts[alertKey(auction.auctionKey, watched.lot, stage)]));
      const stage = dueStage(watched.stages, remaining, processed);
      if (stage === null) continue;
      for (const skipped of watched.stages.filter((candidate) => candidate > stage && candidate >= remaining)) {
        state.alerts[alertKey(auction.auctionKey, watched.lot, skipped)] = { status: "skipped", at: this.now() };
      }
      const key = alertKey(auction.auctionKey, watched.lot, stage);
      state.alerts[key] = { status: "sending", currentLot: snapshot.currentLot, at: this.now() };
      try {
        await this.pushover.send({
          title: remaining === 0 ? `Lot ${watched.lot} is live now` : `Lot ${watched.lot} is ${remaining} lot${remaining === 1 ? "" : "s"} away`,
          message: snapshot.label || auction.label,
          url: snapshot.bidLiveUrl || auction.bidLiveUrl || auction.url
        });
        state.alerts[key] = { status: "sent", currentLot: snapshot.currentLot, sentAt: this.now() };
        this.store.event("alert-sent", { mode: "live", auctionKey: auction.auctionKey, lot: watched.lot, stage });
      } catch (error) {
        delete state.alerts[key];
        this.store.event("alert-failed", { auctionKey: auction.auctionKey, lot: watched.lot, stage, error: error.message }, "error");
      }
    }
  }

  async handleFailure(auction, error) {
    await this.store.mutate(async (state) => {
      const now = this.now();
      const runtime = state.runtime[auction.auctionKey] || {};
      state.runtime[auction.auctionKey] = { ...runtime, lastCheckedAt: now, error: error.message || String(error), monitoringComplete: false };
      const incident = state.incidents[auction.auctionKey];
      const sameIncident = Boolean(incident && !incident.recoveredAt);
      const firstSeen = sameIncident ? incident.firstSeen : now;
      const notificationCount = sameIncident ? Number(incident.notificationCount || 0) : 0;
      const lastNotifiedAt = sameIncident ? Number(incident.lastNotifiedAt || 0) : 0;
      const reminderDue = notificationCount === 1 && now - lastNotifiedAt >= TEN_MINUTES;
      const shouldNotify = notificationCount === 0 || reminderDue;
      state.incidents[auction.auctionKey] = {
        firstSeen,
        lastFailureAt: now,
        lastNotifiedAt: shouldNotify ? now : lastNotifiedAt,
        notificationCount: shouldNotify ? Math.min(2, notificationCount + 1) : notificationCount,
        problem: error.message || String(error),
        healthySince: null,
        recoveredAt: null
      };
      if (shouldNotify) {
        try {
          await this.pushover.send({
            title: notificationCount === 0 ? "Auction monitoring needs attention" : "Auction monitoring still needs attention",
            message: `${auction.label}\n${error.message || String(error)}${notificationCount === 0 ? " Alerts may be delayed." : " Monitoring has been unavailable for at least 10 minutes."}`,
            url: auction.url
          });
        } catch (pushError) {
          this.store.event("health-alert-failed", { auctionKey: auction.auctionKey, error: pushError.message }, "error");
        }
      }
      this.store.event("monitoring-failed", { auctionKey: auction.auctionKey, error: error.message || String(error), notificationCount: state.incidents[auction.auctionKey].notificationCount }, "warning");
    });
  }

  async recoverIncident(state, auction) {
    const incident = state.incidents[auction.auctionKey];
    if (!incident || incident.recoveredAt) return;
    const now = this.now();
    if (!incident.healthySince) {
      incident.healthySince = now;
      return;
    }
    if (now - incident.healthySince < TEN_MINUTES) return;
    incident.recoveredAt = now;
    this.store.event("monitoring-recovered", { auctionKey: auction.auctionKey, healthyMinutes: 10 });
  }

  status() {
    return {
      running: Boolean(this.timer),
      checking: this.running,
      lastLoopAt: this.lastLoopAt,
      lastLoopCompletedAt: this.lastLoopCompletedAt
    };
  }
}
