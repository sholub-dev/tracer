import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isNewerVersion } from "@tracer-sh/shared";
import { CONFIG } from "./config.js";

/**
 * How this instance of tracer-sh is running, which determines how we upgrade it:
 * - `global`: installed via `npm install -g tracer-sh`. Re-running the install
 *   overwrites the package files and the launcher re-spawns the new server.
 *   Only the copy in npm's own global folder counts: `npm install -g` would not
 *   touch a project-local, pnpm or yarn install.
 * - `npx`: run via `npx tracer-sh` from npm's cache. Bare `npx tracer-sh` reuses
 *   that cache WITHOUT checking the registry, so it never updates on its own —
 *   but the cache dir is a regular npm prefix we can upgrade in place with
 *   `npm install --prefix`, after which both the running copy and future bare
 *   npx runs use the new version.
 * - `dev`: running from a source checkout (workspace repo / npm link) or from an
 *   install npm does not manage globally. Self-update is disabled — the developer
 *   or the package manager that installed it manages the version.
 */
export type InstallMethod = "global" | "npx" | "dev";

interface UpdateStatus {
  available: boolean;
  currentVersion: string;
  latestVersion: string | null;
  method: InstallMethod;
}

let cachedStatus: UpdateStatus | null = null;
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
 * which is why we key off the path rather than symlink-ness:
 * - `.../_npx/<hash>/node_modules/tracer-sh` → npx
 * - `<npm global root>/tracer-sh`            → a real (global) install
 * - anything else (the source repo, a project-local, pnpm or yarn install) → dev
 * `globalRoot` is the real path that `npm root -g` reports, or null when unknown.
 */
export function detectInstallMethod(root: string | null, globalRoot: string | null = null): InstallMethod {
  if (!root) return "dev";
  if (root.includes(`${sep}_npx${sep}`)) return "npx";
  if (globalRoot) {
    const [here, global] = [root, join(globalRoot, "tracer-sh")].map((p) => (process.platform === "win32" ? p.toLowerCase() : p));
    if (here === global) return "global";
  }
  return "dev";
}

// undefined: npm was not asked yet.
let npmGlobalRoot: string | null | undefined;

/** Asks npm for its global folder once, and only for a copy that sits in some node_modules folder. */
async function resolveGlobalRoot(root: string | null): Promise<void> {
  if (npmGlobalRoot !== undefined || !root || detectInstallMethod(root) === "npx" || basename(dirname(root)) !== "node_modules") return;
  const { err, stdout } = await runNpm(["root", "-g"], { timeout: CONFIG.npmViewTimeoutMs });
  // A failed call stays unanswered, so the next check asks again.
  if (err || !stdout.trim()) return;
  try {
    npmGlobalRoot = realpathSync(stdout.trim());
  } catch {
    npmGlobalRoot = null;
  }
}

/** Before the first update check completes, a global install reports `dev`. */
export function getInstallMethod(): InstallMethod {
  return detectInstallMethod(resolvePackage().root, npmGlobalRoot ?? null);
}

/**
 * npm's own entry script, to run with this Node binary: no shell, and no lookup in PATH or in the
 * current directory. Null when npm is not where the Node installers put it.
 */
