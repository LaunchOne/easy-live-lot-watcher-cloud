"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadBackground() {
  const state = {};
  const alarms = new Map();
  const notifications = [];
  const tabUpdates = [];
  const powerEvents = [];
  const event = () => ({ addListener() {} });
  const chrome = {
    action: {
      async setBadgeBackgroundColor() {},
      async setBadgeText() {}
    },
    alarms: {
      async create(name, info) { alarms.set(name, info); },
      async clear(name) { return alarms.delete(name); },
      async getAll() { return Array.from(alarms, ([name, info]) => ({ name, ...info })); },
      onAlarm: event()
    },
    notifications: {
      async create(id, options) { notifications.push({ id, options }); return id; },
      async getPermissionLevel() { return "granted"; },
      onClicked: event()
    },
    power: {
      requestKeepAwake(level) { powerEvents.push({ type: "request", level }); },
      releaseKeepAwake() { powerEvents.push({ type: "release" }); }
    },
    permissions: {
      async contains() { return true; },
      async getAll() { return { permissions: ["storage", "alarms"], origins: ["https://auctions.example.com/*"] }; }
    },
    scripting: {
      async getRegisteredContentScripts() { return []; },
      async registerContentScripts() {},
      async updateContentScripts() {}
    },
    storage: {
      local: {
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.filter((name) => name in state).map((name) => [name, state[name]]));
        },
        async set(values) { Object.assign(state, values); }
      }
    },
    tabs: {
      async query() { return []; },
      async get(tabId) { return { id: tabId, discarded: false, frozen: false }; },
      async create() {},
      async update(tabId, options) { tabUpdates.push({ tabId, options }); }
    },
    windows: { async update() {} },
    runtime: {
      getManifest() { return { name: "Easy Live Lot Watcher", version: "0.5.3", manifest_version: 3 }; },
      onInstalled: event(), onStartup: event(), onMessage: event()
    }
  };
  const source = fs.readFileSync(path.resolve(__dirname, "../background.js"), "utf8");
  const context = vm.createContext({
    chrome, console, URL, URLSearchParams, Intl,
    navigator: { userAgent: "Test Chrome on macOS", language: "en-GB" },
    fetch: async () => ({})
  });
  vm.runInContext(`${source}\n;globalThis.__test = { syncTimedSchedules, handleTimedAlarm, timedAlarmName, handleThresholdReached, liveStageKey, refreshReliabilityState, migrateMisclassifiedLiveConfig, importAccountWatches, readinessSummary, saveTimedLots, recordDiagnostic, buildIssueReport, checkHealth, buildCloudPayload };`, context);
  return { state, alarms, notifications, tabUpdates, powerEvents, api: context.__test };
}

test("schedules a timed alert and moves it when the deadline is extended", async () => {
  const harness = loadBackground();
  const auctionKey = "https://auctions.example.com::timed::ABC";
  const firstDeadline = Date.now() + 10 * 60 * 1000;
  const status = {
    mode: "timed",
    auctionKey,
    auctionLabel: "Example timed sale",
    url: "https://auctions.example.com/catalogue/ABC",
    watched: [{
      targetLot: "12",
      deadlineMs: firstDeadline,
      state: "upcoming",
      description: "A useful test lot",
      url: "https://auctions.example.com/catalogue/lot/LOT12"
    }]
  };

  await harness.api.syncTimedSchedules(status);
  const alarmName = harness.api.timedAlarmName(auctionKey, "12", 180);
  assert.equal(harness.alarms.get(alarmName).when, firstDeadline - 3 * 60 * 1000);

  const extendedDeadline = firstDeadline + 2 * 60 * 1000;
  status.watched[0].deadlineMs = extendedDeadline;
  await harness.api.syncTimedSchedules(status);
  assert.equal(harness.alarms.get(alarmName).when, extendedDeadline - 3 * 60 * 1000);
  assert.equal(harness.state.timedAlarmIndex[alarmName].deadlineMs, extendedDeadline);
});

