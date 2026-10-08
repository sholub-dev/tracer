import { test } from "node:test";
import assert from "node:assert/strict";
import { isEmptyQuery, isFailedQuery } from "../agents/chat/sub-agent.js";
import { buildAfterComplete } from "./provider-tool-helpers.js";

const params = { sessionId: "s", lastUserMessage: "q", lastAssistantText: "a" } as never;

// A db that throws on use proves the memory agent started: the deferred work logs a warning and the test reads the flag.
function started(queries: Array<{ query: string; results: unknown }>): boolean {
  let used = false;
  const db = new Proxy({}, { get: () => { used = true; throw new Error("stop"); } });
  const warn = console.warn;
  console.warn = () => {};
  try {
    buildAfterComplete({ providerType: "newrelic", db: db as never, memoryContext: { toolName: "newrelic", existingMemories: [] }, collectedQueries: queries })(params);
  } finally {
    console.warn = warn;
  }
  return used;
}

test("error and empty results are told apart from rows", () => {
  assert.equal(isFailedQuery({ query: "q", results: { error: "bad" } }), true);
  assert.equal(isFailedQuery({ query: "q", results: [{ a: 1 }] }), false);
  assert.equal(isEmptyQuery({ query: "q", results: [] }), true);
  assert.equal(isEmptyQuery({ query: "q", results: [{ a: 1 }] }), false);
});

test("a clean turn skips the memory agent; an error or empty result runs it", () => {
  assert.equal(started([{ query: "q", results: [{ a: 1 }] }]), false);
  assert.equal(started([]), false);
  assert.equal(started([{ query: "q", results: [{ a: 1 }] }, { query: "q2", results: { error: "x" } }]), true);
  assert.equal(started([{ query: "q", results: [] }]), true);
});
