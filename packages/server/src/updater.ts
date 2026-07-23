import { exec } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.js";

/** Exit code that signals the launcher to restart the server after an update. */
export const RESTART_EXIT_CODE = CONFIG.restartExitCode;

/**
 * How this instance of tracer-sh is running, which determines how we upgrade it:
 * - `global`: installed via `npm install -g tracer-sh`. Re-running the install
 *   overwrites the package files and the launcher re-spawns the new server.
 * - `npx`: run via `npx tracer-sh` from npm's cache. Bare `npx tracer-sh` reuses
 *   that cache WITHOUT checking the registry, so it never updates on its own —
 *   but the cache dir is a regular npm prefix we can upgrade in place with
 *   `npm install --prefix`, after which both the running copy and future bare
 *   npx runs use the new version.
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
let lastCheckAtMs = 0;
let checkInFlight = false;
let installInFlight = false;

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
export function detectInstallMethod(root: string | null): InstallMethod {
  if (!root) return "dev";
  if (root.includes(`${sep}_npx${sep}`)) return "npx";
  if (root.includes(`${sep}node_modules${sep}tracer-sh`)) return "global";
  return "dev";
}

export function getInstallMethod(): InstallMethod {
  return detectInstallMethod(resolvePackage().root);
}

export function isNewerVersion(latest: string, current: string): boolean {
  // parseInt tolerates prerelease suffixes ("4-rc.1" → 4); NaN would compare false forever.
  const parse = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
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

/**
 * Returns the cached update status (or a safe default before the first check
 * completes). Long-running servers would otherwise never learn about releases
 * published after startup, so a stale cache re-triggers the background check.
 */
export function getUpdateStatus(): UpdateStatus {
  // Never start an `npm view` while an install runs — concurrent npm processes
  // on the shared cache are a known source of truncated-download failures.
  if (!installInFlight && Date.now() - lastCheckAtMs > CONFIG.updateCheckTtlMs) {
    checkForUpdateBackground();
  }
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
  if (checkInFlight) return;
  checkInFlight = true;
  lastCheckAtMs = Date.now();

  const current = readCurrentVersion();
  const method = getInstallMethod();
  const unavailable = (): UpdateStatus => ({ available: false, currentVersion: current, latestVersion: null, method });

  if (current === "unknown") {
    cachedStatus = unavailable();
    checkInFlight = false;
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
      const hint = method === "dev"
        ? "git pull, then restart tracer-sh — the launcher rebuilds automatically"
        : "click the version in the sidebar to update from the app";
      console.log(`Update available: v${current} → v${latest} (${hint})`);
    }
  }).catch(() => {
    cachedStatus = unavailable();
  }).finally(() => {
    checkInFlight = false;
  });
}

export interface SelfUpdateResult {
  ok: boolean;
  method: InstallMethod;
  /** Present when ok is false: why the update couldn't be applied. */
  error?: string;
}

/** The npm prefix dir of an npx cache install: `.../_npx/<hash>` for a package root `.../_npx/<hash>/node_modules/tracer-sh`. */
function npxPrefixDir(root: string): string {
  return dirname(dirname(root));
}

function runNpmInstall(install: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    exec(
      // Quiet flags keep output small (a verbose install can otherwise overflow
      // the stdout buffer and look like a failure); maxBuffer adds headroom for
      // native rebuild logs so a successful install is never misreported.
      `${install} --no-fund --no-audit --loglevel=error --fetch-retries=5`,
      { encoding: "utf-8", timeout: CONFIG.npmInstallTimeoutMs, maxBuffer: CONFIG.npmInstallMaxBufferBytes },
      (err, _stdout, stderr) => {
        if (err) {
          // Keep the tail — npm prints the actual error last, and full stderr
          // can run to megabytes across retries.
          const full = (stderr || "").trim() || err.message;
          resolve({ ok: false, error: full.length > 2000 ? `…${full.slice(-2000)}` : full });
          return;
        }
        resolve({ ok: true });
      },
    );
  });
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Errors retrying cannot fix: permissions, disk space, bad package spec. Everything else is worth retrying. */
export const PERMANENT_NPM_ERROR = /EACCES|EPERM|ENOSPC|E404|ETARGET/;

/**
 * Run an install attempt up to `attempts` times. npm does not retry truncated
 * tarball downloads ("Content-Length header ... exceeds response Body"), so a
 * single flaky moment would otherwise fail the whole update. Retry-by-default,
 * with a denylist for permanent errors — an allowlist of transient phrasings
 * would silently stop retrying whenever npm rewords an error.
 */
export async function withRetries(
  run: () => Promise<{ ok: boolean; error?: string }>,
  attempts: number,
  delayMs: number,
): Promise<{ ok: boolean; error?: string }> {
  let last: { ok: boolean; error?: string } = { ok: false };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await run();
    if (last.ok) return last;
    console.warn(`[updater] install attempt ${attempt}/${attempts} failed: ${last.error}`);
    if (PERMANENT_NPM_ERROR.test(last.error ?? "")) return last;
    if (attempt < attempts) await delay(delayMs);
  }
  return last;
}

/**
 * Upgrade this install in place, then let the caller request a restart so the
 * launcher (bin/tracer.mjs) re-spawns the freshly installed server:
 * - global → `npm install -g tracer-sh@latest`
 * - npx    → `npm install --prefix <npx cache dir> tracer-sh@latest`; the same
 *   files bare `npx tracer-sh` resolves to, so future runs also get the update.
 * - dev    → refused; the developer manages the checkout.
 */
export async function performSelfUpdate(): Promise<SelfUpdateResult> {
  const { root } = resolvePackage();
  const method = detectInstallMethod(root);
  if (method === "dev" || !root) {
    return {
      ok: false,
      method,
      error: "Running from a local source checkout, so in-app update is disabled.",
    };
  }
  // Serialize installs: a second click or tab must not start a concurrent npm
  // process on the shared cache — the very failure mode the retries fight.
  if (installInFlight) {
    return { ok: false, method, error: "An update is already in progress." };
  }
  const install = method === "global"
    ? "npm install -g tracer-sh@latest"
    : `npm install --prefix "${npxPrefixDir(root)}" tracer-sh@latest`;

  installInFlight = true;
  try {
    const result = await withRetries(
      () => runNpmInstall(install),
      CONFIG.npmInstallAttempts,
      CONFIG.npmInstallRetryDelayMs,
    );
    return { ...result, method };
  } finally {
    installInFlight = false;
  }
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