test("delivers a timed stage only once even when the deadline extends", async () => {
  const harness = loadBackground();
  const auctionKey = "https://auctions.example.com::timed::ABC";
  const deadlineMs = Date.now() + 2 * 60 * 1000;
  const status = {
    mode: "timed",
    auctionKey,
    auctionLabel: "Example timed sale",
    url: "https://auctions.example.com/catalogue/ABC",
    watched: [{
      targetLot: "12",
      deadlineMs,
      state: "upcoming",
      description: "Test lot",
      bidUrl: "https://auctions.example.com/catalogue/lot/LOT12/DAY1/test-lot"
    }]
  };
  await harness.api.syncTimedSchedules(status);
  const alarmName = harness.api.timedAlarmName(auctionKey, "12", 180);
  await harness.api.handleTimedAlarm({ name: alarmName });

  assert.equal(harness.notifications.length, 1);
  assert.match(harness.notifications[0].options.title, /Lot 12 ends in about 3 minutes/);
  assert.equal(harness.state.timedAlertedStages[`${auctionKey}::12::180`].status, "sent");
  assert.equal(harness.state.timedAlertedStages[`${auctionKey}::12::180`].deadlineMs, deadlineMs);
  assert.equal(harness.state.timedAlarmIndex[alarmName], undefined);
  const notificationId = harness.notifications[0].id;
  assert.equal(
    harness.state.notificationLinks[notificationId].url,
    "https://auctions.example.com/catalogue/lot/LOT12/DAY1/test-lot"
  );

  await harness.api.handleTimedAlarm({ name: alarmName });
  assert.equal(harness.notifications.length, 1);

  const extendedDeadline = Date.now() + 7 * 60 * 1000;
  status.watched[0].deadlineMs = extendedDeadline;
  await harness.api.syncTimedSchedules(status);
  assert.equal(harness.alarms.has(alarmName), false);
  assert.equal(harness.notifications.length, 1);
});

test("an extension reschedules a later unsent timed stage without repeating an earlier one", async () => {
  const harness = loadBackground();
  const auctionKey = "https://auctions.example.com::timed::ABC";
  const firstDeadline = Date.now() + 2 * 60 * 1000;
  const status = {
    mode: "timed",
    auctionKey,
    auctionLabel: "Example timed sale",
    url: "https://auctions.example.com/catalogue/ABC",
    watched: [{
      targetLot: "12",
      deadlineMs: firstDeadline,
      state: "upcoming",
      stagesSeconds: [180, 30]
    }]
  };
  const earlyAlarm = harness.api.timedAlarmName(auctionKey, "12", 180);
  const laterAlarm = harness.api.timedAlarmName(auctionKey, "12", 30);

  await harness.api.syncTimedSchedules(status);
  await harness.api.handleTimedAlarm({ name: earlyAlarm });
  assert.equal(harness.notifications.length, 1);

  const extendedDeadline = Date.now() + 7 * 60 * 1000;
  status.watched[0].deadlineMs = extendedDeadline;
  await harness.api.syncTimedSchedules(status);

  assert.equal(harness.alarms.has(earlyAlarm), false);
  assert.equal(harness.alarms.get(laterAlarm).when, extendedDeadline - 30000);
});

test("a second tab that cannot see the lot does not cancel its alarm", async () => {
  const harness = loadBackground();
  const auctionKey = "https://auctions.example.com::timed::ABC";
  const deadlineMs = Date.now() + 8 * 60 * 1000;
  const visibleStatus = {
    mode: "timed",
    auctionKey,
    watched: [{ targetLot: "12", visible: true, deadlineMs, state: "upcoming" }]
  };
  await harness.api.syncTimedSchedules(visibleStatus);
  const alarmName = harness.api.timedAlarmName(auctionKey, "12", 180);

  await harness.api.syncTimedSchedules({
    mode: "timed",
    auctionKey,
    watched: [{ targetLot: "12", visible: false, deadlineMs: null, state: "waiting" }]
  });

  assert.equal(harness.alarms.get(alarmName).when, deadlineMs - 3 * 60 * 1000);
  assert.equal(harness.state.timedAlarmIndex[alarmName].deadlineMs, deadlineMs);
});

