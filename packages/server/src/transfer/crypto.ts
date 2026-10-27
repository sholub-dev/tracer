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

// An older version seals as "iv.data" without this tag.
const TAG = "z";

/** 32 random bytes as base64url, for a one-time token or an AES-256 key. */
export function randomSecret(): string {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}

const importKey = (key: string) => crypto.subtle.importKey("raw", decode(key), "AES-GCM", false, ["encrypt", "decrypt"]);

/** Compresses the bytes. Does not apply the limits. */
export function pack(plain: Uint8Array): Uint8Array {
  return deflateSync(plain);
}

export async function seal(text: string, key: string): Promise<string> {
  const plain = new TextEncoder().encode(text);
  if (plain.length > limits.unpacked) {
    throw new TooLargeError(`The data to sync is ${mb(plain.length)} MB before compression. The limit is ${mb(limits.unpacked)} MB. ${ADVICE}`);
  }
  const packed = deflateSync(plain);
  if (packed.length > limits.packed) {
    throw new TooLargeError(`The data to sync is ${mb(packed.length)} MB after compression. The limit is ${mb(limits.packed)} MB. ${ADVICE}`);
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importKey(key), packed);
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

/** Throws when the key is wrong or the payload was changed. */
export async function unseal(payload: string, key: string): Promise<string> {
  const parts = payload.split(".");
  if (parts.length === 2) throw new OldFormError("The data comes from an older Tracer version.");
  const [tag, iv, data] = parts;
  if (parts.length !== 3 || tag !== TAG || !iv || !data) throw new Error("The copy is damaged.");
  return unpack(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(iv) }, await importKey(key), decode(data))));
}
