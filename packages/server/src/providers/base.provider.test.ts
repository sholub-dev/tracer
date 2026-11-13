import { test } from "node:test";
import assert from "node:assert/strict";
import { BaseProvider } from "./base.provider.js";

class Probe extends BaseProvider {
  readonly type = "probe";
  constructor(private readonly failure?: Error) { super(); }
  protected async probe() { if (this.failure) throw this.failure; }
  async executeRawQuery() { return null; }
}

test("ping sets the connection state and reports the failure reason", async () => {
  const ok = new Probe();
  assert.deepEqual(await ok.ping(), { ok: true });
  assert.equal(ok.connected, true);
  assert.ok(ok.lastChecked);
  const bad = new Probe(new Error("401 Unauthorized"));
  assert.deepEqual(await bad.ping(), { ok: false, error: "401 Unauthorized" });
  assert.equal(bad.connected, false);
});

test("initialize throws the failure reason and dispose clears the connection", async () => {
  await assert.rejects(new Probe(new Error("bad key")).initialize(), /bad key/);
  const p = new Probe();
  await p.initialize();
  assert.equal(p.connected, true);
  await p.dispose();
  assert.equal(p.connected, false);
});
