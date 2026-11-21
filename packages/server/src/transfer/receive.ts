import type { SyncCounts, SyncMode, SyncSession } from "@tracer-sh/shared";
import type { Db } from "../db/driver.js";
import { localDeviceId } from "../db/config-reader.js";
import { deriveSessionKey, isSecret, MAX_BODY_BYTES, newExchangeKey, OldFormError, seal, TooLargeError, unseal, verificationCode, type SealLabel } from "./crypto.js";
import { getMark, getPairing, getSetting, recordSync, setMark, setPairing } from "./peer.js";
import { FORMAT, importSnapshot, type Snapshot } from "./snapshot.js";
import { exportSyncPayload, mergeSyncPayload, type SyncPayload } from "./sync.js";

export const COPY_LINK_PREFIX = "tracer://copy";

export const MAX_NAME_LENGTH = 64;
export const DEVICE_ID = /^[A-Za-z0-9-]{1,64}$/;
export const APPROVAL_WINDOW_MS = 120_000;
/** Carries the proof of the session key ahead of a merge upload, so the computer reads the upload of this phone only. */
export const PROOF_HEADER = "x-tracer-proof";
// A large copy on a slow Wi-Fi needs minutes, and the computer compresses before it answers.
const FETCH_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 1000;
// The computer shows the progress of the transfer; twice a second is enough.
const REPORT_INTERVAL_MS = 500;

// Only addresses on the local network: a link from elsewhere must not pull data from the internet.
const PRIVATE_IPV4 = /^(10\.\d{1,3}|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}$/;

/** Untrusted text that is shown to the user: no control characters, bounded length. */
export const cleanText = (text: string, max: number) => text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "").trim().slice(0, max);

export const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);

type CopyLink = { from: URL; key: string; name?: string; device?: string; pk?: string };
const EXCHANGE_KEY = /^[A-Za-z0-9_-]{87}$/;

/** Reads a copy link from a QR code. Throws when it is not one. */
export function parseCopyLink(link: string): CopyLink {
  if (!link.startsWith(`${COPY_LINK_PREFIX}?`)) throw new Error("This is not a Tracer copy code.");
  const params = new URLSearchParams(link.slice(COPY_LINK_PREFIX.length + 1));
  let from: URL | null = null;
  // Not URL.parse: it needs iOS 18.
  try { from = new URL(params.get("from") ?? ""); } catch { /* checked below */ }
  const key = params.get("key");
  if (from?.protocol !== "http:" || !PRIVATE_IPV4.test(from.hostname) || !key) {
    throw new Error("This is not a Tracer copy code.");
  }
  const name = cleanText(params.get("name") ?? "", MAX_NAME_LENGTH);
  const device = params.get("device") ?? "";
  const pk = params.get("pk") ?? "";
  return { from, key, ...(name && { name }), ...(DEVICE_ID.test(device) && { device }), ...(EXCHANGE_KEY.test(pk) && { pk }) };
}

const UPDATE_COMPUTER = "Update Tracer on the computer to the same version as the phone, then show a new code.";
const UPDATE_PHONE = "Update Tracer on the phone to the same version as the computer, then scan the code again.";

type PairLink = CopyLink & { device: string; pk: string };

/** A code from an older computer has no exchange key. */
function parsePairLink(link: string): PairLink {
  const copy = parseCopyLink(link);
  if (!copy.device || !copy.pk) throw new Error(UPDATE_COMPUTER);
  return copy as PairLink;
}

const modeFor = (pairing: string | undefined): SyncMode => (pairing ? "merge" : "replace");

/**
 * Decides what a scan does. The phone merges only with a computer whose pairing secret it holds; otherwise it replaces.
 * `pairedBefore`: the phone synced with this computer, but holds no pairing secret for it now.
 */
export async function inspectCopy(db: Db, link: string): Promise<{ mode: SyncMode; name: string; address: string; pairedBefore: boolean }> {
  const { from, name, device } = parsePairLink(link);
  const mode = modeFor(await getPairing(db, device));
  return { mode, name: name ?? "", address: from.hostname, pairedBefore: mode === "replace" && device === (await getSetting(db, "sync_peer_id")) };
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
  // The text comes from the other device and is shown as it is.
  const said = cleanText(text, 500);
  if (status === 409) throw new Error(said || "The computer is busy. Show a new code and try again.");
  if (status === 413 && said) throw new Error(said);
  if (status === 408) throw new Error("The computer stopped waiting for the data from this phone. Move closer to the Wi-Fi router, then show a new code and try again.");
  if (status === 403) throw new Error("The computer refused the request. Show a new code on the computer and scan it again.");
  if (status === 500) throw new Error("The computer failed while it prepared the data. Show a new code and try again. If it fails again, restart Tracer on the computer.");
  if (status !== 200) throw new Error(`The computer returned error ${status}. Show a new code and try again.`);
  return text;
}

