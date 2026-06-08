#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, "../packages/server/dist/index.js");

// Must match RESTART_EXIT_CODE in packages/server/src/updater.ts
const RESTART_EXIT_CODE = 75;

// `tracer analyze "<message>" [--session <id>] [--provider <name>] [--json]`
// Runs the investigation agent on the already-running local server and prints
// the final analysis. Lets other local agents (e.g. Claude Code) drive Tracer.
if (process.argv[2] === "analyze") {
  await runAnalyze(process.argv.slice(3));
  process.exit(0);
}

async function runAnalyze(args) {
  let message;
  let sessionId;
  let provider;
  let asJson = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") asJson = true;
    else if (a === "--session" || a === "-s") sessionId = args[++i];
    else if (a === "--provider" || a === "-p") provider = args[++i];
    else if (message === undefined) message = a;
  }

  if (!message) {
    console.error('Usage: tracer-sh analyze "<message>" [--session <id>] [--provider <name>] [--json]');
    process.exit(2);
  }

  const host = process.env.TRACER_HOST || "127.0.0.1";
  const port = process.env.TRACER_PORT || "3579";
  const url = `http://${host}:${port}/api/v1/analyze`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, sessionId, provider }),
    });
  } catch {
    console.error(`Could not reach Tracer at ${url}. Is the server running? Start it with: tracer-sh`);
    process.exit(1);
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.status === "error") {
    console.error(`Error: ${data.error || res.statusText}`);
    process.exit(1);
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else {
    process.stdout.write((data.analysis || "") + "\n");
    console.error(`session ${data.sessionId}${data.model ? ` · ${data.model}` : ""}`);
  }
}

const banner = `
  ╔═══════════════════════════════════╗
  ║       Tracer Debug Platform       ║
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
