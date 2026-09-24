#!/usr/bin/env node
"use strict";
// Runs the Tauri CLI. Prefers a copy installed outside the project
// (~/.cache/docproc4-build/npm), for checkouts on mounts that can't load the
// CLI's native module (e.g. pCloud), then the project's own node_modules.
const { spawnSync } = require("child_process");
const { existsSync } = require("fs");
const { join } = require("path");
const candidates = [
  join(process.env.HOME || "", ".cache", "docproc4-build", "npm", "node_modules", "@tauri-apps", "cli", "tauri.js"),
  join(__dirname, "..", "node_modules", "@tauri-apps", "cli", "tauri.js"),
];
const cli = candidates.find(existsSync);
if (!cli) {
  console.error("Tauri CLI is not installed. Run: npm install");
  process.exit(1);
}
// linuxdeploy's bundled `strip` can't read the .relr.dyn sections in newer
// distros' libraries (e.g. Arch/CachyOS), which makes AppImage bundling fail.
// Skipping strip only makes the AppImage somewhat larger.
const env = { NO_STRIP: "true", ...process.env };
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit", env });
process.exit(result.status ?? 1);
