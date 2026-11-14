import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { chmodSync, mkdtempSync, existsSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveDbKey } from "./db-key.js";

delete process.env.TRACER_DB_KEY;
const KEY = "a".repeat(64);

function keychain(get: () => string | null, del: () => void = () => {}) {
  const calls = { get: 0, del: 0 };
  return {
    calls,
    entry: {
      getPassword: () => { calls.get++; return get(); },
      deletePassword: () => { calls.del++; del(); return true; },
    },
  };
}

function withHome(fn: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "tracer-key-"));
  const warn = console.warn;
  console.warn = () => {};
  try {
    fn(home);
  } finally {
    console.warn = warn;
    rmSync(home, { recursive: true, force: true });
  }
}

test("TRACER_DB_KEY wins and touches neither file nor keychain", () => withHome((home) => {
  process.env.TRACER_DB_KEY = KEY.toUpperCase();
  try {
    const kc = keychain(() => "b".repeat(64));
    assert.equal(resolveDbKey(home, { keychain: kc.entry, hasEncryptedDb: true }).key, KEY);
    assert.equal(kc.calls.get, 0);
    assert.equal(existsSync(join(home, "db-key")), false);
    process.env.TRACER_DB_KEY = "short";
    assert.throws(() => resolveDbKey(home), /64 hex/);
  } finally {
    delete process.env.TRACER_DB_KEY;
  }
}));

test("an existing key file wins and the keychain is never called", () => withHome((home) => {
  writeFileSync(join(home, "db-key"), KEY);
  const kc = keychain(() => "b".repeat(64));
  const r = resolveDbKey(home, { keychain: kc.entry, hasEncryptedDb: true });
  assert.equal(r.key, KEY);
  assert.equal(r.finishMigration, undefined);
  assert.equal(kc.calls.get, 0);
}));

test("migration writes a 0600 key file, deletes the entry only on finish", () => withHome((home) => {
  const kc = keychain(() => KEY);
  const r = resolveDbKey(home, { keychain: kc.entry, hasEncryptedDb: true });
  assert.equal(r.key, KEY);
  assert.equal(readFileSync(join(home, "db-key"), "utf8"), KEY);
  assert.equal(statSync(join(home, "db-key")).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(home), ["db-key"]);
  assert.equal(kc.calls.del, 0);
  r.finishMigration!();
  assert.equal(kc.calls.del, 1);
}));

test("a keychain read error during migration throws and creates no file", () => withHome((home) => {
  const kc = keychain(() => { throw new Error("keychain locked"); });
  assert.throws(() => resolveDbKey(home, { keychain: kc.entry, hasEncryptedDb: true }), /keychain locked[\s\S]*Nothing was changed/);
  assert.equal(existsSync(join(home, "db-key")), false);
}));

test("an encrypted DB with no keychain entry throws and creates no file", () => withHome((home) => {
  const kc = keychain(() => null);
  assert.throws(() => resolveDbKey(home, { keychain: kc.entry, hasEncryptedDb: true }), /Nothing was changed/);
  assert.throws(() => resolveDbKey(home, { keychain: null, hasEncryptedDb: true }), /Nothing was changed/);
  assert.equal(existsSync(join(home, "db-key")), false);
}));

test("a fresh install creates a key file and never calls the keychain", () => withHome((home) => {
  const kc = keychain(() => KEY);
  const r = resolveDbKey(home, { keychain: kc.entry });
  assert.match(r.key, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(join(home, "db-key"), "utf8"), r.key);
  assert.equal(statSync(join(home, "db-key")).mode & 0o777, 0o600);
  assert.equal(r.finishMigration, undefined);
  assert.deepEqual(kc.calls, { get: 0, del: 0 });
}));