test("schedules every enabled timed stage independently", async () => {
  const harness = loadBackground();
  const auctionKey = "https://auctions.example.com::timed::ABC";
  const deadlineMs = Date.now() + 20 * 60 * 1000;
  await harness.api.syncTimedSchedules({
    mode: "timed",
    auctionKey,
    watched: [{
      targetLot: "12",
      deadlineMs,
      state: "upcoming",
      stagesSeconds: [600, 180, 30]
    }]
  });

  assert.equal(harness.alarms.get(harness.api.timedAlarmName(auctionKey, "12", 600)).when, deadlineMs - 600000);
  assert.equal(harness.alarms.get(harness.api.timedAlarmName(auctionKey, "12", 180)).when, deadlineMs - 180000);
  assert.equal(harness.alarms.get(harness.api.timedAlarmName(auctionKey, "12", 30)).when, deadlineMs - 30000);
});

test("late monitoring keeps only the closest useful timed stage", async () => {
  const harness = loadBackground();
  const auctionKey = "https://auctions.example.com::timed::ABC";
  const deadlineMs = Date.now() + 2 * 60 * 1000;
  await harness.api.syncTimedSchedules({
    mode: "timed",
    auctionKey,
    watched: [{
      targetLot: "12",
      deadlineMs,
      state: "upcoming",
      stagesSeconds: [600, 180, 30]
    }]
  });

  assert.equal(harness.alarms.has(harness.api.timedAlarmName(auctionKey, "12", 600)), false);
  assert.equal(harness.alarms.has(harness.api.timedAlarmName(auctionKey, "12", 180)), true);
  assert.equal(harness.alarms.get(harness.api.timedAlarmName(auctionKey, "12", 30)).when, deadlineMs - 30000);
  assert.equal(harness.state.timedAlertedStages[`${auctionKey}::12::600`].status, "skipped");
  assert.equal(harness.state.timedAlertedStages[`${auctionKey}::12::600`].deadlineMs, deadlineMs);
});

test("terminal auction status clears every pending timed alarm", async () => {
  const harness = loadBackground();
  const auctionKey = "https://auctions.example.com::timed::ABC";
  const deadlineMs = Date.now() + 20 * 60 * 1000;
  const status = {
    mode: "timed",
    auctionKey,
    watched: [{ targetLot: "12", deadlineMs, state: "upcoming", stagesSeconds: [600, 180] }]
  };
  await harness.api.syncTimedSchedules(status);
  assert.equal(harness.alarms.size, 2);

  await harness.api.syncTimedSchedules({
    ...status,
    auctionEnded: true,
    monitoringComplete: true,
    watched: [{ targetLot: "12", deadlineMs: null, state: "unavailable", stagesSeconds: [600, 180] }]
  });

  assert.equal(harness.alarms.size, 0);
  assert.equal(Object.keys(harness.state.timedAlarmIndex).length, 0);
  assert.equal(harness.notifications.length, 0);
});

test("ended timed lots clear health warnings without sending attention alerts", async () => {
  const harness = loadBackground();
  const auctionKey = "https://auctions.example.com::timed::ENDED";
  harness.state.settings = { disconnectWarningMinutes: 1, reliabilityMode: true };
  harness.state.timedAuctionConfigs = {
    [auctionKey]: { mode: "timed", auctionLabel: "Finished timed sale", lots: ["12"] }
  };
  harness.state.auctionRuntime = {
    [auctionKey]: {
      mode: "timed",
      tabId: 9,
      lastSeen: Date.now() - 10 * 60 * 1000,
      lastDataChangeAt: Date.now() - 10 * 60 * 1000,
      lookupState: "error",
      lookupError: "Lot no longer returned by catalogue",
      monitoringComplete: false,
      watched: [{ targetLot: "12", state: "ended", deadlineMs: Date.now() - 60000 }]
    }
  };
  harness.state.healthWarnings = {
    [auctionKey]: { problem: "Timed catalogue lookup failed.", firstSeen: Date.now() - 60000 }
  };

  await harness.api.checkHealth();

  assert.equal(harness.state.healthWarnings[auctionKey], undefined);
  assert.equal(harness.notifications.length, 0);
});

