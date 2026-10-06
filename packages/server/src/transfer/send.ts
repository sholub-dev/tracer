import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import { getTableColumns, sql } from "drizzle-orm";
import QRCode from "qrcode";
import type { Db } from "../db/driver.js";
import { limits, MAX_SYNC_BYTES, OldFormError, randomSecret, seal, TooLargeError, unseal } from "./crypto.js";
import { getSetting, recordSync } from "./peer.js";
import { exportSnapshot, FORMAT, TABLES } from "./snapshot.js";
import { exportSyncPayload, mergeSyncPayload, type SyncPayload } from "./sync.js";
import { APPROVAL_WINDOW_MS, COPY_LINK_PREFIX, DEVICE_ID, MAX_NAME_LENGTH, type SyncMode } from "./receive.js";

// Base64 adds a third to the sealed data.
const MAX_BODY_BYTES = Math.ceil((MAX_SYNC_BYTES * 4) / 3) + 1024;
// A large upload on a slow Wi-Fi needs minutes.
const BODY_TIMEOUT_MS = 300_000;
// The phone polls once a second: after a deny or expiry the listener answers briefly so the phone learns why.
const END_GRACE_MS = 3000;
const RUN_ACTIVE = "An investigation is running on this computer. Stop it or wait for it to finish, then sync again.";

export type SendState = "idle" | "waiting" | "approval" | "approved" | "sent" | "denied" | "expired" | "failed";

export interface SendStatus {
  state: SendState;
  phoneName?: string;
  mode?: SyncMode;
  /** Merge only: rows written and deleted on this computer. */
  applied?: number;
  deleted?: number;
  /** State "failed": why the exchange failed. */
  error?: string;
}

export interface FullCopySize {
  /** Estimated compressed size of a full copy: about what a first sync sends. */
  bytes: number;
  limitBytes: number;
  fits: boolean;
}

interface Session {
  server: Server;
  state: SendState;
  timer?: ReturnType<typeof setTimeout>;
  request?: { deviceId: string; name: string; mode: SyncMode };
  busy: boolean;
}

let current: Session | null = null;
let last: SendStatus = { state: "idle" };

const UPDATE_PHONE = "Update Tracer on the phone to the same version as this computer, then scan the code again.";
const UPDATE_COMPUTER = "Update Tracer on this computer to the same version as the phone, then show a new code.";

class HttpError extends Error {
  constructor(readonly status: number, message = "") {
    super(message);
  }
}

function failure(err: unknown): string {
  if (err instanceof TooLargeError) return err.message;
  if (err instanceof HttpError && err.status === 408) return "The phone stopped sending data. Show a new code and try again.";
  if (err instanceof HttpError && err.status === 413) return `The phone sent more data than the limit allows (${Math.round(MAX_SYNC_BYTES / 1024 / 1024)} MB). Show a new code and try again.`;
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

function readBody(req: IncomingMessage): Promise<string> {
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
      if (size > MAX_BODY_BYTES) fail(new HttpError(413));
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

function arm() {
  if (!current) return;
  const session = current;
  clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    if (current !== session) return;
    // A large exchange can outlast the window.
    if (session.busy) arm();
    else finish("expired");
  }, APPROVAL_WINDOW_MS);
}

function finish(state: SendState, extra: Partial<SendStatus> = {}) {
  if (!current) return;
  const { server, request } = current;
  clearTimeout(current.timer);
  current.state = state;
  last = { state, ...(request && { phoneName: request.name, mode: request.mode }), ...extra };
  current = null;
  const close = () => {
    server.close();
    server.closeAllConnections();
  };
  if (request && (state === "denied" || state === "expired" || state === "failed")) setTimeout(close, END_GRACE_MS).unref();
  else close();
}

export function stopSend(): void {
  finish("idle");
}

export function sendStatus(): SendStatus {
  if (!current) return last;
  const { state, request } = current;
  return { state, ...(request && { phoneName: request.name, mode: request.mode }) };
}

/** Lets the pending phone request through. */
export function approve(): void {
  if (current?.state !== "approval") throw new Error("There is no request to allow.");
  current.state = "approved";
  arm();
}

export function deny(): void {
  if (current?.state !== "approval") throw new Error("There is no request to deny.");
  finish("denied");
}

function parseRequest(text: string): NonNullable<Session["request"]> {
  const value = JSON.parse(text) as Record<string, unknown>;
  const { deviceId, name, mode, format } = value;
  if (typeof format !== "number" || format < FORMAT) throw new HttpError(409, UPDATE_PHONE);
  if (format > FORMAT) throw new HttpError(409, UPDATE_COMPUTER);
  if (typeof deviceId !== "string" || !DEVICE_ID.test(deviceId) || typeof name !== "string" || (mode !== "merge" && mode !== "replace")) {
    throw new HttpError(400);
  }
  // Shown to the user, so it is untrusted text: no control characters, bounded length.
  return { deviceId, name: name.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "").trim().slice(0, MAX_NAME_LENGTH) || "iPhone", mode };
}

/**
 * Serves one encrypted exchange with a phone on the local network, once, for two minutes.
 * The QR code carries the address, a one-time token and the key; the key never crosses the network.
 * Nothing is exchanged until the person at this computer allows the phone's request.
 * `activeRuns` counts running investigations: an exchange waits for them to finish.
 * `afterMerge` runs after this computer merged the phone's data; it learns whether provider settings changed.
 */
