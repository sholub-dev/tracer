import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import { getTableColumns, sql } from "drizzle-orm";
import QRCode from "qrcode";
import type { SyncCounts, SyncMode, SyncPhase, SyncSession } from "@tracer-sh/shared";
import type { Db } from "../db/driver.js";
import { deriveSessionKey, limits, MAX_BODY_BYTES, MAX_SYNC_BYTES, newExchangeKey, OldFormError, randomSecret, seal, TooLargeError, unseal, verificationCode, type SealLabel } from "./crypto.js";
import { localDeviceId } from "../db/config-reader.js";
import { getPairing, recordSync, setPairing, syncOff } from "./peer.js";
import { checkShape, exportSnapshot, FORMAT, TABLES } from "./snapshot.js";
import { exportSyncPayload, mergeSyncPayload } from "./sync.js";
import { APPROVAL_WINDOW_MS, cleanText, COPY_LINK_PREFIX, DEVICE_ID, MAX_NAME_LENGTH, PROOF_HEADER, total } from "./receive.js";

// A large upload on a slow Wi-Fi needs minutes.
const BODY_TIMEOUT_MS = 300_000;
// The phone polls once a second: after the sync ends the listener answers briefly so the phone learns how.
const END_GRACE_MS = 15_000;
// The phone writes the data after it arrives, and a large merge takes minutes.
const APPLY_WINDOW_MS = 300_000;
// Every message but the merge data is a short JSON text: the largest, a failure report with a 500-character error, seals to under 3 KB.
const MAX_MESSAGE_BYTES = 8 * 1024;
const RUN_ACTIVE = "An investigation is running on this computer. Stop it or wait for it to finish, then sync again.";

export interface FullCopySize {
  /** Estimated compressed size of a full copy: about what a first sync sends. */
  bytes: number;
  limitBytes: number;
  fits: boolean;
}

interface Session {
  server: Server;
  view: SyncSession;
  timer?: ReturnType<typeof setTimeout>;
  request?: { deviceId: string; name: string; mode: SyncMode };
  /** Seals everything after the request. Only the phone that sent the request holds it too. */
  key?: string;
  busy: boolean;
}

type EndPhase = Extract<SyncPhase, "done" | "denied" | "expired" | "cancelled" | "failed">;

// A report moves the sync forward only, so a late report cannot undo a later one.
const ORDER: SyncPhase[] = ["waiting", "approval", "transfer", "apply", "done"];

let current: Session | null = null;
let last: SyncSession | null = null;

const UPDATE_PHONE = "Update Tracer on the phone to the same version as this computer, then scan the code again.";
const UPDATE_COMPUTER = "Update Tracer on this computer to the same version as the phone, then show a new code.";
const CODE_USED = "Another device already used this code. If the computer asks to allow a sync, click Deny there. Then show a new code and try again.";
// The same answer for an unknown phone and for a wrong secret.
const NOT_PAIRED = "The computer does not hold a pairing with this phone. On the phone, open Settings > Phone and tap Forget computer. Then show a new code and scan it. That sync replaces the data on the phone.";
const SYNC_OFF = "Sync with a phone is off on this server (TRACER_SYNC=off).";

class HttpError extends Error {
  constructor(readonly status: number, message = "") {
    super(message);
  }
}

function failure(err: unknown): string {
  if (err instanceof TooLargeError) return err.message;
  if (err instanceof HttpError && err.status === 408) return "The phone stopped sending data. Show a new code and try again.";
  if (err instanceof HttpError && err.status === 413) return `The phone sent more data than the limit allows (${Math.round(MAX_SYNC_BYTES / 1024 / 1024)} MB). Show a new code and try again.`;
  if (err instanceof HttpError && err.message) return err.message;
  return "The sync failed on this computer. Show a new code and try again. If it fails again, restart Tracer.";
}

// JSON keys, quotes and separators around the values of one row.
const ROW_OVERHEAD_BYTES = 100;
// Text such as tool output compresses at least this well; the limits use the same ratio (unpacked 400 MB, packed 100 MB).
const COMPRESSION_RATIO = 4;

/**
 * An estimate from the size of every column, with no export and no compression. The real limits are checked
 * on the real data when it is sealed, so a wrong estimate never lets too much data through.
 */
