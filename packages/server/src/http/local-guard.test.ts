import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "../db/node-db.js";
import { runSetup } from "../db/setup.js";
import { ProviderRegistry } from "../providers/registry.js";
import { transferRouter } from "../trpc/routers/transfer.router.js";
import { createApp } from "./app.js";
import { guardLocalRequests, isLoopbackBind } from "./local-guard.js";
import { loadSessionToken } from "./session-token.js";

const SESSION = "session-secret-session-secret-session-secre";
const TOKEN = "remote-token";
const ok = () => new Response("ok");

function status(
  path: string,
  headers: Record<string, string> = {},
  { method = "GET", bind = "127.0.0.1", token = null as string | null } = {},
): number {
  const guard = guardLocalRequests(ok, bind, ["http://localhost:5173"], SESSION, token);
  const req = new Request(`http://x${path}`, { method, headers: { host: "localhost:3579", ...headers }, body: method === "GET" ? undefined : "{}" });
  return (guard(req, undefined) as Response).status;
}
const owner = { authorization: `Bearer ${SESSION}` };
const remote = { authorization: `Bearer ${TOKEN}` };
const json = { "content-type": "application/json" };

describe("guardLocalRequests", () => {
  it("answers 401 to a local client with a loopback Host and no credential", () => {
    for (const path of ["/api/trpc/transfer.send", "/api/trpc/transfer.approve", "/api/trpc/settings.get", "/api/chat/subscribe/abc", "/api/unknown"]) {
      assert.equal(status(path), 401, path);
      assert.equal(status(path, {}, { bind: "0.0.0.0", token: TOKEN }), 401, path);
    }
    assert.equal(status("/api/v1/analyze", json, { method: "POST" }), 401);
    assert.equal(status("/api/trpc/transfer.send?batch=1", json, { method: "POST" }), 401);
    assert.equal(status("/%61pi/trpc/settings.get"), 401, "an encoded API path");
  });

  it("opens every route to the session secret", () => {
    for (const host of ["localhost:3579", "127.0.0.1:3579", "[::1]:3579", "localhost:5173"]) {
      assert.equal(status("/api/trpc/settings.get", { ...owner, host }), 200, host);
    }
    assert.equal(status("/api/trpc/transfer.send", owner), 200);
    assert.equal(status("/api/trpc/settings.get,transfer.send", owner, { bind: "0.0.0.0", token: TOKEN }), 200);
    assert.equal(status("/api/v1/analyze", { ...owner, ...json }, { method: "POST" }), 200);
  });

  it("rejects a wrong credential", () => {
    const wrong = [
      "Bearer wrong",
      `Bearer ${SESSION.slice(0, -1)}`,
      `Bearer ${SESSION}x`,
      `Bearer ${SESSION.slice(0, -1)}X`,
      `Basic ${SESSION}`,
      SESSION,
      "Bearer ",
    ];
    for (const authorization of wrong) {
      assert.equal(status("/api/trpc/settings.get", { authorization }), 401, authorization);
    }
    assert.equal(status("/api/trpc/settings.get", remote), 401, "no TRACER_TOKEN is set");
  });

  it("does not echo the credential", async () => {
    const guard = guardLocalRequests(ok, "127.0.0.1", [], SESSION);
    const res = guard(new Request("http://x/api/trpc/settings.get", { headers: { host: "localhost", authorization: "Bearer guess-123" } }), undefined) as Response;
    assert.equal(res.status, 401);
    assert.ok(!(await res.text()).includes("guess-123"));
  });

  it("leaves /health, the web app and its assets open", () => {
    for (const path of ["/health", "/", "/assets/index.js", "/debug/some-session"]) {
      assert.equal(status(path), 200, path);
      assert.equal(status(path, { host: "tracer.example" }, { bind: "0.0.0.0", token: TOKEN }), 200, path);
    }
  });

  it("lets the TRACER_TOKEN holder through; the copy procedures refuse it themselves", () => {
    const exposed = { bind: "0.0.0.0", token: TOKEN };
    assert.equal(status("/api/trpc/settings.get", { ...remote, host: "tracer.example" }, exposed), 200);
    assert.equal(status("/api/v1/analyze", { ...remote, ...json }, { ...exposed, method: "POST" }), 200);
    assert.equal(status("/api/trpc/transfer.send", remote, exposed), 200);
  });

  it("requires the credential from a loopback peer behind a proxy that adds no header", () => {
    const exposed = { bind: "0.0.0.0", token: TOKEN };
    assert.equal(status("/api/trpc/settings.get", { host: "localhost:3579" }, exposed), 401);
    assert.equal(status("/api/trpc/settings.get", { host: "127.0.0.1:3579" }, { token: TOKEN }), 401);
    assert.equal(status("/api/trpc/settings.get", { host: "localhost:3579", ...remote }, exposed), 200);
  });

  it("rejects a rebound domain on a loopback server unless it has a credential", () => {
    assert.equal(status("/api/trpc/settings.get", { host: "evil.example:3579" }), 403);
    assert.equal(status("/", { host: "evil.example" }), 403);
    assert.equal(status("/api/trpc/settings.get", { host: "evil.example", authorization: "Bearer wrong" }, { token: TOKEN }), 403);
    assert.equal(status("/api/trpc/settings.get", { host: "tunnel.example", ...remote }, { token: TOKEN }), 200);
    assert.equal(status("/api/trpc/settings.get", { host: "tunnel.example", ...owner }), 200);
  });

  it("rejects a cross-site request to the API on every method", () => {
    const crossSite = { ...owner, "sec-fetch-site": "cross-site" };
    assert.equal(status("/api/trpc/settings.get", crossSite), 403);
    assert.equal(status("/api/chat/subscribe/abc", crossSite), 403);
    assert.equal(status("/api/chat", { ...crossSite, ...json }, { method: "POST" }), 403);
    assert.equal(status("/api/trpc/settings.get", crossSite, { method: "OPTIONS" }), 403);
    assert.equal(status("/api/trpc/settings.get", { ...owner, "sec-fetch-site": "same-origin" }), 200);
    assert.equal(status("/", { "sec-fetch-site": "cross-site" }), 200, "a link from another site opens the web app");
  });

  it("rejects a foreign Origin on a write", () => {
    const write = { method: "POST" };
    assert.equal(status("/api/chat", { ...owner, ...json, origin: "https://evil.example" }, write), 403);
    assert.equal(status("/api/v1/analyze", { ...owner, ...json }, write), 200);
    assert.equal(status("/api/v1/analyze", { ...owner, ...json, origin: "http://localhost:3579" }, write), 200);
    assert.equal(status("/api/v1/analyze", { ...owner, ...json, origin: "http://localhost:5173" }, write), 200);
  });

  it("accepts the 127.0.0.1 address as Host and Origin", () => {
    const address = { host: "127.0.0.1:3579" };
    assert.equal(status("/", address), 200);
    assert.equal(status("/api/trpc/settings.get", address), 401);
    assert.equal(status("/api/trpc/settings.get", { ...address, ...owner }), 200);
    assert.equal(status("/api/chat", { ...address, ...owner, ...json, origin: "http://127.0.0.1:3579" }, { method: "POST" }), 200);
    assert.equal(status("/api/chat", { ...address, ...owner, ...json, origin: "http://localhost:3579" }, { method: "POST" }), 403);
  });

  it("requires a JSON body on API writes", () => {
    const write = { method: "POST" };
    assert.equal(status("/api/v1/analyze", { ...owner, "content-type": "text/plain" }, write), 415);
    assert.equal(status("/api/v1/analyze", owner, write), 415);
    assert.equal(status("/api/trpc/settings.saveApiKey", { ...owner, "content-type": "text/plain" }, write), 415);
    assert.equal(status("/api/v1/analyze", { ...owner, "content-type": "application/json; charset=utf-8" }, write), 200);
    assert.equal(status("/api/trpc/settings.saveApiKey?batch=1", { ...owner, ...json }, write), 200);
  });

  it("passes a preflight without a credential", () => {
    assert.equal(status("/api/trpc/settings.get", {}, { method: "OPTIONS" }), 200);
  });

  it("answers 400 to a path that does not decode", () => {
    assert.equal(status("/api/trpc/%E0%A4%A", owner), 400);
    assert.equal(status("/api/trpc/transfer%2", remote, { bind: "0.0.0.0", token: TOKEN }), 400);
  });
});