test("a continuous monitoring outage sends one warning and one ten-minute reminder", async () => {
  const harness = loadBackground();
  const auctionKey = "https://auctions.example.com::timed::OUTAGE";
  const staleAt = Date.now() - 5 * 60 * 1000;
  harness.state.settings = {
    disconnectWarningMinutes: 1,
    reliabilityMode: false,
    autoRecoveryEnabled: false,
    desktopEnabled: true,
    pushoverEnabled: false
  };
  harness.state.timedAuctionConfigs = {
    [auctionKey]: {
      mode: "timed",
      auctionLabel: "Disconnected timed sale",
      url: "https://auctions.example.com/catalogue/OUTAGE",
      lots: ["12"]
    }
  };
  harness.state.auctionRuntime = {
    [auctionKey]: {
      mode: "timed",
      tabId: 9,
      lastSeen: staleAt,
      lastDataChangeAt: staleAt,
      ready: true,
      lookupState: "ready",
      watched: [{ targetLot: "12", state: "upcoming" }]
    }
  };

  await harness.api.checkHealth();
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].options.title, "Auction monitoring needs attention");
  assert.equal(harness.state.healthWarnings[auctionKey].notificationCount, 1);

  harness.state.auctionRuntime[auctionKey] = {
    ...harness.state.auctionRuntime[auctionKey],
    lastSeen: Date.now(),
    lookupState: "error",
    lookupError: "Catalogue temporarily unavailable"
  };
  await harness.api.checkHealth();
  assert.equal(harness.notifications.length, 1);
  assert.match(harness.state.healthWarnings[auctionKey].problem, /catalogue lookup failed/i);

  harness.state.healthWarnings[auctionKey].lastNotified = Date.now() - 10 * 60 * 1000 - 1000;
  await harness.api.checkHealth();
  assert.equal(harness.notifications.length, 2);
  assert.equal(harness.notifications[1].options.title, "Auction monitoring still needs attention");
  assert.equal(harness.state.healthWarnings[auctionKey].notificationCount, 2);

  await harness.api.checkHealth();
  assert.equal(harness.notifications.length, 2);
});

test("health notification allowance resets only after ten healthy minutes", async () => {
  const harness = loadBackground();
  const auctionKey = "https://auctions.example.com::timed::RECOVERY";
  harness.state.settings = {
    disconnectWarningMinutes: 1,
    reliabilityMode: false,
    autoRecoveryEnabled: false,
    desktopEnabled: true,
    pushoverEnabled: false
  };
  harness.state.timedAuctionConfigs = {
    [auctionKey]: { mode: "timed", auctionLabel: "Recovery sale", lots: ["12"] }
  };
  harness.state.auctionRuntime = {
    [auctionKey]: {
      mode: "timed",
      tabId: 9,
      lastSeen: Date.now() - 5 * 60 * 1000,
      ready: true,
      lookupState: "ready",
      watched: [{ targetLot: "12", state: "upcoming" }]
    }
  };

  await harness.api.checkHealth();
  assert.equal(harness.notifications.length, 1);

  harness.state.auctionRuntime[auctionKey].lastSeen = Date.now();
  await harness.api.checkHealth();
  assert.equal(harness.state.healthWarnings[auctionKey].problem, "");

  harness.state.auctionRuntime[auctionKey].lastSeen = Date.now() - 5 * 60 * 1000;
  await harness.api.checkHealth();
  assert.equal(harness.notifications.length, 1);

  harness.state.auctionRuntime[auctionKey].lastSeen = Date.now();
  harness.state.healthWarnings[auctionKey].healthySince = Date.now() - 10 * 60 * 1000 - 1000;
  harness.state.healthWarnings[auctionKey].problem = "";
  await harness.api.checkHealth();
  assert.equal(harness.state.healthWarnings[auctionKey], undefined);

  harness.state.auctionRuntime[auctionKey].lastSeen = Date.now() - 5 * 60 * 1000;
  await harness.api.checkHealth();
  assert.equal(harness.notifications.length, 2);
  assert.equal(harness.notifications[1].options.title, "Auction monitoring needs attention");
});

