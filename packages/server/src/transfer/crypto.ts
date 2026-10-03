// Not Uint8Array.toBase64: the iOS app supports WebKit versions without it.
function encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decode(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 32 random bytes as base64url, for a one-time token or an AES-256 key. */
export function randomSecret(): string {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}

const importKey = (key: string) => crypto.subtle.importKey("raw", decode(key), "AES-GCM", false, ["encrypt", "decrypt"]);

export async function seal(text: string, key: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importKey(key), new TextEncoder().encode(text));
  return `${encode(iv)}.${encode(new Uint8Array(data))}`;
}

/** Throws when the key is wrong or the payload was changed. */
export async function unseal(payload: string, key: string): Promise<string> {
  const [iv, data] = payload.split(".");
  if (!iv || !data) throw new Error("The copy is damaged.");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(iv) }, await importKey(key), decode(data));
  return new TextDecoder().decode(plain);
}
