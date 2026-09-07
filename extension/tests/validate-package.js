"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const requiredFiles = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_page,
  "core.js",
  "content.js",
  "page-bridge.js",
  "popup.js",
  "options.js",
  "popup.css",
  "options.css",
  "README.md",
  ...Object.values(manifest.icons)
];

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "0.7.1");
assert.ok(manifest.permissions.includes("alarms"));
assert.ok(manifest.permissions.includes("power"));
assert.ok(manifest.optional_host_permissions.includes("https://*/*"));
assert.ok(manifest.host_permissions.includes("https://api.pushover.net/*"));
assert.ok(manifest.host_permissions.includes("https://*.up.railway.app/*"));

for (const relativePath of new Set(requiredFiles)) {
  assert.ok(fs.existsSync(path.join(root, relativePath)), `Missing ${relativePath}`);
}

const popupHtml = fs.readFileSync(path.join(root, "popup.html"), "utf8");
const optionsHtml = fs.readFileSync(path.join(root, "options.html"), "utf8");
assert.match(popupHtml, /id="readinessIndicator"/);
assert.match(popupHtml, /id="createIssueReport"/);
assert.match(popupHtml, /id="refreshCloud"/);
assert.match(popupHtml, /id="reconciliationDisclosure"/);
assert.match(popupHtml, /id="cloudAuditDisclosure"/);
assert.match(optionsHtml, /id="accountWatchImportEnabled"/);
assert.match(optionsHtml, /id="cloudEnabled"/);
assert.match(optionsHtml, /id="testCloud"/);
assert.match(optionsHtml, /id="exportBackup"/);
assert.match(optionsHtml, /id="backupFile"/);

console.log(`Validated manifest and ${new Set(requiredFiles).size} packaged files.`);
