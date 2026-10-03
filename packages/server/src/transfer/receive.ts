import type { Db } from "../db/driver.js";
import { seal, unseal } from "./crypto.js";
import { getSetting, recordSync } from "./peer.js";
import { importSnapshot, type Snapshot } from "./snapshot.js";
import { exportSyncPayload, mergeSyncPayload, type SyncPayload } from "./sync.js";

export const COPY_LINK_PREFIX = "tracer://copy";

export const MAX_NAME_LENGTH = 64;
export const DEVICE_ID = /^[A-Za-z0-9-]{1,64}$/;
export const APPROVAL_WINDOW_MS = 120_000;
const FETCH_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1000;

export type SyncMode = "merge" | "replace";

// Only addresses on the local network: a link from elsewhere must not pull data from the internet.
const PRIVATE_IPV4 = /^(10\.\d+|172\.(1[6-9]|2\d|3[01])|192\.168|169\.254)\.\d+\.\d+$/;

/** Reads a copy link from a QR code. Throws when it is not one. */
export function parseCopyLink(link: string): { from: URL; key: string; name?: string; device?: string } {
  if (!link.startsWith(`${COPY_LINK_PREFIX}?`)) throw new Error("This is not a Tracer copy code.");
  const params = new URLSearchParams(link.slice(COPY_LINK_PREFIX.length + 1));
  let from: URL | null = null;
  // Not URL.parse: it needs iOS 18.
  try { from = new URL(params.get("from") ?? ""); } catch { /* checked below */ }
  const key = params.get("key");
  if (!from || from.protocol !== "http:" || !PRIVATE_IPV4.test(from.hostname) || !key) {
    throw new Error("This is not a Tracer copy code.");
  }
  // Shown to the user, so it is untrusted text: no control characters, bounded length.
  const name = (params.get("name") ?? "").replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "").trim().slice(0, MAX_NAME_LENGTH);
  const device = params.get("device") ?? "";
  return { from, key, ...(name && { name }), ...(DEVICE_ID.test(device) && { device }) };
}

/** Decides what a scan does: sync with the computer this phone synced with before, otherwise replace. */
export async function inspectCopy(db: Db, link: string): Promise<{ mode: SyncMode; name: string; address: string }> {
  const { from, name, device } = parseCopyLink(link);
  const mode = device && device === (await getSetting(db, "sync_peer_id")) ? "merge" : "replace";
  return { mode, name: name ?? "", address: from.hostname };
}

const UNREACHABLE = "The computer does not answer. Make sure the phone and the computer use the same Wi-Fi. If iOS asks for Local Network access, allow it. Then scan the code again.";
const EXPIRED = "This code is used or expired. Show a new code on the computer.";

async function call(url: URL, init: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<{ status: number; text: string }> {
  const abort = new AbortController();
  // Covers the body too: a server that stops mid-body must not hang the import.
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    // A redirect could lead off the local network.
    const response = await fetch(url, { ...init, signal: abort.signal, redirect: "error" });
    return { status: response.status, text: await response.text() };
  } catch {
    throw new Error(UNREACHABLE);
  } finally {
    clearTimeout(timer);
  }
}

function check({ status, text }: { status: number; text: string }): string {
  if (status === 404) throw new Error(EXPIRED);
  if (status === 409) throw new Error(text || "The computer is busy. Show a new code and try again.");
  if (status !== 200) throw new Error(`The computer returned error ${status}. Show a new code and try again.`);
  return text;
}

async function open<T>(text: string, key: string): Promise<T> {
  try {
    return JSON.parse(await unseal(text, key)) as T;
  } catch {
    throw new Error("The copy does not decrypt. Show a new code on the computer and scan it again.");
  }
}

async function awaitApproval(url: URL): Promise<void> {
  const deadline = Date.now() + APPROVAL_WINDOW_MS + 5000;
  for (;;) {
    const { state } = JSON.parse(check(await call(url, {}, 10_000))) as { state: string };
    if (state === "approved") return;
    if (state === "denied") throw new Error("The computer denied the request.");
    if (state === "expired" || Date.now() > deadline) throw new Error("Nobody approved the request on the computer in time. Show a new code and try again.");
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Asks the computer for approval, then replaces this database with its copy or merges both databases.
 * `beforeImport` runs once the data has arrived, so it can refuse when work started in the meantime.
 */
export async function receiveCopy(db: Db, link: string, beforeImport?: () => void): Promise<{ mode: SyncMode; counts: Record<string, number> }> {
  const { from, key, name, device } = parseCopyLink(link);
  const { mode } = await inspectCopy(db, link);
  const at = (suffix: string) => new URL(from.pathname + suffix, from);

  const deviceId = (await getSetting(db, "device_id")) ?? "";
  const request = await seal(JSON.stringify({ deviceId, name: `iPhone ${deviceId.slice(-4)}`, mode }), key);
  check(await call(at("/request"), { method: "POST", body: request }, 15_000));
  await awaitApproval(at("/status"));

  let counts: Record<string, number>;
  if (mode === "replace") {
    const snapshot = await open<Snapshot>(check(await call(at(""), {})), key);
    beforeImport?.();
    // The computer keeps running its monitors; the same alerts must not reach Slack twice.
    counts = await importSnapshot(db, snapshot, { pauseMonitors: true });
  } else {
    const sent = await seal(JSON.stringify(await exportSyncPayload(db)), key);
    const remote = await open<SyncPayload>(check(await call(at("/merge"), { method: "POST", body: sent })), key);
    beforeImport?.();
    counts = (await mergeSyncPayload(db, remote)).applied;
  }
  await recordSync(db, { id: device, name: name ?? "" });
  return { mode, counts };
}