const NO_DECRYPT = "The data does not decrypt. Show a new code on the computer and scan it again.";
const NOT_THE_PAIRED_COMPUTER = "The computer did not prove that it is the computer this phone is paired with, so the phone sent no data. Sync only with your own computer. If this is your computer, open Settings > Phone on the phone, tap Forget computer, then scan a new code.";
const DAMAGED = "The data from the computer is damaged. Show a new code and try again.";

async function open<T>(text: string, key: string, label: SealLabel): Promise<T> {
  try {
    return JSON.parse(await unseal(text, key, label)) as T;
  } catch (err) {
    if (err instanceof OldFormError) throw new Error(UPDATE_COMPUTER);
    if (err instanceof TooLargeError) throw err;
    throw new Error(NO_DECRYPT);
  }
}

/** The time on the computer's clock becomes the sync mark, so it must be a real number before anything is written. */
function checkTime(at: unknown): asserts at is number {
  if (typeof at !== "number" || !Number.isFinite(at)) throw new Error(DAMAGED);
}

type OwnPhase = "approval" | "transfer" | "apply" | "done" | "failed" | "cancelled";

/** What this phone knows about the running sync; the computer's last answer fills in the rest. */
interface Job {
  copy: PairLink;
  deviceId: string;
  /** The secret from the first sync with this computer. With it the sync is a merge. */
  pairing?: string;
  /** Seals everything after the request. Set once the computer proved that it holds the same key. */
  key?: string;
  /** Computed on this phone, never taken from the computer. */
  code?: string;
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
  const { remote, own, mode, computerName, phoneName, expiresAt, code } = job;
  const base = { mode, computerName, phoneName, code, expiresAt: remote?.expiresAt ?? expiresAt };
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

/** An older computer does not report its format, or reports a lower one. */
function checkVersion(format: unknown): void {
  if (typeof format !== "number" || format < FORMAT) throw new Error(UPDATE_COMPUTER);
  if (format > FORMAT) throw new Error(UPDATE_PHONE);
}

/** The format is plain text and only selects the update message. The session itself comes sealed. */
async function fetchStatus(url: URL, options: CallOptions): Promise<string> {
  let reply: { format?: unknown; sealed?: unknown } = {};
  try { reply = (JSON.parse(check(await call(url, {}, options))) ?? {}) as typeof reply; } catch (err) { if (!(err instanceof SyntaxError)) throw err; }
  checkVersion(reply.format);
  return String(reply.sealed);
}

async function readStatus(current: Job, url: URL, options: CallOptions): Promise<SyncSession> {
  if (!current.key) throw new Error(NO_DECRYPT);
  const session = await open<SyncSession>(await fetchStatus(url, options), current.key, "status");
  if (typeof session?.phase !== "string") throw new Error(NO_DECRYPT);
  current.remote = session;
  return session;
}

async function awaitApproval(current: Job, url: URL, options: CallOptions): Promise<void> {
  const deadline = Date.now() + APPROVAL_WINDOW_MS + 5000;
  for (;;) {
    const { phase } = await readStatus(current, url, options);
    if (phase === "transfer") return;
    if (ENDED_BY_COMPUTER[phase]) throw new Error(ENDED_BY_COMPUTER[phase]);
    if (Date.now() > deadline) throw new Error(ENDED_BY_COMPUTER.expired);
    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", wake);
        resolve();
      };
      const timer = setTimeout(wake, POLL_INTERVAL_MS);
      options.signal?.addEventListener("abort", wake, { once: true });
    });
  }
}

