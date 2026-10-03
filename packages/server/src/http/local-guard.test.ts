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
});
