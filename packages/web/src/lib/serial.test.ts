import { test } from "node:test";
import assert from "node:assert/strict";
import { serialQueue } from "./serial.js";

test("tasks run one after another, also after a failure", async () => {
  const run = serialQueue();
  const log: string[] = [];
  const task = (name: string, ms: number, fail = false) => async () => {
    log.push(`start ${name}`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`end ${name}`);
    if (fail) throw new Error(name);
    return name;
  };
  const a = run(task("a", 20, true));
  const b = run(task("b", 1));
  await assert.rejects(a);
  assert.equal(await b, "b");
  assert.deepEqual(log, ["start a", "end a", "start b", "end b"]);
});
