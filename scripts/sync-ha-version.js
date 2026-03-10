#!/usr/bin/env node
/**
 * Syncs HA_VERSION file to custom_components/scrypted_an/manifest.json.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const versionFile = path.join(root, "HA_VERSION");
const manifestPath = path.join(root, "custom_components", "scrypted_an", "manifest.json");

const version = fs.readFileSync(versionFile, "utf8").trim();
if (!version) {
  console.error("HA_VERSION file is empty");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.version = version;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log("Updated manifest.json:", version);