export function findNpmCli(execPath = process.execPath, npmExecPath = process.env.npm_execpath, onWindows = process.platform === "win32"): string | null {
  // pnpm and yarn set npm_execpath to themselves.
  if (npmExecPath && basename(npmExecPath) === "npm-cli.js" && existsSync(npmExecPath)) return npmExecPath;
  const bin = dirname(execPath);
  try {
    // Windows keeps npm beside node.exe; elsewhere `npm` beside `node` is a link to the script.
    const cli = onWindows ? join(bin, "node_modules", "npm", "bin", "npm-cli.js") : realpathSync(join(bin, "npm"));
    return basename(cli) === "npm-cli.js" && existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

/** For cmd.exe: inside double quotes only a quote ends the argument, and no argument here needs one. */
export const quoteForCmd = (arg: string) => `"${arg.replace(/"/g, "")}"`;

let npmCli: string | null | undefined;

function runNpm(args: string[], options: { timeout: number; maxBuffer?: number }): Promise<{ err: Error | null; stdout: string; stderr: string }> {
  if (npmCli === undefined) npmCli = findNpmCli();
  const cli = npmCli;
  // npm.cmd runs only through a shell. cmd.exe searches the current directory first, so the directory is fixed below.
  const viaShell = !cli && process.platform === "win32";
  const [file, fileArgs] = cli ? [process.execPath, [cli, ...args]] : ["npm", viaShell ? args.map(quoteForCmd) : args];
  return new Promise((resolve) => {
    // Not the launch directory: an .npmrc or an npm.cmd in a project folder must not take part.
    execFile(file, fileArgs, { encoding: "utf-8", cwd: homedir(), shell: viaShell, ...options }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

/** A version that is safe to pass to npm as `tracer-sh@<version>`. */
export const isPlainVersion = (version: string) => /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version);

/** The version check names no registry, so it reads the same npm config as the install. */
export const VIEW_ARGS = ["view", "tracer-sh", "version"];

async function fetchLatestNpmVersion(): Promise<string | null> {
  const { err, stdout } = await runNpm(VIEW_ARGS, { timeout: CONFIG.npmViewTimeoutMs });
  return err ? null : stdout.trim() || null;
}

/** Returns the cached update status, or a safe default before the first check completes. */
export function getUpdateStatus(): UpdateStatus {
  if (cachedStatus) return cachedStatus;
  return {
    available: false,
    currentVersion: readCurrentVersion(),
    latestVersion: null,
    method: getInstallMethod(),
  };
}

/**
 * Query npm and update cachedStatus. A failed lookup keeps the last known
 * status, so an offline moment never hides an update that was already found.
 */
export async function checkForUpdate(fetchLatest: () => Promise<string | null> = fetchLatestNpmVersion): Promise<void> {
  // Never start an `npm view` while an install runs — concurrent npm processes
  // on the shared cache are a known source of truncated-download failures.
  if (checkInFlight || installInFlight) return;
  checkInFlight = true;
  try {
    const current = readCurrentVersion();
    await resolveGlobalRoot(resolvePackage().root);
    const method = getInstallMethod();
    const latest = current === "unknown" ? null : await fetchLatest().catch(() => null);
    if (!latest || !isPlainVersion(latest)) {
      cachedStatus ??= { available: false, currentVersion: current, latestVersion: null, method };
      return;
    }
    const available = isNewerVersion(latest, current);
    cachedStatus = { available, currentVersion: current, latestVersion: latest, method };
    if (available) {
      const hint = method !== "dev"
        ? "click the version in the sidebar to update from the app"
        : resolvePackage().root?.includes(`${sep}node_modules${sep}`)
          ? "update it with the package manager that installed it"
          : "git pull, then restart tracer-sh — the launcher rebuilds automatically";
      console.log(`Update available: v${current} → v${latest} (${hint})`);
    }
  } finally {
    checkInFlight = false;
  }
}

/** Check now, then re-check on a timer so a long-running server learns of new releases without client traffic. */
export function startUpdateChecks(): void {
  void checkForUpdate();
  setInterval(() => void checkForUpdate(), CONFIG.updateCheckIntervalMs).unref();
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

/** The install for one exact version: the one the update check found, never a moving tag. */
export function installArgs(method: "global" | "npx", root: string, version: string): string[] {
  return method === "global"
    ? ["install", "-g", `tracer-sh@${version}`]
    : ["install", "--prefix", npxPrefixDir(root), `tracer-sh@${version}`];
}

async function runNpmInstall(args: string[]): Promise<{ ok: boolean; error?: string }> {
  // Quiet flags keep output small (a verbose install can otherwise overflow
  // the stdout buffer and look like a failure); maxBuffer adds headroom for
  // native rebuild logs so a successful install is never misreported.
  const { err, stderr } = await runNpm(
    [...args, "--no-fund", "--no-audit", "--loglevel=error", "--fetch-retries=5"],
    { timeout: CONFIG.npmInstallTimeoutMs, maxBuffer: CONFIG.npmInstallMaxBufferBytes },
  );
  if (!err) return { ok: true };
  // Keep the tail — npm prints the actual error last, and full stderr
  // can run to megabytes across retries.
  const full = (stderr || "").trim() || err.message;
  return { ok: false, error: full.length > 2000 ? `…${full.slice(-2000)}` : full };
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
 * - global → `npm install -g tracer-sh@<version>`
 * - npx    → `npm install --prefix <npx cache dir> tracer-sh@<version>`; the same
 *   files bare `npx tracer-sh` resolves to, so future runs also get the update.
 * - dev    → refused; the developer or another package manager manages the copy.
 * `<version>` is the one the update check found.
 */
export async function performSelfUpdate(): Promise<SelfUpdateResult> {
  const { root } = resolvePackage();
  await resolveGlobalRoot(root);
  const method = getInstallMethod();
  if (method === "dev" || !root) {
    return {
      ok: false,
      method,
      error: root?.includes(`${sep}node_modules${sep}`)
        ? "This copy was not installed with `npm install -g`, so in-app update is disabled. Update it with the package manager that installed it."
        : "Running from a local source checkout, so in-app update is disabled.",
    };
  }
  const version = cachedStatus?.latestVersion;
  if (!version) {
    return { ok: false, method, error: "No newer version is known yet. Try again in a moment." };
  }
  // Serialize installs: a second click or tab must not start a concurrent npm
  // process on the shared cache — the very failure mode the retries fight.
  if (installInFlight) {
    return { ok: false, method, error: "An update is already in progress." };
  }
  const install = installArgs(method, root, version);

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
