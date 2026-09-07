import { randomBytes } from "node:crypto";

function integer(name, fallback, minimum, maximum) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

const generatedDevelopmentKey = randomBytes(24).toString("hex");

export const config = Object.freeze({
  port: integer("PORT", 3000, 1, 65535),
  apiKey: String(process.env.CLOUD_API_KEY || (process.env.NODE_ENV === "production" ? "" : generatedDevelopmentKey)),
  pushoverUserKey: String(process.env.PUSHOVER_USER_KEY || ""),
  pushoverAppToken: String(process.env.PUSHOVER_APP_TOKEN || ""),
  pushoverPriority: integer("PUSHOVER_PRIORITY", 1, -2, 1),
  dataFile: String(process.env.DATA_FILE || "/data/state.json"),
  pollIntervalMs: integer("POLL_INTERVAL_SECONDS", 30, 15, 300) * 1000,
  navigationTimeoutMs: integer("NAVIGATION_TIMEOUT_SECONDS", 45, 10, 120) * 1000,
  allowedHosts: String(process.env.ALLOWED_AUCTION_HOSTS || "auctions.wellersauctions.com,*.easyliveauction.com")
    .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)
});

export function validateProductionConfig() {
  const missing = [];
  if (!config.apiKey || config.apiKey.length < 24) missing.push("CLOUD_API_KEY (at least 24 characters)");
  if (!config.pushoverUserKey) missing.push("PUSHOVER_USER_KEY");
  if (!config.pushoverAppToken) missing.push("PUSHOVER_APP_TOKEN");
  return missing;
}
