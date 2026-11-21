import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isSecret, randomSecret } from "../transfer/crypto.js";

const NO_LINK_CODES = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);

const loose = (path: string) => (statSync(path).mode & 0o077) !== 0;

function readToken(path: string, chmod: typeof chmodSync): string | null {
  if (!existsSync(path)) return null;
  // Windows has no mode bits to check.
  if (process.platform !== "win32" && loose(path)) {
    // A file system without POSIX modes (exFAT, SMB) shows loose bits on every file and keeps them after a chmod.
    // Where the chmod works, other accounts could read the file: its secret is not used, and the file goes so
    // that no later read takes it.
    let modes = true;
    try { chmod(path, 0o600); modes = !loose(path); } catch { /* not the owner, or no chmod here: the secret is not used */ }
    if (modes) {
      try { unlinkSync(path); } catch { /* the rename below replaces it */ }
      return null;
    }
  }
  const value = readFileSync(path, "utf8").trim();
  return isSecret(value) ? value : null;
}

/**
 * The secret that the web app and the CLI send as a bearer credential, from `<tracerHome>/session-token`.
 * The file survives restarts so a restart or an update keeps the browser signed in.
 */
export function loadSessionToken(tracerHome: string, chmod: typeof chmodSync = chmodSync, link: typeof linkSync = linkSync): string {
  const path = join(tracerHome, "session-token");
  const existing = readToken(path, chmod);
  if (existing) return existing;
  const fresh = randomSecret();
  // A random name: a temp file that a killed process left behind must not stop the start.
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    // "wx" refuses to follow a planted file. A link, unlike a rename, fails when the file exists:
    // a process that starts at the same moment then uses the secret of the first one.
    writeFileSync(tmp, fresh, { mode: 0o600, flag: "wx" });
    try {
      link(tmp, path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (code !== "EEXIST" && !NO_LINK_CODES.has(code)) throw err;
      const winner = readToken(path, chmod);
      if (winner) return winner;
      // No hard links on this file system, or the file holds no valid secret.
      renameSync(tmp, path);
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* temp file may not exist */ }
  }
  return fresh;
}