test("finishMigration ignores delete errors", () => withHome((home) => {
  const kc = keychain(() => KEY, () => { throw new Error("denied"); });
  const r = resolveDbKey(home, { keychain: kc.entry, hasEncryptedDb: true });
  assert.doesNotThrow(() => r.finishMigration!());
  assert.equal(kc.calls.del, 1);
}));

test("a key file that other users can read becomes owner-only", { skip: process.platform === "win32" }, () => withHome((home) => {
  const keyPath = join(home, "db-key");
  writeFileSync(keyPath, KEY);
  chmodSync(keyPath, 0o644);
  assert.equal(resolveDbKey(home).key, KEY);
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
}));

test("a key file that appears during the keychain move wins and stays unchanged", () => withHome((home) => {
  const other = "c".repeat(64);
  const kc = keychain(() => { writeFileSync(join(home, "db-key"), other, { mode: 0o600 }); return KEY; });
  assert.equal(resolveDbKey(home, { keychain: kc.entry, hasEncryptedDb: true }).key, other);
  assert.equal(readFileSync(join(home, "db-key"), "utf8"), other);
  assert.deepEqual(readdirSync(home), ["db-key"]);
}));

test("an invalid key file that appears during the keychain move is never overwritten", () => withHome((home) => {
  const kc = keychain(() => { writeFileSync(join(home, "db-key"), "partial"); return KEY; });
  assert.throws(() => resolveDbKey(home, { keychain: kc.entry, hasEncryptedDb: true }), /does not hold a valid key/);
  assert.equal(readFileSync(join(home, "db-key"), "utf8"), "partial");
  assert.deepEqual(readdirSync(home), ["db-key"]);
}));

test("a fresh install replaces a key file that holds no valid key", () => withHome((home) => {
  writeFileSync(join(home, "db-key"), "partial");
  const r = resolveDbKey(home, { keychain: null });
  assert.match(r.key, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(join(home, "db-key"), "utf8"), r.key);
  assert.deepEqual(readdirSync(home), ["db-key"]);
}));

test("an invalid key file beside an encrypted database is never replaced", () => withHome((home) => {
  writeFileSync(join(home, "db-key"), "partial");
  assert.throws(() => resolveDbKey(home, { keychain: keychain(() => KEY).entry, hasEncryptedDb: true }), /does not hold a valid key/);
  assert.equal(readFileSync(join(home, "db-key"), "utf8"), "partial");
}));

function withoutLinks(code: string, fn: () => void) {
  const real = fs.linkSync;
  fs.linkSync = () => { throw Object.assign(new Error("link failed"), { code }); };
  syncBuiltinESMExports();
  try {
    fn();
  } finally {
    fs.linkSync = real;
    syncBuiltinESMExports();
  }
}

test("a file system without hard links gets the key file by a rename, and an existing key still wins", () => withHome((home) => {
  for (const code of ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]) {
    rmSync(join(home, "db-key"), { force: true });
    withoutLinks(code, () => {
      const r = resolveDbKey(home, { keychain: keychain(() => KEY).entry, hasEncryptedDb: true });
      assert.equal(r.key, KEY, code);
      assert.equal(readFileSync(join(home, "db-key"), "utf8"), KEY, code);
      assert.deepEqual(readdirSync(home), ["db-key"], code);
    });
  }
  const other = "c".repeat(64);
  rmSync(join(home, "db-key"));
  withoutLinks("EPERM", () => {
    const kc = keychain(() => { writeFileSync(join(home, "db-key"), other, { mode: 0o600 }); return KEY; });
    assert.equal(resolveDbKey(home, { keychain: kc.entry, hasEncryptedDb: true }).key, other);
    assert.equal(readFileSync(join(home, "db-key"), "utf8"), other);
  });
  withoutLinks("EACCES", () => {
    rmSync(join(home, "db-key"));
    assert.throws(() => resolveDbKey(home, { keychain: keychain(() => KEY).entry, hasEncryptedDb: true }), /link failed/);
    assert.equal(existsSync(join(home, "db-key")), false);
  });
}));
