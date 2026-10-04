import { test } from "node:test";
import assert from "node:assert/strict";
import { fromBase64Url, toBase64Url } from "./base64.js";

test("base64url round-trips every length across chunk borders", () => {
  for (const length of [0, 1, 2, 3, 0x6000 - 1, 0x6000, 0x6000 + 1, 3 * 0x6000 + 2]) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 7919) % 256);
    const text = toBase64Url(bytes);
    assert.equal(text, Buffer.from(bytes).toString("base64url"));
    assert.deepEqual(fromBase64Url(text), bytes);
  }
});
