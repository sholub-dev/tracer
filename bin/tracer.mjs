#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const serverPath = resolve(repoRoot, "packages/server/dist/index.js");

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

ensureFreshBuild();

/**
 * Source checkouts (git clone / npm link) serve whatever was last built into
 * packages/*\/dist, which silently goes stale after a pull or local commit —
 * the version number updates but the running code doesn't. Detect that here
 * and rebuild before starting the server. Published npm installs ship only
 * prebuilt dist (no src/), so this is a no-op for them.
 */
function ensureFreshBuild() {
  if (process.env.TRACER_SKIP_BUILD) return;
  const isSourceCheckout = existsSync(join(repoRoot, "packages/server/src"));
  if (!isSourceCheckout) return;

  const distEntries = [
    join(repoRoot, "packages/shared/dist"),
    serverPath,
    join(repoRoot, "packages/web/dist/index.html"),
  ];
  const missingDist = distEntries.some((p) => !existsSync(p));

  // Compare the newest source/config mtime against the oldest build output:
  // if anything was edited after the last full build, the dist is stale.
  const sourceInputs = [
    join(repoRoot, "package.json"),
    join(repoRoot, "pnpm-lock.yaml"),
    ...["shared", "server", "web"].flatMap((p) => [
      join(repoRoot, `packages/${p}/src`),
      join(repoRoot, `packages/${p}/package.json`),
    ]),
    join(repoRoot, "packages/web/index.html"),
    join(repoRoot, "packages/web/vite.config.ts"),
  ];
  const stale = missingDist
    || newestMtime(sourceInputs) > Math.min(...distEntries.map((p) => newestMtime([p])));
  if (!stale) return;

  console.log(missingDist
    ? "No build found for this source checkout — building..."
    : "Source has changed since the last build — rebuilding...");

  const run = (args) => spawnSync("pnpm", args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32", // pnpm is pnpm.cmd on Windows
  }).status === 0;
  const built = (run(["install", "--frozen-lockfile"]) || run(["install"])) && run(["build"]);

  if (!built) {
    if (missingDist) {
      console.error("\nBuild failed and no previous build exists. Fix the build and retry, or run `pnpm build` manually.");
      process.exit(1);
    }
    console.error("\nWARNING: rebuild failed — starting the PREVIOUS build, which does not include your latest changes.");
    console.error("Run `pnpm build` manually to see the error.\n");
  }
}

/** Newest mtime (ms) across files and directories (recursive, skipping build output). */
function newestMtime(paths) {
  let newest = 0;
  for (const p of paths) {
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      for (const entry of readdirSync(p, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        newest = Math.max(newest, newestMtime([join(p, entry.name)]));
      }
    } else {
      newest = Math.max(newest, st.mtimeMs);
    }
  }
  return newest;
}

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