async function measureFullCopy(db: Db): Promise<FullCopySize> {
  let raw = 0;
  for (const [, table] of TABLES) {
    const sizes = Object.values(getTableColumns(table)).map((c) => sql`coalesce(length(${c}), 0)`);
    const row = await db.select({ bytes: sql<number>`coalesce(sum(${sql.join(sizes, sql` + `)}), 0)`, rows: sql<number>`count(*)` }).from(table).get();
    raw += (row?.bytes ?? 0) + (row?.rows ?? 0) * ROW_OVERHEAD_BYTES;
  }
  const bytes = Math.ceil(raw / COMPRESSION_RATIO);
  return { bytes, limitBytes: limits.packed, fits: bytes <= limits.packed && raw <= limits.unpacked };
}

function lanAddress(): string | null {
  const addresses = Object.entries(networkInterfaces()).flatMap(([name, list]) =>
    (list ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => ({ name, address: a.address })),
  );
  // Wi-Fi and Ethernet are en*; a VPN tunnel (utun) does not reach the phone.
  return (addresses.find((a) => a.name.startsWith("en")) ?? addresses[0])?.address ?? null;
}

function computerName(): string {
  return hostname().replace(/\.local$/, "").slice(0, MAX_NAME_LENGTH);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => fail(new HttpError(408)), BODY_TIMEOUT_MS);
    const fail = (err: Error) => {
      clearTimeout(timer);
      req.off("data", onData);
      req.resume();
      reject(err);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) fail(new HttpError(413));
      else chunks.push(chunk);
    };
    req.on("data", onData);
    req.once("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.once("error", fail);
  });
}

function reply(res: ServerResponse, status: number, body?: string) {
  res.writeHead(status, { "content-type": "text/plain" }).end(body);
}

function arm(ms = APPROVAL_WINDOW_MS) {
  if (!current) return;
  const session = current;
  clearTimeout(session.timer);
  session.view.expiresAt = Date.now() + ms;
  session.timer = setTimeout(() => {
    if (current !== session) return;
    // A large exchange can outlast the window.
    if (session.busy) arm();
    else if (session.view.phase === "apply") finish("failed", { error: { message: "The phone did not confirm that it saved the data. Check the phone, then sync again.", side: "phone" } });
    else finish("expired");
  }, ms);
}

function advance(phase: SyncPhase) {
  if (!current || ORDER.indexOf(phase) <= ORDER.indexOf(current.view.phase)) return;
  current.view.phase = phase;
  if (phase === "apply") arm(APPLY_WINDOW_MS);
}

function finish(phase: EndPhase | "idle", extra: Partial<SyncSession> = {}) {
  if (!current) return;
  const { server, view } = current;
  clearTimeout(current.timer);
  if (phase === "idle") {
    last = null;
  } else {
    // The phase before the end tells the screens which step went wrong.
    const reached = view.phase as SyncSession["reached"];
    Object.assign(view, extra, { phase }, phase !== "done" && { reached });
    last = view;
  }
  current = null;
  const close = () => {
    server.close();
    server.closeAllConnections();
  };
  if (phase === "idle") return close();
  // Only the grace timer may keep the listener open: it must not hold the process.
  server.unref();
  setTimeout(close, END_GRACE_MS).unref();
}

/** Ends the sync from this computer: the phone learns that it was cancelled here. */
export function stopSend(): void {
  if (current?.request) finish("cancelled", { error: { message: "Cancelled on the computer.", side: "computer" } });
  else finish("idle");
}

export function sendStatus(): SyncSession | null {
  return current?.view ?? last;
}

/** Lets the pending phone request through. */
export function approve(): void {
  if (current?.view.phase !== "approval") throw new Error("There is no request to allow.");
  current.view.phase = "transfer";
  arm();
}

export function deny(): void {
  if (current?.view.phase !== "approval") throw new Error("There is no request to deny.");
  finish("denied");
}

