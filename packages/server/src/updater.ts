import { exec } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Exit code that signals the launcher to restart the server after an update. */
export const RESTART_EXIT_CODE = 75;

interface UpdateStatus {
  available: boolean;
  currentVersion: string;
  latestVersion: string | null;
}

let cachedStatus: UpdateStatus | null = null;

function readCurrentVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    // Walk up from dist/ to find root package.json
    for (const candidate of [
      join(__dirname, "../package.json"),
      join(__dirname, "../../package.json"),
      join(__dirname, "../../../package.json"),
    ]) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
        if (pkg.name === "oko-sh" && pkg.version) return pkg.version;
      } catch { /* try next */ }
    }
  } catch { /* fallback */ }
  return "unknown";
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
    exec("npm view oko-sh version", { encoding: "utf-8", timeout: 10_000 }, (err, stdout) => {
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
  };
}

/** Fire-and-forget background update check. Populates cachedStatus for tRPC queries. */
export function checkForUpdateBackground(): void {
  const current = readCurrentVersion();
  if (current === "unknown") {
    cachedStatus = { available: false, currentVersion: current, latestVersion: null };
    return;
  }

  fetchLatestNpmVersion().then((latest) => {
    if (!latest) {
      cachedStatus = { available: false, currentVersion: current, latestVersion: null };
      return;
    }
    const available = isNewerVersion(latest, current);
    cachedStatus = { available, currentVersion: current, latestVersion: latest };
    if (available) {
      console.log(`Update available: v${current} → v${latest} (run: npm update -g oko-sh)`);
    }
  }).catch(() => {
    cachedStatus = { available: false, currentVersion: current, latestVersion: null };
  });
}
