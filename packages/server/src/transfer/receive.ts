import type { SyncCounts, SyncMode, SyncSession } from "@tracer-sh/shared";
import type { Db } from "../db/driver.js";
import { MAX_BODY_BYTES, OldFormError, seal, TooLargeError, unseal } from "./crypto.js";
import { getMark, getSetting, recordSync, setMark } from "./peer.js";
import { FORMAT, importSnapshot, type Snapshot } from "./snapshot.js";
import { exportSyncPayload, mergeSyncPayload, type SyncPayload } from "./sync.js";

export const COPY_LINK_PREFIX = "tracer://copy";

export const MAX_NAME_LENGTH = 64;
export const DEVICE_ID = /^[A-Za-z0-9-]{1,64}$/;
export const APPROVAL_WINDOW_MS = 120_000;
// A large copy on a slow Wi-Fi needs minutes, and the computer compresses before it answers.
const FETCH_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 1000;
// The computer shows the progress of the transfer; twice a second is enough.
const REPORT_INTERVAL_MS = 500;

export type { SyncMode };

// Only addresses on the local network: a link from elsewhere must not pull data from the internet.
const PRIVATE_IPV4 = /^(10\.\d{1,3}|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}$/;

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
const INTERRUPTED = "The connection broke during the transfer. Stay on the same Wi-Fi, keep Tracer open, then show a new code and try again.";
const TOO_SLOW = "The transfer took too long and stopped. Move closer to the Wi-Fi router, then show a new code and try again.";
const CANCELLED = "The sync was cancelled.";

interface CallOptions {
  timeoutMs?: number;
  /** A failure of a call that moves the data is a broken transfer, not an unreachable computer. */
  transfer?: boolean;
  /** Stops the call when the person cancels. */
  signal?: AbortSignal;
  onBytes?: (done: number, total: number) => void;
}