describe("isLoopbackBind", () => {
  it("accepts loopback addresses only", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "::1"]) assert.equal(isLoopbackBind(host), true, host);
    // The config turns the name "localhost" into 127.0.0.1 before it gets here.
    for (const host of ["0.0.0.0", "::", "192.168.1.5", "localhost", ""]) assert.equal(isLoopbackBind(host), false, host);
  });
});

describe("the copy procedures behind the guard", () => {
  type Reply = { status: number; body: string };
  const procedures = Object.entries(transferRouter._def.procedures as Record<string, { _def: { type: string } }>)
    .map(([name, procedure]) => ({ name, method: procedure._def.type === "query" ? "GET" : "POST" }));

  async function server() {
    const { db, setupDriver } = createNodeDb(new Database(":memory:"));
    await runSetup(setupDriver);
    const app = createApp({ db, providers: new ProviderRegistry(), activeStreams: new Map() });
    const guard = guardLocalRequests(app.fetch, "0.0.0.0", [], SESSION, TOKEN);
    return async (path: string, credential: Record<string, string>, method = "GET", body: BodyInit = "{}"): Promise<Reply> => {
      const init = method === "GET" ? {} : { body, duplex: "half" };
      const res = await guard(new Request(`http://x/api/trpc/${path}`, { method, headers: { host: "tracer.example", ...json, ...credential }, ...init }), {});
      return { status: res.status, body: await res.text() };
    };
  }
  const codes = (reply: Reply) =>
    (JSON.parse(reply.body) as { error?: { json: { data: { code: string } } } }[]).map((item) => item.error?.json.data.code ?? "OK");

  it("has procedures of both kinds to check", () => {
    assert.ok(procedures.some((p) => p.method === "GET") && procedures.some((p) => p.method === "POST"));
  });

  it("refuses TRACER_TOKEN on every transfer procedure", async () => {
    const call = await server();
    for (const { name, method } of procedures) {
      for (const path of [`transfer.${name}`, `transfer%2E${name}`, `%74ransfer.${name}`]) {
        const single = await call(path, remote, method);
        assert.equal(single.status, 403, path);
        assert.match(single.body, /"code":"FORBIDDEN"/, path);
        assert.deepEqual(codes(await call(`${path}?batch=1`, remote, method)), ["FORBIDDEN"], `batch ${path}`);
      }
    }
  });

  it("ignores a header that claims the owner", async () => {
    const call = await server();
    for (const header of ["x-owner", "x-tracer-owner", "isowner"]) {
      assert.equal((await call("transfer.sendStatus", { ...remote, [header]: "true" })).status, 403, header);
    }
  });

  it("opens the transfer procedures to the session secret", async () => {
    const call = await server();
    assert.equal((await call("transfer.sendStatus", owner)).status, 200);
    assert.equal((await call("transfer%2EsendStatus", owner)).status, 200);
    assert.deepEqual(codes(await call("transfer.sendStatus,transfer.lastSync?batch=1&input=%7B%7D", owner)), ["OK", "OK"]);
    assert.equal((await call("transfer.cancelSend", owner, "POST")).status, 200);
    assert.deepEqual(codes(await call("transfer.cancelSend?batch=1", owner, "POST")), ["OK"]);
    // The receiving procedures stay closed on the desktop server.
    assert.match((await call("transfer.receiveStatus", owner)).body, /does not receive/);
  });

  it("keeps the owner mark when the body arrives without a length", async () => {
    const call = await server();
    const stream = () => new Blob(["{}"]).stream();
    assert.equal((await call("transfer.cancelSend", owner, "POST", stream())).status, 200);
    assert.equal((await call("transfer.cancelSend", remote, "POST", stream())).status, 403);
  });

  it("fails only the transfer call in a mixed batch under TRACER_TOKEN", async () => {
    const call = await server();
    const batch = "?batch=1&input=%7B%7D";
    assert.deepEqual(codes(await call(`transfer.sendStatus,settings.getAlertTriage${batch}`, remote)), ["FORBIDDEN", "OK"]);
    assert.deepEqual(codes(await call(`settings.getAlertTriage,transfer.sendStatus${batch}`, remote)), ["OK", "FORBIDDEN"]);
    assert.deepEqual(codes(await call(`transfer.sendStatus,settings.getAlertTriage${batch}`, owner)), ["OK", "OK"]);
  });
});

