import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolGate } from "./tool-gate.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

function probe() {
  let running = 0;
  let max = 0;
  const log: string[] = [];
  const make = (name: string, ms = 10) => ({
    description: `d-${name}`,
    execute: async (input: unknown) => {
      running++;
      max = Math.max(max, running);
      log.push(`start:${name}`);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      log.push(`end:${name}`);
      return input;
    },
  });
  return { make, log, get max() { return max; }, get running() { return running; } };
}

test("six reads run at most four at once", async () => {
  const p = probe();
  const gate = createToolGate();
  const tools = gate(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`read_${i}`, p.make(`read_${i}`)])));
  const results = await Promise.all(Object.values(tools).map((t, i) => (t as any).execute(i, {})));
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
  assert.equal(p.max, 4);
});

test("a write waits for running reads, runs alone, and blocks later reads", async () => {
  const p = probe();
  const tools = createToolGate()({
    a: p.make("a", 30),
    b: p.make("b", 30),
    save_monitor: p.make("save_monitor", 20),
    c: p.make("c"),
  }) as Record<string, any>;
  await Promise.all([tools.a.execute(1, {}), tools.b.execute(1, {}), tools.save_monitor.execute(1, {}), tools.c.execute(1, {})]);
  const w = p.log.indexOf("start:save_monitor");
  assert.ok(p.log.indexOf("end:a") < w && p.log.indexOf("end:b") < w, "reads end before the write starts");
  assert.ok(p.log.indexOf("end:save_monitor") < p.log.indexOf("start:c"), "a later read waits for the write");
});

test("writes run in call order", async () => {
  const p = probe();
  const tools = createToolGate()({ set_timer: p.make("set_timer"), add_jira_comment: p.make("add_jira_comment") }) as Record<string, any>;
  await Promise.all([tools.set_timer.execute(1, {}), tools.add_jira_comment.execute(1, {})]);
  assert.deepEqual(p.log, ["start:set_timer", "end:set_timer", "start:add_jira_comment", "end:add_jira_comment"]);
});

test("tool properties and the execute arguments pass through", async () => {
  const toModelOutput = () => "x";
  let seen: unknown;
  const tools = createToolGate()({
    lookup: { description: "d", inputSchema: { a: 1 }, toModelOutput, execute: async (i: unknown, o: unknown) => { seen = [i, o]; return "ok"; } },
    client: { description: "no execute" },
  }) as Record<string, any>;
  assert.equal(tools.lookup.description, "d");
  assert.equal(tools.lookup.toModelOutput, toModelOutput);
  const options = { toolCallId: "t1", abortSignal: new AbortController().signal };
  assert.equal(await tools.lookup.execute("in", options), "ok");
  assert.deepEqual(seen, ["in", options]);
  assert.deepEqual(tools.client, { description: "no execute" });
});

test("abort rejects a call that waits in the queue and frees its slot", async () => {
  const p = probe();
  const tools = createToolGate(1)({ a: p.make("a", 30), b: p.make("b") }) as Record<string, any>;
  const ac = new AbortController();
  const first = tools.a.execute(1, {});
  const queued = tools.b.execute(1, { abortSignal: ac.signal });
  await tick();
  ac.abort(new Error("stopped"));
  await assert.rejects(queued, /stopped/);
  await first;
  assert.ok(!p.log.includes("start:b"));
  assert.equal(await tools.b.execute(2, {}), 2, "the gate still works");
});

test("abort reaches a running tool through its options", async () => {
  const ac = new AbortController();
  const tools = createToolGate()({
    slow: { execute: (_: unknown, o: { abortSignal: AbortSignal }) => new Promise((_res, rej) => o.abortSignal.addEventListener("abort", () => rej(new Error("aborted")))) },
  }) as Record<string, any>;
  const run = tools.slow.execute(1, { abortSignal: ac.signal });
  await tick();
  ac.abort();
  await assert.rejects(run, /aborted/);
});