test("a late live update sends the closest stage and suppresses earlier crossed stages", async () => {
  const harness = loadBackground();
  const auctionKey = "https://auctions.example.com::LIVE";
  const payload = {
    auctionKey,
    auctionLabel: "Example live sale",
    currentLot: "97",
    targetLot: "100",
    remaining: 3,
    stage: 5,
    stages: [10, 5, 0],
    url: "https://auctions.example.com/bid-live/LIVE"
  };

  await harness.api.handleThresholdReached(payload);
  assert.equal(harness.notifications.length, 1);
  assert.ok(harness.state.liveAlertedStages[harness.api.liveStageKey(auctionKey, "100", 10)]);
  assert.ok(harness.state.liveAlertedStages[harness.api.liveStageKey(auctionKey, "100", 5)]);
  assert.equal(harness.state.liveAlertedStages[harness.api.liveStageKey(auctionKey, "100", 0)], undefined);
});

test("reliability mode protects active tabs and releases them when monitoring ends", async () => {
  const harness = loadBackground();
  const auctionKey = "https://auctions.example.com::LIVE";
  harness.state.settings = { reliabilityMode: true };
  harness.state.auctionConfigs = { [auctionKey]: { lots: ["12"] } };
  harness.state.auctionRuntime = {
    [auctionKey]: {
      tabId: 9,
      lastSeen: Date.now(),
      watched: [{ targetLot: "12", state: "upcoming" }]
    }
  };

  const active = await harness.api.refreshReliabilityState();
  assert.equal(active.active, true);
  assert.deepEqual(harness.powerEvents[0], { type: "request", level: "system" });
  assert.equal(harness.tabUpdates[0].tabId, 9);
  assert.equal(harness.tabUpdates[0].options.autoDiscardable, false);

  harness.state.auctionRuntime[auctionKey] = {
    ...harness.state.auctionRuntime[auctionKey],
    monitoringComplete: true,
    auctionEnded: true,
    watched: [{ targetLot: "12", state: "unavailable" }]
  };
  const idle = await harness.api.refreshReliabilityState();
  assert.equal(idle.active, false);
  assert.equal(harness.powerEvents.at(-1).type, "release");
  assert.equal(harness.tabUpdates.at(-1).tabId, 9);
  assert.equal(harness.tabUpdates.at(-1).options.autoDiscardable, true);
});

test("migrates lots saved under the old timed key when a catalogue is confirmed live", async () => {
  const harness = loadBackground();
  const legacyKey = "https://auctions.example.com::timed::AUCTION-LIVE";
  const liveKey = "https://auctions.example.com::auction-live";
  harness.state.timedAuctionConfigs = {
    [legacyKey]: {
      mode: "timed",
      auctionId: "AUCTION-LIVE",
      auctionLabel: "Previously misclassified webcast",
      url: "https://auctions.example.com/catalogue/auction-live/DAY1/sale/",
      lots: ["42", "88"],
      lotOptions: { "42": { stagesSeconds: [180] }, "88": { stagesSeconds: [180] } }
    }
  };
  harness.state.timedAlertedStages = { [`${legacyKey}::42::180`]: { status: "sent" } };
  const alarmName = harness.api.timedAlarmName(legacyKey, "42", 180);
  harness.state.timedAlarmIndex = { [alarmName]: { auctionKey: legacyKey, targetLot: "42" } };
  harness.alarms.set(alarmName, { when: Date.now() + 60000 });

  const migrated = await harness.api.migrateMisclassifiedLiveConfig({
    mode: "live",
    livePhase: "scheduled",
    auctionKey: liveKey,
    legacyTimedAuctionKey: legacyKey,
    auctionId: "auction-live",
    auctionLabel: "Confirmed live webcast",
    url: "https://auctions.example.com/catalogue/auction-live/DAY1/sale/"
  });

  assert.equal(migrated, true);
  assert.equal(harness.state.timedAuctionConfigs[legacyKey], undefined);
  assert.deepEqual(Array.from(harness.state.auctionConfigs[liveKey].lots), ["42", "88"]);
  assert.deepEqual(Array.from(harness.state.auctionConfigs[liveKey].lotOptions["42"].stages), [5]);
  assert.equal(harness.state.timedAlertedStages[`${legacyKey}::42::180`], undefined);
  assert.equal(harness.alarms.has(alarmName), false);
});

