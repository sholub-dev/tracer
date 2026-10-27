import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveDbKey } from "./db-key.js";

delete process.env.TRACER_DB_KEY;
const KEY = "a".repeat(64);

function keychain(get: () => string | null) {
  const writes: string[] = [];
  return { writes, entry: { getPassword: get, setPassword: (p: string) => { writes.push(p); } } };
}

function withHome(fn: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "tracer-key-"));
  try {
    fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("a failed keychain read never replaces the key of an existing DB; with no DB it falls back to a key file", () => withHome((home) => {
  const kc = keychain(() => { throw new Error("keychain locked"); });
  assert.throws(() => resolveDbKey(home, { keychain: kc.entry, hasEncryptedDb: true }), /keychain locked/);
  assert.equal(existsSync(join(home, "db-key")), false);

  const key = resolveDbKey(home, { keychain: kc.entry });
  assert.equal(readFileSync(join(home, "db-key"), "utf8"), key);
  assert.equal(resolveDbKey(home, { keychain: kc.entry, hasEncryptedDb: true }), key, "the key file is reused");
  assert.deepEqual(kc.writes, []);
}));

test("resolveDbKey returns the stored key and generates one only when missing and no DB exists", () => withHome((home) => {
  assert.equal(resolveDbKey(home, { keychain: keychain(() => KEY).entry }), KEY);

  const fresh = keychain(() => null);
  const key = resolveDbKey(home, { keychain: fresh.entry });
  assert.deepEqual(fresh.writes, [key]);

  const orphan = keychain(() => null);
  assert.throws(() => resolveDbKey(home, { keychain: orphan.entry, hasEncryptedDb: true }), /Refusing to generate/);
  assert.deepEqual(orphan.writes, []);
}));
