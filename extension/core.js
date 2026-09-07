(function attachEasyLiveWatchCore(root) {
  "use strict";

  if (root.EasyLiveWatchCore) return;

  function normalizeLot(value) {
    return String(value ?? "")
      .trim()
      .replace(/^lot\s*(?:no\.?\s*)?/i, "")
      .replace(/\s+/g, "")
      .toUpperCase();
  }

  function extractLotNumber(text) {
    const clean = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!clean) return "";

    const match = clean.match(/(?:^|\b)Lot\s*(?:No\.?\s*)?([A-Za-z0-9][A-Za-z0-9._\/-]*)/i);
    return match ? normalizeLot(match[1]) : "";
  }

  function parseWatchedInput(value) {
    const seen = new Set();
    return String(value ?? "")
      .split(/[,\n]+/)
      .map(normalizeLot)
      .filter((lot) => lot && !seen.has(lot) && seen.add(lot));
  }

  function uniqueOrder(values) {
    const seen = new Set();
    const order = [];
    for (const value of values || []) {
      const lot = normalizeLot(value);
      if (lot && !seen.has(lot)) {
        seen.add(lot);
        order.push(lot);
      }
    }
    return order;
  }

  function parseAuctionIdentity(urlValue) {
    const page = parsePageIdentity(urlValue);
    if (!page || page.mode !== "live") return null;
    return page;
  }

  function extractTimedAuctionIdFromUrl(urlValue) {
    try {
      const url = new URL(urlValue);
      const parts = url.pathname.split("/").filter(Boolean);
      const catalogueIndex = parts.findIndex((part) => part.toLowerCase() === "catalogue");
      if (catalogueIndex === -1) return "";
      const nextPart = parts[catalogueIndex + 1] || "";
      if (nextPart.toLowerCase() === "lot") return "";
      return nextPart;
    } catch (_error) {
      return "";
    }
  }

  function extractTimedDayIdFromUrl(urlValue) {
    try {
      const url = new URL(urlValue);
      const parts = url.pathname.split("/").filter(Boolean);
      const catalogueIndex = parts.findIndex((part) => part.toLowerCase() === "catalogue");
      if (catalogueIndex === -1) return "";
      const nextPart = parts[catalogueIndex + 1] || "";
      return nextPart.toLowerCase() === "lot"
        ? parts[catalogueIndex + 3] || ""
        : parts[catalogueIndex + 2] || "";
    } catch (_error) {
      return "";
    }
  }

  function parsePageIdentity(urlValue) {
    try {
      const url = new URL(urlValue);
      const parts = url.pathname.split("/").filter(Boolean);
      const bidLiveIndex = parts.findIndex((part) => part.toLowerCase() === "bid-live");
      if (bidLiveIndex !== -1 && parts[bidLiveIndex + 1]) {
        const auctionId = parts[bidLiveIndex + 1];
        return {
          mode: "live",
          pageKind: "live",
          auctionId,
          auctionKey: `${url.origin}::${auctionId}`,
          origin: url.origin,
          registrationMatch: `${url.origin}/*`
        };
      }

      const catalogueIndex = parts.findIndex((part) => part.toLowerCase() === "catalogue");
      if (catalogueIndex === -1 || !parts[catalogueIndex + 1]) return null;
      const nextPart = parts[catalogueIndex + 1];
      if (nextPart.toLowerCase() === "lot" && parts[catalogueIndex + 2]) {
        return {
          mode: "timed",
          pageKind: "lot",
          auctionId: null,
          auctionKey: null,
          dayId: parts[catalogueIndex + 3] || null,
          lotId: normalizeLot(parts[catalogueIndex + 2]),
          origin: url.origin,
          registrationMatch: `${url.origin}/*`
        };
      }

      const auctionId = nextPart;
      return {
        mode: "timed",
        pageKind: "catalogue",
        auctionId,
        auctionKey: `${url.origin}::timed::${normalizeLot(auctionId)}`,
        dayId: parts[catalogueIndex + 2] || null,
        lotId: null,
        origin: url.origin,
        registrationMatch: `${url.origin}/*`
      };
    } catch (_error) {
      return null;
    }
  }

  function timedAuctionIdentity(origin, auctionId) {
    const id = normalizeLot(auctionId);
    if (!origin || !id) return null;
    return {
      auctionId: id,
      auctionKey: `${origin}::timed::${id}`,
      origin,
      registrationMatch: `${origin}/*`
    };
  }

  const MONTHS = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
  };

  function parseEasyLiveEndTime(value) {
    if (Number.isFinite(value)) return Number(value);
    const text = String(value || "").trim();
    if (!text) return null;

    const utcMatch = text.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
    if (utcMatch) {
      const month = MONTHS[utcMatch[2].toUpperCase()];
      if (month === undefined) return null;
      return Date.UTC(
        Number(utcMatch[3]),
        month,
        Number(utcMatch[1]),
        Number(utcMatch[4]),
        Number(utcMatch[5]),
        Number(utcMatch[6])
      );
    }

    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseDurationText(value) {
    const text = String(value || "").toLowerCase().replace(/time\s+left\s*:/, " ").trim();
    if (!text || /finished|ended|closed/.test(text)) return null;
    const clockMatch = text.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
    if (clockMatch) {
      const hours = Number(clockMatch[1] || 0);
      return (hours * 3600 + Number(clockMatch[2]) * 60 + Number(clockMatch[3])) * 1000;
    }
    const days = Number(text.match(/(\d+)\s*d/)?.[1] || 0);
    const hours = Number(text.match(/(\d+)\s*h/)?.[1] || 0);
    const minutes = Number(text.match(/(\d+)\s*m/)?.[1] || 0);
    const seconds = Number(text.match(/(\d+)\s*s/)?.[1] || 0);
    if (!(days || hours || minutes || seconds)) return null;
    return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  }

  function calculateTimedState(deadlineMs, now = Date.now()) {
    if (deadlineMs === null || deadlineMs === undefined || deadlineMs === "") {
      return { remainingMs: null, state: "waiting" };
    }
    const deadline = Number(deadlineMs);
    if (!Number.isFinite(deadline)) return { remainingMs: null, state: "waiting" };
    const remainingMs = deadline - now;
    return {
      remainingMs,
      state: remainingMs <= 0 ? "ended" : "upcoming"
    };
  }

  function shouldTimedAlert({ alertedDeadline, deadlineMs, now = Date.now(), thresholdMinutes }) {
    if (deadlineMs === null || deadlineMs === undefined || deadlineMs === "") return false;
    const deadline = Number(deadlineMs);
    const thresholdMs = Number(thresholdMinutes) * 60 * 1000;
    if (!Number.isFinite(deadline) || !Number.isFinite(thresholdMs) || thresholdMs < 60 * 1000) return false;
    const remainingMs = deadline - now;
    return remainingMs >= 0 && remainingMs <= thresholdMs && !alertedDeadline;
  }

  function formatTimedRemaining(remainingMs) {
    if (!Number.isFinite(remainingMs)) return "Waiting for this lot on the open page";
    if (remainingMs <= 0) return "Lot ended";
    const totalSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (days) return `${days}d ${hours}h remaining`;
    if (hours) return `${hours}h ${minutes}m remaining`;
    if (minutes) return `${minutes}m ${seconds}s remaining`;
    return `${seconds}s remaining`;
  }

  function calculateDistance(currentLot, targetLot, order) {
    const current = normalizeLot(currentLot);
    const target = normalizeLot(targetLot);
    const normalizedOrder = uniqueOrder(order);
    const currentIndex = normalizedOrder.indexOf(current);
    const targetIndex = normalizedOrder.indexOf(target);

    if (currentIndex === -1 || targetIndex === -1) {
      return {
        remaining: null,
        state: "waiting",
        currentIndex,
        targetIndex
      };
    }

    const remaining = targetIndex - currentIndex;
    return {
      remaining,
      state: remaining < 0 ? "passed" : remaining === 0 ? "live" : "upcoming",
      currentIndex,
      targetIndex
    };
  }

  function shouldAlert({ alerted, remaining, threshold }) {
    const limit = Number(threshold);
    return (
      !alerted &&
      Number.isInteger(remaining) &&
      remaining >= 0 &&
      remaining <= limit &&
      Number.isFinite(limit) &&
      limit >= 1
    );
  }

  function normalizeLiveStages(values, fallback = [5]) {
    const stages = Array.from(new Set((Array.isArray(values) ? values : fallback)
      .map((value) => Math.max(0, Math.min(50, Number.parseInt(value, 10))))
      .filter(Number.isFinite)));
    return stages.length ? stages.sort((a, b) => b - a) : [5];
  }

  function normalizeTimedStages(values, fallback = [180]) {
    const stages = Array.from(new Set((Array.isArray(values) ? values : fallback)
      .map((value) => Math.max(10, Math.min(10800, Number.parseInt(value, 10))))
      .filter(Number.isFinite)));
    return stages.length ? stages.sort((a, b) => b - a) : [180];
  }

  function nextLiveAlertStage(remaining, stages, alertedStages) {
    if (!Number.isInteger(remaining) || remaining < 0) return null;
    const sent = new Set((alertedStages || []).map(Number));
    const eligible = normalizeLiveStages(stages)
      .filter((stage) => remaining <= stage && !sent.has(stage))
      .sort((a, b) => a - b);
    return eligible.length ? eligible[0] : null;
  }

  function formatTimedStage(seconds) {
    const value = Number(seconds);
    if (value < 60) return `${value} second${value === 1 ? "" : "s"}`;
    const minutes = value / 60;
    return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} minute${minutes === 1 ? "" : "s"}`;
  }

  function formatDistance(result) {
    if (!result || result.state === "waiting") return "Waiting for catalogue position";
    if (result.state === "passed") return "Passed";
    if (result.state === "live") return "Live now";
    return `${result.remaining} lot${result.remaining === 1 ? "" : "s"} away`;
  }

  function compareLotNumbers(left, right) {
    return String(left || "").localeCompare(String(right || ""), undefined, {
      numeric: true,
      sensitivity: "base"
    });
  }

  function liveStateRank(state) {
    return state === "live" ? 0 : state === "upcoming" ? 1 : state === "passed" ? 2 : 3;
  }

  function sortLiveWatched(items) {
    return [...(items || [])].sort((left, right) => {
      const rankDifference = liveStateRank(left.state) - liveStateRank(right.state);
      if (rankDifference) return rankDifference;
      if (left.state === "upcoming") {
        const distanceDifference = Number(left.remaining) - Number(right.remaining);
        if (Number.isFinite(distanceDifference) && distanceDifference) return distanceDifference;
      }
      const leftIndex = Number(left.targetIndex);
      const rightIndex = Number(right.targetIndex);
      if (Number.isFinite(leftIndex) && Number.isFinite(rightIndex) && leftIndex !== rightIndex) {
        return leftIndex - rightIndex;
      }
      return compareLotNumbers(left.targetLot, right.targetLot);
    });
  }

  root.EasyLiveWatchCore = {
    calculateDistance,
    extractTimedAuctionIdFromUrl,
    extractTimedDayIdFromUrl,
    extractLotNumber,
    formatDistance,
    normalizeLot,
    parseAuctionIdentity,
    parseDurationText,
    parseEasyLiveEndTime,
    parsePageIdentity,
    parseWatchedInput,
    shouldAlert,
    shouldTimedAlert,
    timedAuctionIdentity,
    calculateTimedState,
    formatTimedRemaining,
    formatTimedStage,
    nextLiveAlertStage,
    normalizeLiveStages,
    normalizeTimedStages,
    sortLiveWatched,
    uniqueOrder
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.EasyLiveWatchCore;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
