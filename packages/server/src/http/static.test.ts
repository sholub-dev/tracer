import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountStaticFiles } from "./static.js";

test("path aliases of one file share one cache entry", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tracer-static-")));
  const dist = join(root, "packages/web/dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<html></html>");
  writeFileSync(join(dist, "assets/a.js"), "let a;");
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const app = new Hono();
    mountStaticFiles(app);
    const first = await app.request("/assets/a.js");
    assert.equal(await first.text(), "let a;");
    assert.match(first.headers.get("cache-control") ?? "", /immutable/);
    // With the file gone, only the cache can answer.
    rmSync(join(dist, "assets/a.js"));
    for (const alias of ["/assets//a.js", "/assets/a.js/", "/assets/./a.js"]) {
      const res = await app.request(alias);
      assert.equal(await res.text(), "let a;", alias);
      assert.match(res.headers.get("cache-control") ?? "", /immutable/, alias);
    }
    assert.equal(await (await app.request("/assets/b.js")).text(), "<html></html>");
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});

function withDist(fn: (app: Hono, dist: string, root: string) => Promise<void>) {
  return async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tracer-static-")));
    const dist = join(root, "packages/web/dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), "<html></html>");
    writeFileSync(join(dist, "assets/a.js"), "let a;");
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const app = new Hono();
      mountStaticFiles(app);
      await fn(app, dist, root);
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test("case variants of one file share one cache entry on a case-insensitive disk", withDist(async (app, dist) => {
  if (!existsSync(join(dist, "ASSETS/A.JS"))) return;
  assert.equal(await (await app.request("/assets/A.JS")).text(), "let a;");
  // With the file gone, only the entry the variant made can answer the plain path.
  rmSync(join(dist, "assets/a.js"));
  const res = await app.request("/assets/a.js");
  assert.equal(await res.text(), "let a;");
  assert.match(res.headers.get("cache-control") ?? "", /immutable/);
  assert.equal(await (await app.request("/assets/A.Js")).text(), "<html></html>", "a variant adds no entry of its own");
}));

test("a link that leaves the web folder is not served", { skip: process.platform === "win32" }, withDist(async (app, dist, root) => {
  writeFileSync(join(root, "outside.txt"), "private");
  symlinkSync(join(root, "outside.txt"), join(dist, "assets/out.txt"));
  assert.equal(await (await app.request("/assets/out.txt")).text(), "<html></html>");
}));
