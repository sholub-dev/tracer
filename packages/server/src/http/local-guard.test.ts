import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HttpBindings } from "@hono/node-server";
import { guardLocalRequests } from "./local-guard.js";

const ok = () => new Response("ok");
const env = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } }) as unknown as HttpBindings;
const call = (bind: string, url: string, host: string, peer = "127.0.0.1") =>
  guardLocalRequests(ok, bind)(new Request(url, { headers: { host } }), env(peer)) as Response;

describe("guardLocalRequests", () => {
  it("accepts loopback Host names on a loopback server", () => {
    for (const host of ["localhost:3579", "127.0.0.1:3579", "[::1]:3579", "localhost:5173"]) {
      assert.equal(call("127.0.0.1", "http://x/api/trpc/settings.get", host).status, 200, host);
    }
  });

  it("rejects a rebound domain on a loopback server", () => {
    assert.equal(call("127.0.0.1", "http://x/api/trpc/settings.get", "evil.example:3579").status, 403);
    assert.equal(call("127.0.0.1", "http://x/api/chat", "evil.example").status, 403);
  });

  it("allows LAN Host names on an exposed server but keeps the copy routes local", () => {
    assert.equal(call("0.0.0.0", "http://x/api/trpc/settings.get", "192.168.1.5:3579", "192.168.1.9").status, 200);
    assert.equal(call("0.0.0.0", "http://x/api/trpc/transfer.send", "192.168.1.5:3579", "192.168.1.9").status, 403);
    assert.equal(call("0.0.0.0", "http://x/api/trpc/settings.get,transfer.send", "192.168.1.5:3579", "192.168.1.9").status, 403);
    assert.equal(call("0.0.0.0", "http://x/api/trpc/transfer%2Esend", "192.168.1.5:3579", "192.168.1.9").status, 403);
    assert.equal(call("0.0.0.0", "http://x/api/trpc/%74ransfer.send", "192.168.1.5:3579", "192.168.1.9").status, 403);
    assert.equal(call("0.0.0.0", "http://x/api/trpc/transfer.send", "evil.example", "127.0.0.1").status, 403);
    assert.equal(call("0.0.0.0", "http://x/api/trpc/transfer.send", "localhost:3579", "::ffff:127.0.0.1").status, 200);
  });

  const send = (method: string, path: string, headers: Record<string, string>, body = "{}") =>
    guardLocalRequests(ok, "127.0.0.1", ["http://localhost:5173"])(
      new Request(`http://x${path}`, { method, headers: { host: "localhost:3579", ...headers }, body: method === "GET" ? undefined : body }),
      env("127.0.0.1"),
    ) as Response;

  it("rejects a foreign Origin on a write but not on a read", () => {
    assert.equal(send("POST", "/api/chat", { origin: "https://evil.example", "content-type": "application/json" }).status, 403);
    assert.equal(send("POST", "/api/chat", { "sec-fetch-site": "cross-site", "content-type": "application/json" }).status, 403);
    assert.equal(send("GET", "/api/v1/x", { origin: "https://evil.example" }).status, 200);
  });

  it("requires a JSON body on API routes outside tRPC", () => {
    assert.equal(send("POST", "/api/v1/analyze", { "content-type": "text/plain" }).status, 415);
    assert.equal(send("POST", "/api/v1/analyze", {}).status, 415);
    assert.equal(send("POST", "/api/v1/analyze", { "content-type": "application/json; charset=utf-8" }).status, 200);
  });

  it("accepts a write with no Origin, the same Origin or an allowed Origin", () => {
    const json = { "content-type": "application/json" };
    assert.equal(send("POST", "/api/v1/analyze", json).status, 200);
    assert.equal(send("POST", "/api/v1/analyze", { ...json, origin: "http://localhost:3579" }).status, 200);
    assert.equal(send("POST", "/api/v1/analyze", { ...json, origin: "http://localhost:5173" }).status, 200);
  });

  it("requires the bearer token on /api of an exposed server and leaves a loopback server alone", () => {
    const via = (bind: string, headers: Record<string, string>, token: string | null = "s3cret") =>
      (guardLocalRequests(ok, bind, [], token)(new Request("http://x/api/trpc/settings.get", { headers: { host: "192.168.1.5", ...headers } }), env("192.168.1.9")) as Response).status;
    assert.equal(via("0.0.0.0", {}), 401);
    assert.equal(via("0.0.0.0", { authorization: "Bearer wrong!" }), 401);
    assert.equal(via("0.0.0.0", { authorization: "Bearer s3cret" }), 200);
    assert.equal(via("127.0.0.1", { host: "localhost" }), 200);
  });

  it("lets a loopback peer skip the token on an exposed server", () => {
    const from = (peer: string, headers: Record<string, string> = {}) =>
      (guardLocalRequests(ok, "0.0.0.0", [], "s3cret")(new Request("http://x/api/trpc/settings.get", { headers: { host: "localhost", ...headers } }), env(peer)) as Response).status;
    assert.equal(from("127.0.0.1"), 200);
    assert.equal(from("::ffff:127.0.0.1"), 200);
    assert.equal(from("192.168.1.9"), 401);
    assert.equal(from("192.168.1.9", { authorization: "Bearer s3cret" }), 200);
  });
});
