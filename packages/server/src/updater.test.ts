import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { detectInstallMethod, isNewerVersion, withRetries } from "./updater.js";

test("detectInstallMethod classifies npx cache, global install, and source checkout", () => {
  assert.equal(detectInstallMethod(join("/home/u/.npm/_npx/d56038afd552885c", "node_modules", "tracer-sh")), "npx");
  assert.equal(detectInstallMethod(join("/usr/local/lib", "node_modules", "tracer-sh")), "global");
  assert.equal(detectInstallMethod(join("/home/u/Documents/GitHub", "tracer")), "dev");
  assert.equal(detectInstallMethod(null), "dev");
});

test("isNewerVersion compares semver and never sticks on prerelease suffixes", () => {
  assert.equal(isNewerVersion("0.3.5", "0.3.4"), true);
  assert.equal(isNewerVersion("0.4.0", "0.3.9"), true);
  assert.equal(isNewerVersion("1.0.0", "0.9.9"), true);
  assert.equal(isNewerVersion("0.3.4", "0.3.4"), false);
  assert.equal(isNewerVersion("0.3.3", "0.3.4"), false);
  // Prerelease digits parse instead of becoming NaN (NaN would disable updates forever).
  assert.equal(isNewerVersion("0.3.5-rc.1", "0.3.4"), true);
  assert.equal(isNewerVersion("0.3.4", "0.3.4-rc.1"), false);
});

test("withRetries retries transient failures and stops on success", async () => {
  let calls = 0;
  const flaky = async () => (++calls < 3 ? { ok: false, error: "Content-Length header of network response exceeds response Body" } : { ok: true });
  assert.deepEqual(await withRetries(flaky, 3, 1), { ok: true });
  assert.equal(calls, 3);
});

test("withRetries returns the last error when all attempts fail", async () => {
  let calls = 0;
  const dead = async () => { calls++; return { ok: false, error: `boom ${calls}` }; };
  assert.deepEqual(await withRetries(dead, 3, 1), { ok: false, error: "boom 3" });
  assert.equal(calls, 3);
});

test("withRetries does not retry after success", async () => {
  let calls = 0;
  const fine = async () => { calls++; return { ok: true }; };
  await withRetries(fine, 3, 1);
  assert.equal(calls, 1);
});