test("imports signed-in account watches once without resetting existing lots", async () => {
  const harness = loadBackground();
  const auctionKey = "https://auctions.example.com::timed::AUTO-WATCH";
  harness.state.settings = {
    accountWatchImportEnabled: true,
    defaultLiveStages: [5],
    defaultTimedStagesSeconds: [180]
  };
  harness.state.timedAuctionConfigs = {
    [auctionKey]: {
      mode: "timed",
      auctionId: "AUTO-WATCH",
      auctionLabel: "Automatic watch import sale",
      url: "https://auctions.example.com/catalogue/AUTO-WATCH/DAY1/sale/",
      lots: ["12"],
      lotOptions: { "12": { stagesSeconds: [600] } }
    }
  };

  const first = await harness.api.importAccountWatches({
    mode: "timed",
    auctionKey,
    auctionId: "AUTO-WATCH",
    auctionLabel: "Automatic watch import sale",
    url: "https://auctions.example.com/catalogue/AUTO-WATCH/DAY1/sale/",
    lots: ["12", "77"]
  });
  const second = await harness.api.importAccountWatches({
    mode: "timed",
    auctionKey,
    lots: ["12", "77"]
  });

  assert.equal(first.added, 1);
  assert.equal(second.added, 0);
  assert.deepEqual(Array.from(harness.state.timedAuctionConfigs[auctionKey].lots), ["12", "77"]);
  assert.deepEqual(Array.from(harness.state.timedAuctionConfigs[auctionKey].lotOptions["12"].stagesSeconds), [600]);
  assert.equal(harness.state.timedAuctionConfigs[auctionKey].lotOptions["77"].importedFromAccount, true);
  assert.deepEqual(Array.from(harness.state.timedAuctionConfigs[auctionKey].lotOptions["77"].stagesSeconds), [180]);
  assert.equal(harness.state.alertHistory.length, 1);
  assert.match(harness.state.alertHistory[0].title, /Imported 1 watched lot/);
});

test("automatic readiness summary distinguishes ready waiting and locating states", async () => {
  const harness = loadBackground();
  const auctionKey = "https://auctions.example.com::timed::FUTURE";
  harness.state.settings = {
    desktopEnabled: true,
    reliabilityMode: true,
    pushoverEnabled: false,
    defaultLiveStages: [5],
    defaultTimedStagesSeconds: [180]
  };
  harness.state.timedAuctionConfigs = { [auctionKey]: { lots: ["88"] } };
  harness.state.auctionRuntime = {
    [auctionKey]: {
      tabId: 4,
      lastSeen: Date.now(),
      ready: true,
      mode: "timed",
      watched: [{ targetLot: "88", visible: true, state: "not-started" }]
    }
  };

  const ready = await harness.api.readinessSummary({ auctionKey });
  assert.equal(ready.state, "ready");
  assert.match(ready.detail, /waiting for the auction to start/i);

  harness.state.auctionRuntime[auctionKey].watched = [{ targetLot: "88", visible: false, state: "waiting" }];
  const locating = await harness.api.readinessSummary({ auctionKey });
  assert.equal(locating.state, "attention");
  assert.equal(locating.label, "Locating");
});