/** The phone reports what it does with the data. The text is untrusted. */
function parseProgress(text: string): { phase: "transfer" | "apply" | "done" | "failed"; bytes?: { done: number; total: number }; result?: SyncCounts; error?: string } | null {
  const value = JSON.parse(text) as Record<string, unknown>;
  const { phase, bytes, result, error } = value;
  if (phase !== "transfer" && phase !== "apply" && phase !== "done" && phase !== "failed") return null;
  const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null);
  const out: NonNullable<ReturnType<typeof parseProgress>> = { phase };
  const b = bytes as { done?: unknown; total?: unknown } | undefined;
  if (b && count(b.done) !== null && count(b.total) !== null) out.bytes = { done: count(b.done)!, total: count(b.total)! };
  const r = result as { applied?: unknown; deleted?: unknown } | undefined;
  if (r && count(r.applied) !== null && count(r.deleted) !== null) out.result = { applied: count(r.applied)!, deleted: count(r.deleted)! };
  if (typeof error === "string") out.error = cleanText(error, 500);
  return out;
}

function parseRequest(text: string): NonNullable<Session["request"]> & { pk: string; hello: string } {
  const value = JSON.parse(text) as Record<string, unknown>;
  const { deviceId, name, mode, format, pk, hello } = value;
  if (typeof format !== "number" || format < FORMAT) throw new HttpError(409, UPDATE_PHONE);
  if (format > FORMAT) throw new HttpError(409, UPDATE_COMPUTER);
  if (typeof deviceId !== "string" || !DEVICE_ID.test(deviceId) || typeof name !== "string" || (mode !== "merge" && mode !== "replace")
    || typeof pk !== "string" || typeof hello !== "string") {
    throw new HttpError(400);
  }
  return { deviceId, name: cleanText(name, MAX_NAME_LENGTH) || "iPhone", mode, pk, hello };
}

/**
 * Serves one encrypted exchange with a phone on the local network, once, for two minutes.
 * The QR code carries the address, a one-time token, a one-time key and this computer's exchange key; the keys never cross the network.
 * The phone's request fixes a session key that only that phone and this computer can derive. A merge also needs the
 * secret both stored at their first sync, so only a paired phone can ask for one.
 * Nothing is exchanged until the person at this computer allows the phone's request.
 * `activeRuns` counts running investigations: an exchange waits for them to finish.
 * `afterMerge` runs after this computer merged the phone's data; it learns whether provider settings changed.
 */
