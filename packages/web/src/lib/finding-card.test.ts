import { test } from "node:test";
import assert from "node:assert/strict";
import { latestCard, matchSources, partialFinding } from "./finding-card";

test("a partial streaming card shows the fields it has", () => {
  assert.equal(partialFinding({}), null);
  assert.equal(partialFinding({ kind: "root_cause" }), null);
  const c = partialFinding({ kind: "root_cause", verdict: "problem", title: "Pool full", explanation: [{ statement: "Errors rose", source: "Error ra" }, { statement: "Pool at 100", source: "Pool" }] }, true);
  assert.equal(c?.title, "Pool full");
  assert.equal(c?.confidence, undefined);
  assert.deepEqual(c?.explanation.map((e) => e.source), ["Error ra", ""]);
});

test("a finished card keeps every source and defaults confidence", () => {
  const c = partialFinding({ kind: "root_cause", title: "t", answer: "a", explanation: [{ statement: "s", source: "Q1" }], unknown: "u" }, true);
  assert.equal(c?.explanation[0].source, "Q1");
  assert.equal(partialFinding({ kind: "root_cause", title: "t", answer: "a", explanation: [{ statement: "s", source: "Q1" }] })?.confidence, "unverified");
});

test("an old card keeps its headline as the answer", () => {
  const c = partialFinding({ kind: "summary", headline: "All fine", details: "- one\n- two", points: [] });
  assert.equal(c?.title, "");
  assert.equal(c?.answer, "All fine");
  assert.equal(c?.explanation.length, 2);
});

test("a rejected card stays until the next card has content", () => {
  const input = { kind: "summary", title: "t", answer: "a", explanation: [{ statement: "s", source: "Q" }] };
  const rejected = { type: "tool-report_finding", state: "output-available", input, output: { recorded: false } };
  const next = { type: "tool-report_finding", state: "input-streaming", input: {} };
  assert.equal(latestCard([rejected, next], true)?.revising, true);
  assert.equal(latestCard([rejected, next], false)?.revising, false);
  const filled = { ...next, input: { ...input, title: "better" } };
  const live = latestCard([rejected, filled], true);
  assert.equal(live?.card.title, "better");
  assert.equal(live?.revising, false);
  const recorded = { ...rejected, input: { ...input, title: "first" }, output: { recorded: true } };
  assert.equal(latestCard([recorded, rejected], false)?.card.title, "first", "after the run, the recorded card wins");
  assert.equal(latestCard([rejected], false)?.card.confidence, "unverified", "a card that never passed shows as unverified");
});

test("sources match parts by title ignoring case", () => {
  const parts = [{ id: 1, input: { title: "Error rate" } }, { id: 2, input: { title: "Pool use" } }, { id: 3, input: {} }];
  assert.deepEqual(matchSources(["pool USE", "Missing"], parts).map((p) => p?.id), [2, undefined]);
});

test("a source matches its successful query before a later failed one", () => {
  const ok = { id: 1, input: { title: "Errors" }, state: "output-available", output: { rows: [] } };
  const failed = { id: 2, input: { title: "Errors" }, state: "output-error" };
  assert.equal(matchSources(["Errors"], [ok, failed])[0]?.id, 1);
  assert.equal(matchSources(["Errors"], [failed])[0]?.id, 2);
});
