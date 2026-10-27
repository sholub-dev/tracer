// Not Uint8Array.toBase64: the iOS app supports WebKit versions without it.
// Works in chunks: btoa and atob on one very large string end Node with a fatal error.
const CHUNK = 0x6000; // A multiple of 3, so every chunk but the last encodes without padding.

/** Bytes as base64url without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(btoa(String.fromCharCode(...bytes.subarray(i, i + CHUNK))).replaceAll("+", "-").replaceAll("/", "_"));
  }
  return parts.join("").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let at = 0;
  // A multiple of 4 characters, so every chunk but the last decodes on its own.
  for (let i = 0; i < text.length; i += (CHUNK / 3) * 4) {
    const binary = atob(text.slice(i, i + (CHUNK / 3) * 4).replaceAll("-", "+").replaceAll("_", "/"));
    for (let j = 0; j < binary.length; j++) bytes[at++] = binary.charCodeAt(j);
  }
  return bytes.subarray(0, at);
}
