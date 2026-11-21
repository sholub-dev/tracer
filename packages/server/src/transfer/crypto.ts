import { deflateSync, Inflate } from "fflate";
import { fromBase64Url as decode, toBase64Url as encode } from "../lib/base64.js";

/** Larger data does not fit in memory on the phone. The limit applies to the compressed data. */
export const MAX_SYNC_BYTES = 100 * 1024 * 1024;
/** The sealed form is base64, a third larger than the compressed data. */
export const MAX_BODY_BYTES = Math.ceil((MAX_SYNC_BYTES * 4) / 3) + 1024;
/** A JS string holds about 512 MB; the unpacked text must stay well below that. */
export const MAX_UNPACKED_BYTES = 400 * 1024 * 1024;

/** Tests lower these. */
export const limits = { packed: MAX_SYNC_BYTES, unpacked: MAX_UNPACKED_BYTES };

export class TooLargeError extends Error {}
/** The other device seals data in the form of an older Tracer version. */
export class OldFormError extends Error {}

const mb = (bytes: number) => (bytes < 10 * 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) : String(Math.round(bytes / 1024 / 1024)));
const ADVICE = "Delete sessions you do not need, then try again.";

// Older versions seal as "iv.data", or as "z.iv.data" with no label.
const TAG = "a";
const OLD_TAG = "z";

/** What a sealed message is for. The label is authenticated, so a message of one kind is never accepted as another. */
export type SealLabel = "request" | "hello" | "welcome" | "cancel" | "cancel-request" | "progress" | "status" | "merge-request" | "merge-up" | "merge-down" | "snapshot-request" | "snapshot";

/** 32 random bytes as base64url, for a one-time token or an AES-256 key. */
export function randomSecret(): string {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}

const utf8 = (text: string) => new TextEncoder().encode(text);
const SECRET = /^[A-Za-z0-9_-]{43}$/;

/** True for 32 bytes as base64url: the form of a key or a pairing secret. */
export const isSecret = (value: unknown): value is string => typeof value === "string" && SECRET.test(value);

const CURVE = { name: "ECDH", namedCurve: "P-256" };

/** A key pair for one sync. The private part never leaves this device. */
export async function newExchangeKey(): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const pair = await crypto.subtle.generateKey(CURVE, false, ["deriveBits"]);
  return { privateKey: pair.privateKey, publicKey: encode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))) };
}

export interface SessionParts {
  /** The one-time key from the QR code. */
  key: string;
  /** The secret both devices stored at their first sync. A merge needs it. */
  pairing?: string;
  mode: "merge" | "replace";
  computer: string;
  phone: string;
}

/**
 * The key that seals one sync. Only a device that holds its own exchange key, the key from the QR code and,
 * for a merge, the pairing secret can derive it. A device that only saw the QR code cannot.
 */
export async function deriveSessionKey(own: CryptoKey, theirPublic: string, { key, pairing, mode, computer, phone }: SessionParts): Promise<string> {
  if (!isSecret(key) || (mode === "merge" ? !isSecret(pairing) : pairing !== undefined)) throw new Error("The key is not valid.");
  const theirs = await crypto.subtle.importKey("raw", decode(theirPublic), CURVE, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: theirs }, own, 256));
  // Every part has a fixed length, so the parts cannot run into each other.
  const material = new Uint8Array([...shared, ...decode(key), ...decode(pairing ?? "")]);
  const hkdf = await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveBits"]);
  const info = utf8(`tracer-sync/${mode}\0${computer}\0${phone}`);
  return encode(new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: utf8("tracer-sync/session"), info }, hkdf, 256)));
}

/** Six digits that both devices show. They match only when both hold the same session key for the same request. */
export async function verificationCode(sessionKey: string, request: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", utf8(`tracer-sync/code\0${sessionKey}\0${request}`));
  return String(new DataView(hash).getUint32(0) % 1_000_000).padStart(6, "0");
}

const importKey = (key: string) => crypto.subtle.importKey("raw", decode(key), "AES-GCM", false, ["encrypt", "decrypt"]);

export async function seal(text: string, key: string, label: SealLabel): Promise<string> {
  const plain = new TextEncoder().encode(text);
  if (plain.length > limits.unpacked) {
    throw new TooLargeError(`The data to sync is ${mb(plain.length)} MB before compression. The limit is ${mb(limits.unpacked)} MB. ${ADVICE}`);
  }
  const packed = deflateSync(plain);
  if (packed.length > limits.packed) {
    throw new TooLargeError(`The data to sync is ${mb(packed.length)} MB after compression. The limit is ${mb(limits.packed)} MB. ${ADVICE}`);
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(label) }, await importKey(key), packed);
  return `${TAG}.${encode(iv)}.${encode(new Uint8Array(data))}`;
}

function unpack(packed: Uint8Array): string {
  const chunks: Uint8Array[] = [];
  let size = 0;
  new Inflate((chunk) => {
    size += chunk.length;
    if (size > limits.unpacked) throw new TooLargeError(`The copy is larger than ${mb(limits.unpacked)} MB when unpacked. ${ADVICE}`);
    chunks.push(chunk);
  }).push(packed, true);
  const text = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    text.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(text);
}

/** Throws when the key is wrong, the payload was changed or it was sealed for another purpose. */
export async function unseal(payload: string, key: string, label: SealLabel): Promise<string> {
  const parts = payload.split(".");
  if (parts.length === 2 || (parts.length === 3 && parts[0] === OLD_TAG)) throw new OldFormError("The data comes from an older Tracer version.");
  const [tag, iv, data] = parts;
  if (parts.length !== 3 || tag !== TAG || !iv || !data) throw new Error("The copy is damaged.");
  return unpack(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(iv), additionalData: new TextEncoder().encode(label) }, await importKey(key), decode(data))));
}
