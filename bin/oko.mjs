#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, "../packages/server/dist/index.js");

// Must match RESTART_EXIT_CODE in packages/server/src/updater.ts
const RESTART_EXIT_CODE = 75;

const banner = `
  ╔═══════════════════════════════════╗
  ║         OKO Debug Platform        ║
  ╚═══════════════════════════════════╝
`;

console.log(banner);

// Restart loop: if server exits with code 75, it means an update was applied
while (true) {
  const result = spawnSync(process.execPath, [serverPath], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== RESTART_EXIT_CODE) {
    process.exit(result.status ?? 1);
  }
  console.log("\nRestarting after update...\n");
}