test("timed watch saves are retained and recorded for refresh diagnostics", async () => {
  const harness = loadBackground();
  const auctionKey = "https://auctions.example.com::timed::AUCTION-ABC";
  harness.state.settings = { defaultTimedStagesSeconds: [180] };

  await harness.api.saveTimedLots({
    auctionKey,
    auctionId: "AUCTION-ABC",
    dayId: "DAY-ABC",
    auctionLabel: "Timed persistence sale",
    url: "https://auctions.example.com/catalogue/lot/LOT-125/DAY-ABC/example/?tracking=private",
    lots: ["125"]
  });

  assert.deepEqual(Array.from(harness.state.timedAuctionConfigs[auctionKey].lots), ["125"]);
  const event = harness.state.diagnosticLog.at(-1);
  assert.equal(event.event, "timed-watch-saved");
  assert.equal(harness.state.timedAuctionConfigs[auctionKey].dayId, "DAY-ABC");
  assert.deepEqual(Array.from(event.details.afterLots), ["125"]);
  assert.equal(event.details.pageUrl.includes("tracking"), false);
});

test("issue reports include useful state and exclude notification credentials", async () => {
  const harness = loadBackground();
  const auctionKey = "https://auctions.example.com::timed::REPORT";
  harness.state.settings = {
    desktopEnabled: true,
    pushoverEnabled: true,
    pushoverUserKey: "SECRET-USER-KEY",
    pushoverAppToken: "SECRET-APP-TOKEN",
    reliabilityMode: true,
    defaultLiveStages: [5],
    defaultTimedStagesSeconds: [180]
  };
  harness.state.timedAuctionConfigs = {
    [auctionKey]: {
      mode: "timed",
      auctionId: "REPORT",
      url: "https://auctions.example.com/catalogue/REPORT/sale/?private=value",
      lots: ["77"],
      lotOptions: { "77": { stagesSeconds: [180] } }
    }
  };
  await harness.api.recordDiagnostic({
    event: "test-diagnostic",
    auctionKey,
    details: { pushoverAppToken: "SECRET-APP-TOKEN", lot: "77" }
  });

  const report = await harness.api.buildIssueReport({ auctionKey });
  const serialized = JSON.stringify(report);
  assert.equal(report.extension.version, "0.5.3");
  assert.equal(report.settings.pushoverConfigured, true);
  assert.equal(report.timedAuctionConfigs[auctionKey].lots[0], "77");
  assert.equal(report.diagnosticLog.at(-1).details.pushoverAppToken, "[redacted]");
  assert.equal(serialized.includes("SECRET-USER-KEY"), false);
  assert.equal(serialized.includes("SECRET-APP-TOKEN"), false);
  assert.equal(serialized.includes("private=value"), false);
});

test("cloud synchronization includes public watch data but no Pushover credentials", async () => {
  const harness = loadBackground();
  const auctionKey = "https://auctions.example.com::timed::ABC";
  harness.state.settings = {
    cloudEnabled: true,
    cloudServiceUrl: "https://watcher.up.railway.app",
    cloudApiKey: "a-private-cloud-key-with-length",
    pushoverUserKey: "private-user-key",
    pushoverAppToken: "private-app-token"
  };
  harness.state.timedAuctionConfigs = {
    [auctionKey]: {
      mode: "timed", auctionId: "ABC", dayId: "DAY", auctionLabel: "Sale",
      url: "https://auctions.example.com/catalogue/abc/day/sale/", lots: ["10"],
      lotOptions: { "10": { stagesSeconds: [180, 30] } }, updatedAt: 123
    }
  };
  harness.state.auctionRuntime = {
    [auctionKey]: { watched: [{ targetLot: "10", url: "https://auctions.example.com/catalogue/lot/id/day/lot-10/", description: "Public lot" }] }
  };
  const payload = await harness.api.buildCloudPayload();
  const text = JSON.stringify(payload);
  assert.match(text, /Public lot/);
  assert.match(text, /\"stagesSeconds\":\[180,30\]/);
  assert.doesNotMatch(text, /private-user-key|private-app-token|private-cloud-key/);
});