export async function startSend(
  db: Db,
  activeRuns: () => number,
  afterMerge?: (providersChanged: boolean) => Promise<void>,
): Promise<{ link: string; qrSvg: string; expiresAt: number; fullCopy: FullCopySize; session: SyncSession }> {
  // A server in a data center has no phone on its network, so it must not open the listener.
  if (syncOff()) throw new Error(SYNC_OFF);
  stopSend();
  const address = lanAddress();
  if (!address) throw new Error("This computer has no network connection. Connect it to the same Wi-Fi as the phone.");
  const token = randomSecret();
  const key = randomSecret();
  const expected = Buffer.from(`/${token}`);
  const [deviceId, exchange, fullCopy] = await Promise.all([localDeviceId(db), newExchangeKey(), measureFullCopy(db)]);

  // `proof.opened`: the request carried a message sealed with the session key, so it comes from the phone.
  const handle = async (req: IncomingMessage, res: ServerResponse, proof: { opened: boolean }) => {
    const url = req.url ?? "";
    const given = Buffer.from(url.slice(0, expected.length));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return reply(res, 404);
    const route = `${req.method} ${url.slice(expected.length)}`;
    // The format stays readable so a phone on another version can tell which side to update; the phone trusts only the sealed part.
    if (route === "GET /status") return reply(res, 200, JSON.stringify({ format: FORMAT, sealed: await seal(JSON.stringify(session.view), session.key ?? key, "status") }));
    if (current !== session) return reply(res, 404);
    // Before a request there is no session key, so nothing opens.
    const unsealBody = async (body: string, label: SealLabel) => {
      if (!session.key) throw new Error("No request yet.");
      return unseal(body, session.key, label);
    };
    const open = async (label: SealLabel) => {
      const text = await unsealBody(await readBody(req, MAX_MESSAGE_BYTES), label);
      proof.opened = true;
      return text;
    };

    if (route === "POST /request") {
      if (session.view.phase !== "waiting") return reply(res, 409, CODE_USED);
      const body = await readBody(req, MAX_MESSAGE_BYTES);
      let text: string;
      try { text = await unseal(body, key, "request"); } catch (err) { return reply(res, err instanceof OldFormError ? 409 : 403, err instanceof OldFormError ? UPDATE_PHONE : undefined); }
      const { pk, hello, ...request } = parseRequest(text);
      const merge = request.mode === "merge";
      const pairing = merge ? await getPairing(db, request.deviceId) : undefined;
      if (merge && !pairing) return reply(res, 409, NOT_PAIRED);
      let sessionKey: string;
      try {
        sessionKey = await deriveSessionKey(exchange.privateKey, pk, { key, pairing, mode: request.mode, computer: deviceId, phone: request.deviceId });
        await unseal(hello, sessionKey, "hello");
      } catch {
        return reply(res, merge ? 409 : 403, merge ? NOT_PAIRED : undefined);
      }
      const code = await verificationCode(sessionKey, body);
      // The phone trusts this computer only when this answer opens with the session key.
      const welcome = await seal("{}", sessionKey, "welcome");
      // No await between this check and the claim.
      if (current !== session || session.view.phase !== "waiting") return reply(res, 409, CODE_USED);
      session.request = request;
      session.key = sessionKey;
      session.view.phase = "approval";
      session.view.phoneName = request.name;
      session.view.mode = request.mode;
      session.view.code = code;
      arm();
      return reply(res, 200, welcome);
    }

    if (route === "POST /cancel") {
      const body = await readBody(req, MAX_MESSAGE_BYTES);
      const byPhone = { error: { message: "Cancelled on the phone.", side: "phone" as const } };
      let text: string;
      try {
        text = await unsealBody(body, "cancel");
      } catch {
        // A phone that left before the answer to its request arrived holds no proven session key: it seals with the key from the code.
        // That key is on the screen for anyone, so it ends only the prompt for that phone, never an allowed sync.
        let phone: unknown;
        try { phone = (JSON.parse(await unseal(body, key, "cancel-request")) as { deviceId?: unknown } | null)?.deviceId; } catch { return reply(res, 403); }
        // No await between this check and the end.
        if (current !== session || session.view.phase !== "approval" || phone !== session.request?.deviceId) return reply(res, 403);
        finish("cancelled", byPhone);
        return reply(res, 200);
      }
      proof.opened = true;
      // `finish` ends whatever session is current: a new code may have replaced this one during the read.
      if (current !== session) return reply(res, 404);
      if (text !== "{}" || !session.request) return reply(res, 400);
      finish("cancelled", byPhone);
      return reply(res, 200);
    }

    if (route === "POST /progress") {
      if (session.view.phase !== "transfer" && session.view.phase !== "apply") return reply(res, 409);
      let progress: ReturnType<typeof parseProgress>;
      try { progress = parseProgress(await open("progress")); } catch (err) { if (err instanceof HttpError) throw err; return reply(res, 403); }
      if (!progress || current !== session) return reply(res, 400);
      const { view } = session;
      if (progress.bytes) view.bytes = progress.bytes;
      if (progress.phase === "failed") {
        finish("failed", { error: { message: progress.error || "The sync failed on the phone.", side: "phone" } });
      } else if (progress.phase === "done") {
        if (view.phase !== "apply") return reply(res, 409);
        view.result = { ...view.result, phone: progress.result ?? { applied: 0, deleted: 0 } };
        finish("done");
      } else {
        advance(progress.phase);
      }
      return reply(res, 200);
    }

    if (route === "POST " || route === "POST /merge") {
      if (session.view.phase !== "transfer" || !session.request || !session.key) return reply(res, 403);
      const merge = route === "POST /merge";
      const sessionKey = session.key;
      const phoneId = session.request.deviceId;
      if (session.request.mode !== (merge ? "merge" : "replace")) return reply(res, 409, "This code was approved for the other kind of sync.");
      // Anyone who knows the address can call this, so the caller proves the session key before the exchange is claimed.
      // A merge proves it in a header: the large upload of a stranger is never read, and the connection closes.
      try {
        await unseal(merge ? String(req.headers[PROOF_HEADER] ?? "") : await readBody(req, MAX_MESSAGE_BYTES), sessionKey, merge ? "merge-request" : "snapshot-request");
      } catch (err) {
        if (err instanceof HttpError) throw err;
        res.writeHead(403, { "content-type": "text/plain", connection: "close" }).end();
        return;
      }
      proof.opened = true;
      // No await between these checks and the claim.
      if (current !== session || session.view.phase !== "transfer") return reply(res, 403);
      if (session.busy) return reply(res, 409, "The exchange is already running.");
      session.busy = true;
      try {
        let sealed: string;
        if (merge) {
          const body = await readBody(req, MAX_BODY_BYTES);
          let since: number | undefined;
          let remote: unknown;
          try {
            const parsed = JSON.parse(await unseal(body, sessionKey, "merge-up")) as { since?: unknown; payload?: unknown };
            remote = parsed.payload;
            if (typeof parsed.since === "number") since = parsed.since;
          } catch (err) {
            if (err instanceof TooLargeError) throw err;
            return reply(res, err instanceof OldFormError ? 409 : 403, err instanceof OldFormError ? UPDATE_PHONE : undefined);
          }
          try { checkShape(remote); } catch (err) { throw new HttpError(400, (err as Error).message); }
          // Checked after the upload: a monitor or timer can start a run while the data arrives.
          // Thrown, not replied: the sync ends here, so the screens name this computer, not the phone.
          if (activeRuns() > 0) throw new HttpError(409, RUN_ACTIVE);
          // Read before the merge: the rows the phone just sent need not go back, and a size error leaves this computer unchanged.
          const at = Date.now();
          sealed = await seal(JSON.stringify({ at, payload: await exportSyncPayload(db, since) }), sessionKey, "merge-down");
          const { applied, deleted } = await mergeSyncPayload(db, remote);
          await afterMerge?.(applied.provider_configs + deleted.provider_configs > 0);
          session.view.result = { computer: { applied: total(applied), deleted: total(deleted) } };
        } else {
          // A running investigation has not saved its answer yet, so the copy would miss it.
          if (activeRuns() > 0) throw new HttpError(409, RUN_ACTIVE);
          const at = Date.now();
          // A new secret for each first sync: it replaces any older pairing with this phone.
          const pairing = randomSecret();
          sealed = await seal(JSON.stringify({ at, snapshot: await exportSnapshot(db), pairing }), sessionKey, "snapshot");
          await setPairing(db, phoneId, pairing);
          session.view.result = { computer: { applied: 0, deleted: 0 } };
        }
        await recordSync(db, { name: session.request.name });
        return await new Promise<void>((resolve) => {
          res.once("close", () => {
            if (current === session) {
              // The phone may have reported progress already.
              if (res.writableFinished) advance("apply");
              else if (session.view.phase === "transfer") finish("failed", { error: { message: "The connection to the phone broke while this computer sent the data. Show a new code and try again.", side: "computer" } });
            }
            resolve();
          });
          // The length lets the phone show the progress of the transfer.
          res.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(sealed) }).end(sealed);
        });
      } finally {
        session.busy = false;
      }
    }
    reply(res, 404);
  };

  const server = createServer((req, res) => {
    const proof = { opened: false };
    handle(req, res, proof).catch((err: unknown) => {
      if (!(err instanceof HttpError || err instanceof TooLargeError)) console.warn("[transfer] Request failed:", err);
      const message = err instanceof TooLargeError || (err instanceof HttpError && err.message) ? err.message : "";
      if (!res.headersSent) reply(res, err instanceof TooLargeError ? 413 : err instanceof HttpError ? err.status : 500, message);
      // An exchange the person allowed ended badly: the screen must say why. A request without the session key ends nothing.
      if (proof.opened && session.view.phase === "transfer" && current === session) finish("failed", { error: { message: failure(err), side: "computer" } });
    });
  });
  const view: SyncSession = { phase: "waiting", computerName: computerName(), expiresAt: Date.now() + APPROVAL_WINDOW_MS };
  const session: Session = { server, view, busy: false };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Only the address in the QR code: other interfaces (VPN, container bridges) must not reach the copy.
    server.listen(0, address, resolve);
  });

  const { port } = server.address() as AddressInfo;
  current = session;
  arm();
  last = view;

  const link = `${COPY_LINK_PREFIX}?from=${encodeURIComponent(`http://${address}:${port}/${token}`)}&key=${key}&name=${encodeURIComponent(computerName())}&device=${encodeURIComponent(deviceId)}&pk=${exchange.publicKey}`;
  return { link, qrSvg: await QRCode.toString(link, { type: "svg", margin: 1, errorCorrectionLevel: "L" }), expiresAt: view.expiresAt, fullCopy, session: { ...view } };
}