describe("loadSessionToken", () => {
  const withHome = (run: (home: string) => void) => {
    const home = mkdtempSync(join(tmpdir(), "tracer-session-"));
    try { run(home); } finally { rmSync(home, { recursive: true, force: true }); }
  };

  it("creates an owner-only file and reuses it", () => withHome((home) => {
    const first = loadSessionToken(home);
    const file = join(home, "session-token");
    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(readFileSync(file, "utf8"), first);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(loadSessionToken(home), first);
  }));

  it("replaces a file that holds no valid secret", () => withHome((home) => {
    const file = join(home, "session-token");
    writeFileSync(file, "short\n", { mode: 0o644 });
    const fresh = loadSessionToken(home);
    assert.match(fresh, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(readFileSync(file, "utf8"), fresh);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  }));

  it("accepts a trailing newline", () => withHome((home) => {
    const file = join(home, "session-token");
    const first = loadSessionToken(home);
    writeFileSync(file, `${first}\n`);
    assert.equal(loadSessionToken(home), first);
  }));

  it("replaces a secret that other accounts could read", { skip: process.platform === "win32" }, () => withHome((home) => {
    const file = join(home, "session-token");
    const first = loadSessionToken(home);
    for (const mode of [0o640, 0o604]) {
      chmodSync(file, mode);
      const fresh = loadSessionToken(home);
      assert.notEqual(fresh, first);
      assert.match(fresh, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(readFileSync(file, "utf8"), fresh);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(loadSessionToken(home), fresh);
    }
  }));

  it("keeps the secret on a file system that holds no modes", { skip: process.platform === "win32" }, () => withHome((home) => {
    const file = join(home, "session-token");
    const first = loadSessionToken(home);
    chmodSync(file, 0o644);
    // There a chmod succeeds and changes nothing.
    assert.equal(loadSessionToken(home, () => {}), first);
    assert.equal(readFileSync(file, "utf8"), first);
  }));

  it("replaces a secret when the chmod fails", { skip: process.platform === "win32" }, () => withHome((home) => {
    const file = join(home, "session-token");
    const first = loadSessionToken(home);
    chmodSync(file, 0o644);
    const fresh = loadSessionToken(home, () => { throw new Error("EPERM"); });
    assert.notEqual(fresh, first);
    assert.equal(readFileSync(file, "utf8"), fresh);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }));

  it("uses the secret of a process that wrote the file first", () => withHome((home) => {
    const file = join(home, "session-token");
    const other = "o".repeat(43);
    const first = loadSessionToken(home, chmodSync, (from, to) => {
      writeFileSync(file, other, { mode: 0o600 });
      linkSync(from, to);
    });
    assert.equal(first, other);
    assert.equal(readFileSync(file, "utf8"), other);
    assert.deepEqual(readdirSync(home), ["session-token"]);
  }));

  it("writes with a rename on a file system that has no hard links", () => withHome((home) => {
    const fresh = loadSessionToken(home, chmodSync, () => { throw Object.assign(new Error("no links"), { code: "ENOTSUP" }); });
    assert.equal(readFileSync(join(home, "session-token"), "utf8"), fresh);
    assert.deepEqual(readdirSync(home), ["session-token"]);
  }));

  it("stops on a link error that is not about hard links", () => withHome((home) => {
    assert.throws(() => loadSessionToken(home, chmodSync, () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }), /denied/);
    assert.deepEqual(readdirSync(home), []);
  }));

  it("starts when an earlier process left its temp file", () => withHome((home) => {
    writeFileSync(join(home, `session-token.${process.pid}.tmp`), "stale");
    const first = loadSessionToken(home);
    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(loadSessionToken(home), first);
    assert.deepEqual(readdirSync(home).sort(), ["session-token", `session-token.${process.pid}.tmp`]);
  }));
});
