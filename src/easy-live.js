const MONTHS = Object.freeze({
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
});

export function normalizeLot(value) {
  return String(value ?? "").trim().replace(/^lot\s*(?:no\.?\s*)?/i, "").replace(/\s+/g, "").toUpperCase();
}

export function parseEasyLiveTime(value) {
  if (Number.isFinite(value)) return Number(value);
  const text = String(value || "").trim();
  if (!text) return null;
  const match = text.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (match) {
    const month = MONTHS[match[2].toUpperCase()];
    if (month === undefined) return null;
    return Date.UTC(Number(match[3]), month, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6]));
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeTimedLot(raw, fallback = {}) {
  const lot = normalizeLot(raw?.lot_no || raw?.lotno || raw?.lot_number || raw?.lot || fallback.lot);
  const deadlineMs = parseEasyLiveTime(raw?.date_info?.end_lot_time || raw?.end_lot_time || raw?.deadlineMs);
  const status = String(raw?.status || "");
  const confirmedEnded = raw?.lot_ended === true || Number(raw?.lot_ended) === 1 ||
    /^(?:ended|closed|finished|complete|completed)$/i.test(status);
  const lotId = String(raw?.encrypt_id || raw?.lotId || fallback.lotId || "");
  const dayId = String(raw?.encrypt_day_id || fallback.dayId || "");
  const slug = String(raw?.url_description || "");
  let url = String(raw?.url || fallback.url || "");
  if (!/\/catalogue\/lot\//i.test(url) && lotId && dayId && fallback.origin) {
    url = new URL(`/catalogue/lot/${lotId}/${dayId}/${slug}`, fallback.origin).href;
  }
  return {
    lot,
    lotId,
    deadlineMs,
    confirmedEnded,
    ended: confirmedEnded || (Number.isFinite(deadlineMs) && deadlineMs <= Date.now()),
    awaitingStart: !confirmedEnded && !Number.isFinite(deadlineMs),
    description: String(raw?.description || raw?.short_desc || raw?.lot_desc || fallback.description || "")
      .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
    url
  };
}

export function hostMatches(hostname, patterns) {
  const host = String(hostname || "").toLowerCase();
  return patterns.some((pattern) => pattern === host ||
    (pattern.startsWith("*.") && (host === pattern.slice(2) || host.endsWith(pattern.slice(1)))));
}

export function validateAuctionUrl(value, allowedHosts) {
  let url;
  try { url = new URL(value); } catch (_error) { throw new Error("Invalid auction URL."); }
  if (url.protocol !== "https:") throw new Error("Auction URLs must use HTTPS.");
  if (!hostMatches(url.hostname, allowedHosts)) throw new Error(`Auction host is not allowed: ${url.hostname}`);
  if (!/\/(?:catalogue|bid-live)\//i.test(url.pathname)) throw new Error("URL is not an Easy Live catalogue or live-auction page.");
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
}

export function isBidLiveUrl(value) {
  try { return /\/bid-live\//i.test(new URL(value).pathname); }
  catch (_error) { return false; }
}

export function dueStage(stages, remaining, alreadyProcessed = new Set()) {
  if (!Number.isFinite(remaining) || remaining < 0) return null;
  return [...new Set((stages || []).map(Number).filter(Number.isFinite))]
    .filter((stage) => stage >= remaining && !alreadyProcessed.has(stage))
    .sort((a, b) => a - b)[0] ?? null;
}

export function compareLotNumbers(left, right) {
  const parse = (value) => {
    const match = normalizeLot(value).match(/^(\d+)(.*)$/);
    return match ? [Number(match[1]), match[2]] : [Number.MAX_SAFE_INTEGER, normalizeLot(value)];
  };
  const a = parse(left);
  const b = parse(right);
  return a[0] - b[0] || a[1].localeCompare(b[1], undefined, { numeric: true });
}

export function liveDistance(current, target, order = []) {
  const currentLot = normalizeLot(current);
  const targetLot = normalizeLot(target);
  const normalizedOrder = order.map(normalizeLot);
  const currentIndex = normalizedOrder.indexOf(currentLot);
  const targetIndex = normalizedOrder.indexOf(targetLot);
  if (currentIndex >= 0 && targetIndex >= 0) return targetIndex - currentIndex;
  const currentNumber = Number(currentLot.match(/^\d+/)?.[0]);
  const targetNumber = Number(targetLot.match(/^\d+/)?.[0]);
  return Number.isFinite(currentNumber) && Number.isFinite(targetNumber) ? targetNumber - currentNumber : null;
}

export function sanitizeAuction(input, allowedHosts) {
  const mode = input?.mode === "live" ? "live" : input?.mode === "timed" ? "timed" : "";
  if (!mode) throw new Error("Auction mode must be live or timed.");
  const url = validateAuctionUrl(input.url, allowedHosts);
  const lots = Array.from(new Map((input.lots || []).map((entry) => {
    const lot = normalizeLot(typeof entry === "string" ? entry : entry?.lot);
    if (!lot) return ["", null];
    const stages = mode === "timed"
      ? (entry?.stagesSeconds || [180]).map(Number).filter((value) => Number.isFinite(value) && value >= 10 && value <= 10800)
      : (entry?.stages || [5]).map(Number).filter((value) => Number.isFinite(value) && value >= 0 && value <= 50);
    let exactUrl = "";
    if (entry?.url) {
      try { exactUrl = validateAuctionUrl(entry.url, allowedHosts); } catch (_error) {}
    }
    return [lot, {
      lot,
      stages: Array.from(new Set(stages)).sort((a, b) => b - a),
      url: exactUrl,
      description: String(entry?.description || "").slice(0, 500)
    }];
  }).filter(([lot]) => lot)).values());
  return {
    mode,
    auctionKey: String(input.auctionKey || "").slice(0, 500),
    auctionId: String(input.auctionId || "").slice(0, 200),
    dayId: String(input.dayId || "").slice(0, 200),
    label: String(input.label || "Easy Live Auction").replace(/\s+/g, " ").trim().slice(0, 250),
    url,
    bidLiveUrl: input.bidLiveUrl ? validateAuctionUrl(input.bidLiveUrl, allowedHosts) : "",
    lots,
    updatedAt: Number.isFinite(Number(input.updatedAt)) ? Number(input.updatedAt) : Date.now()
  };
}
