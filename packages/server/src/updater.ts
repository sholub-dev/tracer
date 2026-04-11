import { execSync, spawnSync, exec } from "node:child_process";
import { readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OKO_HOME } from "./db/client.js";

const REPO = "sholub1989/oko";
const VERSION_FILE = join(OKO_HOME, ".version");
const APP_DIR = join(OKO_HOME, "app");
/** Exit code that signals the launcher to restart the server after an update. */
export const RESTART_EXIT_CODE = 75;

interface UpdateStatus {
  available: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  latestTag: string | null;
  tarballUrl: string | null;
}

let cachedStatus: UpdateStatus | null = null;

function readCurrentVersion(): string | null {
  try {
    return readFileSync(VERSION_FILE, "utf-8").trim();
  } catch {
    return null;
  }
}

function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

function execAsync(cmd: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: "utf-8", timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

async function fetchLatestRelease(): Promise<{ tag: string; tarballUrl: string } | null> {
  try {
    // Try gh CLI first (works for private repos)
    const json = await execAsync(`gh api repos/${REPO}/releases/latest --jq '.tag_name + " " + .assets[0].url'`);
    const [tag, url] = json.split(" ");
    if (tag && url) return { tag, tarballUrl: url };
  } catch {
    // Fallback to public curl (works for public repos)
    try {
      const json = await execAsync(`curl -sfL https://api.github.com/repos/${REPO}/releases/latest`);
      const data = JSON.parse(json);
      const asset = data.assets?.[0];
      if (data.tag_name && asset?.browser_download_url) {
        return { tag: data.tag_name, tarballUrl: asset.browser_download_url };
      }
    } catch { /* offline or no releases */ }
  }
  return null;
}

function performUpdate(tag: string, tarballUrl: string): void {
  const tmp = join(tmpdir(), `oko-update-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });

  try {
    // Download asset
    const tarball = join(tmp, "oko.tar.gz");
    try {
      execSync(`gh api "${tarballUrl}" -H "Accept: application/octet-stream" > "${tarball}"`, { stdio: ["pipe", "pipe", "pipe"], timeout: 60_000 });
    } catch {
      execSync(`curl -sfL -o "${tarball}" "${tarballUrl}"`, { stdio: ["pipe", "pipe", "pipe"], timeout: 60_000 });
    }

    // Extract
    const extractDir = join(tmp, "extracted");
    mkdirSync(extractDir, { recursive: true });
    execSync(`tar -xzf "${tarball}" -C "${extractDir}"`, { stdio: "pipe" });

    // Install production dependencies and rebuild native modules for this Node version
    spawnSync("npm", ["install", "--production", "--no-audit", "--no-fund"], {
      cwd: extractDir,
      stdio: "inherit",
      timeout: 120_000,
    });
    spawnSync("npm", ["rebuild"], {
      cwd: extractDir,
      stdio: "inherit",
      timeout: 120_000,
    });

    // Swap app directory
    const backupDir = join(OKO_HOME, "app.bak");
    if (existsSync(APP_DIR)) {
      if (existsSync(backupDir)) rmSync(backupDir, { recursive: true });
      renameSync(APP_DIR, backupDir);
    }
    renameSync(extractDir, APP_DIR);

    // Write new version
    writeFileSync(VERSION_FILE, tag.replace(/^v/, ""));

    // Update launcher to latest version (picks up any startup improvements)
    const launcherPath = join(OKO_HOME, "bin", "oko");
    if (existsSync(launcherPath)) {
      const launcher = [
        "#!/bin/sh",
        'OKO_HOME="${HOME}/.oko"',
        "export OKO_HOME",
        'SERVER="${OKO_HOME}/app/dist/index.js"',
        'cd "$HOME"',
        "",
        "# Rebuild native modules if compiled for a different Node version",
        "node -e \"require('${OKO_HOME}/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node')\" 2>/dev/null || (",
        '  echo "Rebuilding native modules for Node $(node --version)..."',
        '  cd "${OKO_HOME}/app" && npm rebuild --silent',
        ")",
        "",
        "while true; do",
        '  node "$SERVER" "$@"',
        "  EXIT_CODE=$?",
        '  [ "$EXIT_CODE" -ne 75 ] && exit $EXIT_CODE',
        '  echo ""',
        '  echo "Restarting after update..."',
        '  echo ""',
        "done",
      ].join("\n") + "\n";
      writeFileSync(launcherPath, launcher);
      chmodSync(launcherPath, 0o755);
    }

    // Clean up backup
    if (existsSync(backupDir)) rmSync(backupDir, { recursive: true });

    console.log(`Updated to ${tag}. Restarting...`);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true });
  }
}

/** Returns the cached update status, or a safe default if the background check hasn't completed. */
export function getUpdateStatus(): UpdateStatus {
  if (cachedStatus) return cachedStatus;
  return {
    available: false,
    currentVersion: readCurrentVersion(),
    latestVersion: null,
    latestTag: null,
    tarballUrl: null,
  };
}

/** Applies the cached update and exits with RESTART_EXIT_CODE. Throws if no update is available. */
export function applyUpdate(): void {
  if (!cachedStatus?.available || !cachedStatus.latestTag || !cachedStatus.tarballUrl) {
    throw new Error("No update available to apply.");
  }
  performUpdate(cachedStatus.latestTag, cachedStatus.tarballUrl);
  // Delay exit to let the tRPC response reach the client
  setTimeout(() => process.exit(RESTART_EXIT_CODE), 500);
}

/** Fire-and-forget background update check. Populates cachedStatus for tRPC queries. */
export function checkForUpdateBackground(): void {
  const current = readCurrentVersion();
  if (!current) {
    // No version file = dev mode, skip update check
    cachedStatus = { available: false, currentVersion: null, latestVersion: null, latestTag: null, tarballUrl: null };
    return;
  }

  // Run the network check without blocking server startup
  fetchLatestRelease().then((release) => {
    if (!release) {
      cachedStatus = { available: false, currentVersion: current, latestVersion: null, latestTag: null, tarballUrl: null };
      return;
    }
    const available = isNewerVersion(release.tag, current);
    cachedStatus = {
      available,
      currentVersion: current,
      latestVersion: release.tag.replace(/^v/, ""),
      latestTag: release.tag,
      tarballUrl: release.tarballUrl,
    };
    if (available) {
      console.log(`Update available: v${current} → ${release.tag}`);
    }
  }).catch((err) => {
    console.warn("Update check failed:", err);
    cachedStatus = { available: false, currentVersion: current, latestVersion: null, latestTag: null, tarballUrl: null };
  });
}