export async function startSend(
  db: Db,
  activeRuns: () => number,
  afterMerge?: (providersChanged: boolean) => Promise<void>,
): Promise<{ link: string; qrSvg: string; expiresAt: number; fullCopy: FullCopySize }> {
  stopSend();
  const address = lanAddress();
  if (!address) throw new Error("This computer has no network connection. Connect it to the same Wi-Fi as the phone.");
  const token = randomSecret();
  const key = randomSecret();
  const expected = Buffer.from(`/${token}`);
  const deviceId = (await getSetting(db, "device_id")) ?? "";
  const fullCopy = await measureFullCopy(db);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    const given = Buffer.from(url.slice(0, expected.length));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return reply(res, 404);
    const route = `${req.method} ${url.slice(expected.length)}`;
    if (route === "GET /status") return reply(res, 200, JSON.stringify({ state: session.state, format: FORMAT }));
    if (current !== session) return reply(res, 404);

    if (route === "POST /request") {
      if (session.state !== "waiting") return reply(res, 409, "Another phone already used this code. Show a new code and try again.");
      const body = await readBody(req);
      let text: string;
      try { text = await unseal(body, key); } catch (err) { return reply(res, err instanceof OldFormError ? 409 : 403, err instanceof OldFormError ? UPDATE_PHONE : undefined); }
      const request = parseRequest(text);
      if (current !== session || session.state !== "waiting") return reply(res, 409, "Another phone already used this code. Show a new code and try again.");
      session.request = request;
      session.state = "approval";
      arm();
      return reply(res, 200);
    }

    if (route === "GET " || route === "POST /merge") {
      if (session.state !== "approved") return reply(res, 403);
      const merge = route === "POST /merge";
      if (session.request?.mode !== (merge ? "merge" : "replace")) return reply(res, 409, "This code was approved for the other kind of sync.");
      if (session.busy) return reply(res, 409, "The exchange is already running.");
      session.busy = true;
      try {
        let sealed: string;
        let extra: Partial<SendStatus> = {};
        if (merge) {
          const body = await readBody(req);
          let since: number | undefined;
          let remote: SyncPayload;
          try {
            const parsed = JSON.parse(await unseal(body, key)) as { since?: unknown; payload: SyncPayload };
            remote = parsed.payload;
            if (typeof parsed.since === "number") since = parsed.since;
          } catch (err) {
            if (err instanceof TooLargeError) throw err;
            return reply(res, err instanceof OldFormError ? 409 : 403, err instanceof OldFormError ? UPDATE_PHONE : undefined);
          }
          // Checked after the upload: a monitor or timer can start a run while the data arrives.
          if (activeRuns() > 0) return reply(res, 409, RUN_ACTIVE);
          // Read before the merge: the rows the phone just sent need not go back, and a size error leaves this computer unchanged.
          const at = Date.now();
          sealed = await seal(JSON.stringify({ at, payload: await exportSyncPayload(db, since) }), key);
          const { applied, deleted } = await mergeSyncPayload(db, remote);
          await afterMerge?.(applied.provider_configs + deleted.provider_configs > 0);
          const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);
          extra = { applied: total(applied), deleted: total(deleted) };
        } else {
          // A running investigation has not saved its answer yet, so the copy would miss it.
          if (activeRuns() > 0) return reply(res, 409, RUN_ACTIVE);
          const at = Date.now();
          sealed = await seal(JSON.stringify({ at, snapshot: await exportSnapshot(db) }), key);
        }
        await recordSync(db, { name: session.request.name });
        return await new Promise<void>((resolve) => {
          res.once("close", () => {
            if (current === session) {
              if (res.writableFinished) finish("sent", extra);
              else finish("failed", { error: "The connection to the phone broke while this computer sent the data. Show a new code and try again." });
            }
            resolve();
          });
          res.writeHead(200, { "content-type": "text/plain" }).end(sealed);
        });
      } finally {
        session.busy = false;
      }
    }
    reply(res, 404);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!(err instanceof HttpError || err instanceof TooLargeError)) console.warn("[transfer] Request failed:", err);
      const message = err instanceof TooLargeError || (err instanceof HttpError && err.message) ? err.message : "";
      if (!res.headersSent) reply(res, err instanceof TooLargeError ? 413 : err instanceof HttpError ? err.status : 500, message);
      // An exchange the person allowed ended badly: the screen must say why.
      if (session.state === "approved" && current === session) finish("failed", { error: failure(err) });
    });
  });
  const session: Session = { server, state: "waiting", busy: false };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Only the address in the QR code: other interfaces (VPN, container bridges) must not reach the copy.
    server.listen(0, address, resolve);
  });

  const { port } = server.address() as AddressInfo;
  current = session;
  arm();
  last = { state: "waiting" };

  const link = `${COPY_LINK_PREFIX}?from=${encodeURIComponent(`http://${address}:${port}/${token}`)}&key=${key}&name=${encodeURIComponent(computerName())}&device=${encodeURIComponent(deviceId)}`;
  return { link, qrSvg: await QRCode.toString(link, { type: "svg", margin: 1, errorCorrectionLevel: "L" }), expiresAt: Date.now() + APPROVAL_WINDOW_MS, fullCopy };
}