/** Reads the body but stops at the size limit, so a computer that streams without end cannot fill the memory before the decrypt. */
async function readCapped(response: Response, onBytes?: CallOptions["onBytes"]): Promise<string> {
  const tooLarge = () => new TooLargeError("The computer sent more data than the limit allows. Delete sessions you do not need on the computer, then try again.");
  const total = Number(response.headers.get("content-length")) || 0;
  if (total > MAX_BODY_BYTES) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  for (let part = await reader?.read(); part && !part.done; part = await reader!.read()) {
    size += part.value.length;
    if (size > MAX_BODY_BYTES) { await reader!.cancel(); throw tooLarge(); }
    chunks.push(part.value);
    onBytes?.(size, total);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return new TextDecoder().decode(bytes);
}

async function call(url: URL, init: RequestInit, { timeoutMs = 15_000, transfer = false, signal, onBytes }: CallOptions = {}): Promise<{ status: number; text: string }> {
  if (signal?.aborted) throw new Error(CANCELLED);
  const abort = new AbortController();
  // Covers the body too: a server that stops mid-body must not hang the import.
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const cancel = () => abort.abort();
  signal?.addEventListener("abort", cancel);
  try {
    // A redirect could lead off the local network.
    const response = await fetch(url, { ...init, signal: abort.signal, redirect: "error" });
    return { status: response.status, text: await readCapped(response, onBytes) };
  } catch (err) {
    if (err instanceof TooLargeError) throw err;
    if (signal?.aborted) throw new Error(CANCELLED);
    throw new Error(!transfer ? UNREACHABLE : abort.signal.aborted ? TOO_SLOW : INTERRUPTED);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

function check({ status, text }: { status: number; text: string }): string {
  if (status === 404) throw new Error(EXPIRED);
  if (status === 409) throw new Error(text || "The computer is busy. Show a new code and try again.");
  if (status === 413 && text) throw new Error(text);
  if (status === 408) throw new Error("The computer stopped waiting for the data from this phone. Move closer to the Wi-Fi router, then show a new code and try again.");
  if (status === 403) throw new Error("The computer refused the request. Show a new code on the computer and scan it again.");
  if (status === 500) throw new Error("The computer failed while it prepared the data. Show a new code and try again. If it fails again, restart Tracer on the computer.");
  if (status !== 200) throw new Error(`The computer returned error ${status}. Show a new code and try again.`);
  return text;
}

const UPDATE_COMPUTER = "Update Tracer on the computer to the same version as the phone, then show a new code.";
const UPDATE_PHONE = "Update Tracer on the phone to the same version as the computer, then scan the code again.";

async function open<T>(text: string, key: string): Promise<T> {
  try {
    return JSON.parse(await unseal(text, key)) as T;
  } catch (err) {
    if (err instanceof OldFormError) throw new Error(UPDATE_COMPUTER);
    if (err instanceof TooLargeError) throw err;
    throw new Error("The data does not decrypt. Show a new code on the computer and scan it again.");
  }
}

type PhoneSession = SyncSession & { format?: number };
type OwnPhase = "approval" | "transfer" | "apply" | "done" | "failed" | "cancelled";

/** What this phone knows about the running sync; the computer's last answer fills in the rest. */
interface Job {
  abort: AbortController;
  mode: SyncMode;
  computerName: string;
  phoneName: string;
  expiresAt: number;
  remote?: SyncSession;
  own: { phase: OwnPhase; reached?: SyncSession["reached"]; bytes?: SyncSession["bytes"]; result?: SyncCounts; error?: string };
  /** Reports to the computer go out in order. */
  reports: Promise<void>;
}

const RANK: string[] = ["waiting", "approval", "transfer", "apply"];
const ENDED = new Set(["denied", "expired", "cancelled", "failed"]);

let job: Job | null = null;

const endedByComputer = (j: Job) => ENDED.has(j.remote?.phase ?? "");
const finished = (j: Job) => j.own.phase === "done" || j.own.phase === "failed" || j.own.phase === "cancelled" || endedByComputer(j);

/** The phone's view of the sync: the last answer of the computer, overlaid with what the phone itself did. */
export function receiveStatus(): SyncSession | null {
  if (!job) return null;
  const { remote, own, mode, computerName, phoneName, expiresAt } = job;
  const base = { mode, computerName, phoneName, expiresAt: remote?.expiresAt ?? expiresAt };
  const computer = remote?.result?.computer;
  if (own.phase === "failed" || own.phase === "cancelled") {
    const phase = own.reached ?? "approval";
    const reached = RANK.indexOf(remote?.phase ?? "") > RANK.indexOf(phase) ? (remote!.phase as SyncSession["reached"]) : phase;
    const error = own.phase === "failed" ? { message: own.error ?? "The sync failed.", side: "phone" as const } : { message: "Cancelled on the phone.", side: "phone" as const };
    return { ...base, phase: own.phase, reached, bytes: own.bytes, result: { computer }, error };
  }
  if (own.phase === "done") return { ...base, phase: "done", bytes: own.bytes, result: { computer, phone: own.result } };
  if (remote && ENDED.has(remote.phase)) return remote;
  const phase = RANK.indexOf(own.phase) > RANK.indexOf(remote?.phase ?? "waiting") ? own.phase : remote?.phase ?? own.phase;
  return { ...base, phase, bytes: own.bytes ?? remote?.bytes, result: { computer, phone: own.result ?? remote?.result?.phone } };
}

const ENDED_BY_COMPUTER: Record<string, string> = {
  denied: "The computer denied the request.",
  expired: "Nobody approved the request on the computer in time. Show a new code and try again.",
  cancelled: "The computer cancelled the sync.",
  failed: "The sync failed on the computer. Show a new code and try again.",
};

/** An older computer does not report its format. */
function checkVersion(status: PhoneSession): void {
  if (status.format === undefined || status.format < FORMAT) throw new Error(UPDATE_COMPUTER);
  if (status.format > FORMAT) throw new Error(UPDATE_PHONE);
}

async function readStatus(current: Job, url: URL, options: CallOptions): Promise<PhoneSession> {
  const status = JSON.parse(check(await call(url, {}, options))) as PhoneSession;
  if (typeof status.phase === "string") {
    const { format: _format, ...session } = status;
    current.remote = session;
  }
  return status;
}

async function awaitApproval(current: Job, url: URL, options: CallOptions): Promise<void> {
  const deadline = Date.now() + APPROVAL_WINDOW_MS + 5000;
  for (;;) {
    const { phase } = await readStatus(current, url, options);
    if (phase === "transfer") return;
    if (ENDED_BY_COMPUTER[phase]) throw new Error(ENDED_BY_COMPUTER[phase]);
    if (Date.now() > deadline) throw new Error(ENDED_BY_COMPUTER.expired);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, POLL_INTERVAL_MS);
      options.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}

const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);

async function run(db: Db, link: string, current: Job, beforeImport?: () => void): Promise<{ mode: SyncMode; counts: Record<string, number> }> {
  const { from, key, name, device } = parseCopyLink(link);
  const { mode, abort: { signal }, own } = current;
  const at = (suffix: string) => new URL(from.pathname + suffix, from);
  const stopped = () => { if (signal.aborted) throw new Error(CANCELLED); };
  const report = (body: Record<string, unknown>) => {
    current.reports = current.reports.then(async () => {
      try {
        // Not tied to the cancel signal: the report that follows a cancel still has to leave.
        check(await call(at("/progress"), { method: "POST", body: await seal(JSON.stringify(body), key) }, { timeoutMs: 5000 }));
      } catch { /* best effort: the computer learns of a lost report when its wait ends */ }
    });
    return current.reports;
  };

  try {
    checkVersion(await readStatus(current, at("/status"), { signal }));
    const deviceId = (await getSetting(db, "device_id")) ?? "";
    const request = await seal(JSON.stringify({ deviceId, name: current.phoneName, mode, format: FORMAT }), key);
    check(await call(at("/request"), { method: "POST", body: request }, { signal }));
    await awaitApproval(current, at("/status"), { signal });

    own.phase = "transfer";
    let reportedAt = 0;
    const onBytes = (done: number, size: number) => {
      own.bytes = { done, total: size };
      if (Date.now() - reportedAt < REPORT_INTERVAL_MS) return;
      reportedAt = Date.now();
      void report({ phase: "transfer", bytes: own.bytes });
    };
    const transfer = { timeoutMs: FETCH_TIMEOUT_MS, transfer: true, signal, onBytes };

    let counts: Record<string, number>;
    let result: SyncCounts;
    if (mode === "replace") {
      const text = check(await call(at(""), {}, transfer));
      stopped();
      own.phase = "apply";
      void report({ phase: "apply", bytes: own.bytes });
      const { at: theirs, snapshot } = await open<{ at: number; snapshot: Snapshot }>(text, key);
      beforeImport?.();
      // The computer keeps its follow-up timers; the same re-check must not run on both devices.
      counts = await importSnapshot(db, snapshot, { dropTimers: true });
      result = { applied: total(counts), deleted: 0 };
      // The import wrote the whole change log just now; the next merge needs to send none of it back.
      if (device) await setMark(db, device, { mine: Date.now(), theirs });
    } else {
      const mark = device ? await getMark(db, device) : undefined;
      // Taken before the export: a change made while the exchange runs is sent next time.
      const startedAt = Date.now();
      const sent = await seal(JSON.stringify({ since: mark?.theirs, payload: await exportSyncPayload(db, mark?.mine) }), key);
      const text = check(await call(at("/merge"), { method: "POST", body: sent }, transfer));
      stopped();
      own.phase = "apply";
      void report({ phase: "apply", bytes: own.bytes });
      const { at: theirs, payload } = await open<{ at: number; payload: SyncPayload }>(text, key);
      beforeImport?.();
      const merged = await mergeSyncPayload(db, payload);
      counts = merged.applied;
      result = { applied: total(merged.applied), deleted: total(merged.deleted) };
      if (device) await setMark(db, device, { mine: startedAt, theirs });
    }
    await recordSync(db, { id: device, name: name ?? "" });
    // The computer counted its part before it answered.
    await readStatus(current, at("/status"), { timeoutMs: 3000 }).catch(() => undefined);
    own.result = result;
    own.phase = "done";
    await report({ phase: "done", bytes: own.bytes, result });
    return { mode, counts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (own.phase !== "done" && own.phase !== "failed" && own.phase !== "cancelled") own.reached = own.phase;
    if (signal.aborted) {
      own.phase = "cancelled";
      try { await call(at("/cancel"), { method: "POST", body: await seal("{}", key) }, { timeoutMs: 5000 }); } catch { /* best effort: the wait on the computer ends by itself */ }
    } else {
      // The computer may have ended the sync and may say why.
      if (!endedByComputer(current)) await readStatus(current, at("/status"), { timeoutMs: 3000 }).catch(() => undefined);
      if (!endedByComputer(current)) {
        own.phase = "failed";
        own.error = message;
        await report({ phase: "failed", error: message });
      }
    }
    await current.reports;
    throw err;
  }
}

/**
 * Starts the sync and returns at once. `receiveStatus` shows how it goes.
 * `done` settles when the sync ends. `beforeImport` runs once the data has arrived,
 * so it can refuse when work started in the meantime.
 */
export async function startReceive(db: Db, link: string, beforeImport?: () => void): Promise<{ done: Promise<{ mode: SyncMode; counts: Record<string, number> }>; session: SyncSession }> {
  if (job && !finished(job)) {
    throw new Error("A sync is already running on this phone.");
  }
  const { name } = parseCopyLink(link);
  const { mode } = await inspectCopy(db, link);
  const deviceId = (await getSetting(db, "device_id")) ?? "";
  const current: Job = {
    abort: new AbortController(),
    mode,
    computerName: name ?? "",
    phoneName: `iPhone ${deviceId.slice(-4)}`,
    expiresAt: Date.now() + APPROVAL_WINDOW_MS,
    own: { phase: "approval" },
    reports: Promise.resolve(),
  };
  job = current;
  const done = run(db, link, current, beforeImport);
  return { done, session: receiveStatus()! };
}

/** Stops the sync and tells the computer. Once the phone writes the data, the sync runs to its end. */
export async function cancelReceive(): Promise<void> {
  const current = job;
  if (!current || current.own.phase === "apply" || finished(current)) return;
  current.abort.abort();
}

/** Asks the computer for approval, then replaces this database with its copy or merges both databases. */
export async function receiveCopy(db: Db, link: string, beforeImport?: () => void): Promise<{ mode: SyncMode; counts: Record<string, number> }> {
  return (await startReceive(db, link, beforeImport)).done;
}
