import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { isNewerVersion } from "@tracer-sh/shared";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { detectInstallMethod, withRetries, PERMANENT_NPM_ERROR, checkForUpdate, getUpdateStatus, findNpmCli, installArgs, isPlainVersion, quoteForCmd, VIEW_ARGS } from "./updater.js";

test("detectInstallMethod classifies npx cache, global install, and source checkout", () => {
  const globalRoot = join("/usr/local/lib", "node_modules");
  assert.equal(detectInstallMethod(join("/home/u/.npm/_npx/d56038afd552885c", "node_modules", "tracer-sh")), "npx");
  assert.equal(detectInstallMethod(join(globalRoot, "tracer-sh"), globalRoot), "global");
  assert.equal(detectInstallMethod(join("/home/u/Documents/GitHub", "tracer"), globalRoot), "dev");
  assert.equal(detectInstallMethod(null), "dev");
});

test("only the copy in npm's global folder is a global install", () => {
  const globalRoot = join("/usr/local/lib", "node_modules");
  for (const root of [
    join("/home/u/project", "node_modules", "tracer-sh"),
    join("/home/u/.local/share/pnpm/global/5/.pnpm/tracer-sh@0.7.0", "node_modules", "tracer-sh"),
    join("/home/u/.config/yarn/global", "node_modules", "tracer-sh"),
    join(globalRoot, "other", "node_modules", "tracer-sh"),
  ]) {
    assert.equal(detectInstallMethod(root, globalRoot), "dev", root);
  }
  // Without npm's answer nothing counts as global.
  assert.equal(detectInstallMethod(join(globalRoot, "tracer-sh")), "dev");
  assert.equal(detectInstallMethod(join(globalRoot, "tracer-sh"), null), "dev");
});

test("the install names the exact version", () => {
  assert.deepEqual(installArgs("global", "/g/node_modules/tracer-sh", "1.2.3"), ["install", "-g", "tracer-sh@1.2.3"]);
  assert.deepEqual(
    installArgs("npx", join("/home/u/.npm/_npx/abc", "node_modules", "tracer-sh"), "1.2.3"),
    ["install", "--prefix", join("/home/u/.npm/_npx/abc"), "tracer-sh@1.2.3"],
  );
});

test("the version check and the install name no registry of their own", () => {
  for (const args of [VIEW_ARGS, installArgs("global", "/g/node_modules/tracer-sh", "1.2.3"), installArgs("npx", "/c/node_modules/tracer-sh", "1.2.3")]) {
    assert.equal(args.some((a) => a.includes("registry")), false, args.join(" "));
  }
});

test("only a plain version passes", () => {
  for (const ok of ["1.2.3", "0.7.27", "10.0.0-rc.1"]) assert.equal(isPlainVersion(ok), true, ok);
  for (const bad of ["", "latest", "1.2", "v1.2.3", "1.2.3 && calc", "1.2.3\n4.5.6", "1.2.3 ", "^1.2.3", "1.2.3;x", "file:../x"]) {
    assert.equal(isPlainVersion(bad), false, bad);
  }
});

test("findNpmCli takes npm's own script and never another package manager", { skip: process.platform === "win32" }, (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tracer-npm-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = join(dir, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  mkdirSync(dirname(cli), { recursive: true });
  mkdirSync(join(dir, "bin"));
  writeFileSync(cli, "");
  writeFileSync(join(dir, "pnpm.cjs"), "");
  const node = join(dir, "bin", "node");

  assert.equal(findNpmCli(node, "", false), null);
  symlinkSync(cli, join(dir, "bin", "npm"));
  assert.equal(findNpmCli(node, "", false), cli);
  assert.equal(findNpmCli(node, join(dir, "pnpm.cjs"), false), cli);
  assert.equal(findNpmCli(join(dir, "elsewhere", "node"), cli, false), cli);
  assert.equal(findNpmCli(join(dir, "elsewhere", "node"), join(dir, "missing", "npm-cli.js"), false), null);

  // The Windows layout: npm sits beside node.exe.
  const winCli = join(dir, "win", "node_modules", "npm", "bin", "npm-cli.js");
  mkdirSync(dirname(winCli), { recursive: true });
  writeFileSync(winCli, "");
  assert.equal(findNpmCli(join(dir, "win", "node.exe"), "", true), winCli);
});

test("quoteForCmd wraps every argument and drops quotes", () => {
  assert.equal(quoteForCmd("install"), '"install"');
  assert.equal(quoteForCmd("C:\\Program Files\\x & y"), '"C:\\Program Files\\x & y"');
  assert.equal(quoteForCmd('a" & calc & "b'), '"a & calc & b"');
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

test("withRetries stops immediately on permanent errors", async () => {
  let calls = 0;
  const denied = async () => { calls++; return { ok: false, error: "npm error code EACCES: permission denied" }; };
  assert.deepEqual(await withRetries(denied, 3, 1), { ok: false, error: "npm error code EACCES: permission denied" });
  assert.equal(calls, 1);
});

test("permanent-error pattern matches install-blocking codes but not transient network errors", () => {
  for (const permanent of ["EACCES", "EPERM", "ENOSPC", "E404", "ETARGET"]) {
    assert.ok(PERMANENT_NPM_ERROR.test(`npm error code ${permanent}`), `should match ${permanent}`);
  }
  for (const transient of [
    "Content-Length header of network response exceeds response Body",
    "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "socket hang up",
  ]) {
    assert.ok(!PERMANENT_NPM_ERROR.test(transient), `should not match ${transient}`);
  }
});

test("a failed check keeps an earlier available status", async () => {
  await checkForUpdate(async () => "999.0.0");
  assert.equal(getUpdateStatus().available, true);
  await checkForUpdate(async () => null);
  assert.equal(getUpdateStatus().available, true);
  assert.equal(getUpdateStatus().latestVersion, "999.0.0");
  await checkForUpdate(async () => { throw new Error("offline"); });
  assert.equal(getUpdateStatus().latestVersion, "999.0.0");
});

test("a version that is not a plain version is ignored", async () => {
  await checkForUpdate(async () => "999.0.0");
  for (const bad of ["latest", "1000.0.0 && calc", "1000.0.0\n1001.0.0"]) {
    await checkForUpdate(async () => bad);
    assert.equal(getUpdateStatus().latestVersion, "999.0.0");
  }
});
