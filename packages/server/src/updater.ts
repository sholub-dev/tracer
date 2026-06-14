import { exec } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.js";

/** Exit code that signals the launcher to restart the server after an update. */
export const RESTART_EXIT_CODE = CONFIG.restartExitCode;

/**
 * How this instance of tracer-sh is running, which determines whether we can
 * upgrade it in place:
 * - `global`: installed via `npm install -g tracer-sh`. Re-running the install
 *   overwrites the package files and the launcher re-spawns the new server.
 * - `npx`: run via `npx tracer-sh` from npm's ephemeral cache. We can't update
 *   the running copy in place; the user must re-run npx to get the new version.
 * - `dev`: running from a source checkout (workspace repo / npm link). Self-update
 *   is disabled — the developer manages the version.
 */
export type InstallMethod = "global" | "npx" | "dev";

interface UpdateStatus {
  available: boolean;
  currentVersion: string;
  latestVersion: string | null;
  method: InstallMethod;
}

let cachedStatus: UpdateStatus | null = null;

interface PackageInfo {
  /** Directory of the resolved `tracer-sh` package, or null if it can't be found. */
  root: string | null;
  version: string;
}

let cachedPackageInfo: PackageInfo | null = null;

/**
 * Resolve the root `tracer-sh` package directory and version. The install
 * location is fixed for the lifetime of the process, so resolve once and cache —
 * findPackageRoot already parses package.json, so we read the version in the
 * same pass instead of re-reading the file.
 */
function resolvePackage(): PackageInfo {
  if (cachedPackageInfo) return cachedPackageInfo;
  let info: PackageInfo = { root: null, version: "unknown" };
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    // Walk up from dist/ to find the root package.json named "tracer-sh".
    for (const candidate of [
      join(__dirname, "../package.json"),
      join(__dirname, "../../package.json"),
      join(__dirname, "../../../package.json"),
    ]) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
        if (pkg.name === "tracer-sh" && pkg.version) {
          info = { root: dirname(candidate), version: pkg.version };
          break;
        }
      } catch { /* try next */ }
    }
  } catch { /* fallback */ }
  cachedPackageInfo = info;
  return info;
}

function readCurrentVersion(): string {
  return resolvePackage().version;
}

/**
 * Classify how this process was launched. Node resolves symlinks when computing
 * import.meta.url, so a global `npm link` checkout reports its real repo path —
 * which is why we key off path shape rather than symlink-ness:
 * - `.../_npx/<hash>/node_modules/tracer-sh` → npx
 * - `.../node_modules/tracer-sh`             → a real (global) install
 * - anything else (the source repo)          → dev
 */
function detectInstallMethod(root: string | null): InstallMethod {
  if (!root) return "dev";
  if (root.includes(`${sep}_npx${sep}`)) return "npx";
  if (root.includes(`${sep}node_modules${sep}tracer-sh`)) return "global";
  return "dev";
}

export function getInstallMethod(): InstallMethod {
  return detectInstallMethod(resolvePackage().root);
}

function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

function fetchLatestNpmVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    exec("npm view tracer-sh version", { encoding: "utf-8", timeout: CONFIG.npmViewTimeoutMs }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const version = stdout.trim();
      resolve(version || null);
    });
  });
}

/** Returns the cached update status, or a safe default if the background check hasn't completed. */
export function getUpdateStatus(): UpdateStatus {
  if (cachedStatus) return cachedStatus;
  return {
    available: false,
    currentVersion: readCurrentVersion(),
    latestVersion: null,
    method: getInstallMethod(),
  };
}

/** Fire-and-forget background update check. Populates cachedStatus for tRPC queries. */
export function checkForUpdateBackground(): void {
  const current = readCurrentVersion();
  const method = getInstallMethod();
  const unavailable = (): UpdateStatus => ({ available: false, currentVersion: current, latestVersion: null, method });

  if (current === "unknown") {
    cachedStatus = unavailable();
    return;
  }

  fetchLatestNpmVersion().then((latest) => {
    if (!latest) {
      cachedStatus = unavailable();
      return;
    }
    const available = isNewerVersion(latest, current);
    cachedStatus = { available, currentVersion: current, latestVersion: latest, method };
    if (available) {
      const hint = method === "global"
        ? "click the version in the sidebar to update from the app"
        : method === "npx"
          ? "re-run: npx tracer-sh@latest"
          : "git pull, then restart tracer-sh — the launcher rebuilds automatically";
      console.log(`Update available: v${current} → v${latest} (${hint})`);
    }
  }).catch(() => {
    cachedStatus = unavailable();
  });
}

export interface SelfUpdateResult {
  ok: boolean;
  method: InstallMethod;
  /** Present when ok is false: why the update couldn't be applied. */
  error?: string;
}

/**
 * Upgrade a global install in place via `npm install -g tracer-sh@latest`. On
 * success the caller should request a restart so the launcher (bin/tracer.mjs)
 * re-spawns the freshly installed server. For npx/dev installs this is a no-op
 * that returns an explanatory error.
 */
export function performSelfUpdate(): Promise<SelfUpdateResult> {
  const method = getInstallMethod();
  if (method !== "global") {
    return Promise.resolve({
      ok: false,
      method,
      error: method === "npx"
        ? "Running via npx, which can't be updated in place. Re-run `npx tracer-sh@latest` to get the latest version."
        : "Running from a local source checkout, so in-app update is disabled.",
    });
  }
  return new Promise((resolve) => {
    exec(
      // Quiet flags keep output small (a verbose install can otherwise overflow
      // the stdout buffer and look like a failure); maxBuffer adds headroom for
      // native rebuild logs so a successful install is never misreported.
      "npm install -g tracer-sh@latest --no-fund --no-audit --loglevel=error",
      { encoding: "utf-8", timeout: CONFIG.npmInstallTimeoutMs, maxBuffer: CONFIG.npmInstallMaxBufferBytes },
      (err, _stdout, stderr) => {
        if (err) {
          resolve({ ok: false, method, error: (stderr || "").trim() || err.message });
          return;
        }
        resolve({ ok: true, method });
      },
    );
  });
}

let restartHandler: (() => void) | null = null;

/** Register how the process restarts itself; wired up by the server entrypoint. */
export function setRestartHandler(fn: () => void): void {
  restartHandler = fn;
}

/** Request a graceful restart (used after a successful self-update). No-op if unset. */
export function requestRestart(): void {
  restartHandler?.();
}