async function run(db: Db, current: Job, beforeImport?: () => void): Promise<{ mode: SyncMode; counts: Record<string, number> }> {
  const { copy, deviceId, pairing, mode, abort: { signal }, own } = current;
  const { from, name, device, pk } = copy;
  const at = (suffix: string) => new URL(from.pathname + suffix, from);
  const stopped = () => { if (signal.aborted) throw new Error(CANCELLED); };
  // A cancel on the computer does not cut a transfer under way, so the phone asks before it writes anything.
  const beforeWrite = async () => {
    await readStatus(current, at("/status"), { signal, timeoutMs: 3000 }).catch(() => undefined);
    stopped();
    if (endedByComputer(current)) throw new Error(ENDED_BY_COMPUTER[current.remote!.phase]);
  };
  const report = (body: Record<string, unknown>) => {
    current.reports = current.reports.then(async () => {
      // Without a session key the computer is not proven, so nothing more goes to it.
      const key = current.key;
      if (!key) return;
      try {
        // Not tied to the cancel signal: the report that follows a cancel still has to leave.
        check(await call(at("/progress"), { method: "POST", body: await seal(JSON.stringify(body), key, "progress") }, { timeoutMs: 5000 }));
      } catch { /* best effort: the computer learns of a lost report when its wait ends */ }
    });
    return current.reports;
  };

  // The request left, and no answer came: the computer may show a prompt for a phone that is gone.
  let unanswered = false;

  try {
    await fetchStatus(at("/status"), { signal });
    const exchange = await newExchangeKey();
    let key: string;
    try {
      key = await deriveSessionKey(exchange.privateKey, pk, { key: copy.key, pairing, mode, computer: device, phone: deviceId });
    } catch {
      throw new Error("This is not a Tracer copy code.");
    }
    const hello = await seal("{}", key, "hello");
    const request = await seal(JSON.stringify({ deviceId, name: current.phoneName, mode, format: FORMAT, pk: exchange.publicKey, hello }), copy.key, "request");
    unanswered = true;
    const answer = await call(at("/request"), { method: "POST", body: request }, { signal });
    unanswered = false;
    const welcome = check(answer);
    // Only the computer that holds the exchange key from the code and, for a merge, the pairing secret can seal this answer.
    // The phone sends its rows only after the answer opens.
    try { await unseal(welcome, key, "welcome"); } catch { throw new Error(mode === "merge" ? NOT_THE_PAIRED_COMPUTER : NO_DECRYPT); }
    current.key = key;
    current.code = await verificationCode(key, request);
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
      const text = check(await call(at(""), { method: "POST", body: await seal("{}", key, "snapshot-request") }, transfer));
      await beforeWrite();
      own.phase = "apply";
      void report({ phase: "apply", bytes: own.bytes });
      const { at: theirs, snapshot, pairing: secret } = await open<{ at: unknown; snapshot: Snapshot; pairing: unknown }>(text, key, "snapshot");
      checkTime(theirs);
      if (!isSecret(secret)) throw new Error(DAMAGED);
      beforeImport?.();
      counts = await importSnapshot(db, snapshot);
      result = { applied: total(counts), deleted: 0 };
      // The import wrote the whole change log just now; the next merge needs to send none of it back.
      await setMark(db, device, { mine: Date.now(), theirs });
      await setPairing(db, device, secret, true);
    } else {
      const mark = await getMark(db, device);
      // Taken before the export: a change made while the exchange runs is sent next time.
      const startedAt = Date.now();
      const sent = await seal(JSON.stringify({ since: mark?.theirs, payload: await exportSyncPayload(db, mark?.mine) }), key, "merge-up");
      const text = check(await call(at("/merge"), { method: "POST", body: sent, headers: { [PROOF_HEADER]: await seal("{}", key, "merge-request") } }, transfer));
      await beforeWrite();
      own.phase = "apply";
      void report({ phase: "apply", bytes: own.bytes });
      const { at: theirs, payload } = await open<{ at: unknown; payload: SyncPayload }>(text, key, "merge-down");
      checkTime(theirs);
      beforeImport?.();
      const merged = await mergeSyncPayload(db, payload);
      counts = merged.applied;
      result = { applied: total(merged.applied), deleted: total(merged.deleted) };
      await setMark(db, device, { mine: startedAt, theirs });
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
      if (current.key) {
        try { await call(at("/cancel"), { method: "POST", body: await seal("{}", current.key, "cancel") }, { timeoutMs: 5000 }); } catch { /* best effort: the wait on the computer ends by itself */ }
      }
    } else {
      // The computer may have ended the sync and may say why.
      if (current.key && !endedByComputer(current)) await readStatus(current, at("/status"), { timeoutMs: 3000 }).catch(() => undefined);
      if (!endedByComputer(current)) {
        own.phase = "failed";
        own.error = message;
        // The computer reads only a short report.
        await report({ phase: "failed", error: cleanText(message, 500) });
      }
    }
    if (unanswered) {
      // No session key is proven yet, so the key from the code seals this. The computer accepts it only while it asks to allow this phone.
      try { await call(at("/cancel"), { method: "POST", body: await seal(JSON.stringify({ deviceId }), copy.key, "cancel-request") }, { timeoutMs: 5000 }); } catch { /* best effort: the wait on the computer ends by itself */ }
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
  const copy = parsePairLink(link);
  const pairing = await getPairing(db, copy.device);
  const mode = modeFor(pairing);
  const deviceId = await localDeviceId(db);
  // Checked after the reads: no await may sit between the check and the claim of `job`.
  if (job && !finished(job)) {
    throw new Error("A sync is already running on this phone.");
  }
  const current: Job = {
    copy,
    deviceId,
    pairing,
    abort: new AbortController(),
    mode,
    computerName: copy.name ?? "",
    phoneName: `iPhone ${deviceId.slice(-4)}`,
    expiresAt: Date.now() + APPROVAL_WINDOW_MS,
    own: { phase: "approval" },
    reports: Promise.resolve(),
  };
  job = current;
  const done = run(db, current, beforeImport);
  return { done, session: receiveStatus()! };
}

/** Stops the sync and tells the computer. Once the phone writes the data, the sync runs to its end. */
export async function cancelReceive(): Promise<void> {
  const current = job;
  if (!current || current.own.phase === "apply" || finished(current)) return;
  current.abort.abort();
}
