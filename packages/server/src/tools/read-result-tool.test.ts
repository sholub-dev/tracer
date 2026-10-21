import { test } from "node:test";
import assert from "node:assert/strict";
import { readResultTool } from "./read-result-tool.js";

const run = async (originals: Map<string, string>, id: string) => {
  const t = readResultTool(originals) as unknown as {
    execute: (i: { id: string }) => Promise<unknown>;
    toModelOutput: (a: { output: unknown }) => { value: string };
  };
  return t.toModelOutput({ output: await t.execute({ id }) }).value;
};

test("read_result returns the original text of a known id", async () => {
  const text = "<tool_result>\nrows\n</tool_result>";
  assert.equal(await run(new Map([["a", text]]), "a"), text);
});

test("read_result reports an unknown id", async () => {
  assert.equal(await run(new Map(), "zz"), "Error: No result with that id.");
});
