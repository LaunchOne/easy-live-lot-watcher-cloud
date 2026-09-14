import io from "socket.io-client";

const DEFAULT_TIMEOUT_MS = 10000;

export function liveSocketEndpoint(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const absolute = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(absolute);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/bidder`;
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch (_error) {
    return "";
  }
}

export function lotNumberForSocketEvent(event, lots = []) {
  const direct = String(event?.lotno || event?.lot_no || event?.lot_number || "").trim();
  if (direct) return direct;
  const lotId = String(event?.lot_id || event?.id || "").trim();
  if (!lotId) return "";
  const match = lots.find((lot) => String(lot?.lot_id || lot?.id || "").trim() === lotId);
  return String(match?.lotno || match?.lot_no || match?.lot_number || "").trim();
}

export function requestCurrentLiveLot({
  wsURL, auction, datastream, token, lots = [], timeoutMs = DEFAULT_TIMEOUT_MS, socketFactory = io
}) {
  const endpoint = liveSocketEndpoint(wsURL);
  if (!endpoint || !auction || !datastream || !token) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = socketFactory(endpoint, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      timeout: timeoutMs
    });
    const finish = (error, lot = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close?.();
      if (error) reject(error);
      else resolve(lot);
    };
    const timer = setTimeout(() => finish(new Error("The Easy Live current-lot socket timed out.")), timeoutMs);
    socket.on("connect", () => {
      socket.emit("subscribe", { auction, datastream, token });
      setTimeout(() => {
        if (!settled) socket.emit("bS", { action: "gL", token });
      }, 150);
    });
    socket.on("bR", (event) => {
      if (event?.action !== "cL") return;
      const lot = lotNumberForSocketEvent(event, lots);
      if (lot) finish(null, lot);
      else finish(new Error("Easy Live returned a current lot that was not present in the catalogue."));
    });
    socket.on("connect_error", (error) => finish(new Error(`The Easy Live current-lot socket could not connect: ${error?.message || "unknown error"}`)));
    socket.on("error", (error) => finish(new Error(`The Easy Live current-lot socket failed: ${error?.message || error || "unknown error"}`)));
  });
}
