import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUnifiedModePrompt, EVIDENCE_GROUNDING } from "./shared-prompts.js";
import { directModeSystemPrompt as nrDirect } from "../providers/newrelic/prompts.js";
import { gcpDirectModeSystemPrompt as gcpDirect } from "../providers/gcp/prompts.js";
import { directModeSystemPrompt as posthogDirect } from "../providers/posthog/prompts.js";

const unified = buildUnifiedModePrompt(["# FakeProvider\n(fragment)"], 50);
const allPrompts: Array<[string, string]> = [
  ["unified", unified],
  ["newrelic direct", nrDirect],
  ["gcp direct", gcpDirect],
  ["posthog direct", posthogDirect],
];

test("every agent prompt contains each shared discipline section exactly once", () => {
  const headings = [
    "## Grounded in Evidence",
    "## Root-Cause Discipline",
    "## Synthesis: Count Incidents, Not Symptoms",
    "## Writing Style (Simplified Technical English)",
  ];
  for (const [name, prompt] of allPrompts) {
    for (const heading of headings) {
      const count = prompt.split(heading).length - 1;
      assert.equal(count, 1, `${name}: expected exactly one "${heading}", found ${count}`);
    }
  }
});

test("grounding rules cover meaning, absence, and fact/deduction separation", () => {
  for (const phrase of ["opaque labels", "Absence requires an empty probe", "facts, deductions, and gaps", "Exact values only", "Scope claims to what you queried", "Label confidence"]) {
    assert.ok(EVIDENCE_GROUNDING.includes(phrase), `missing grounding rule: ${phrase}`);
  }
});

test("final reminders reference sections that actually exist", () => {
  for (const [name, prompt] of allPrompts) {
    assert.ok(prompt.includes("Stay Grounded in Evidence"), `${name}: missing grounding reminder`);
    // Regression guard: the old reminder cited rules that existed nowhere.
    assert.ok(!prompt.includes("Follow the Detective mindset:"), `${name}: stale Detective mindset reference`);
  }
});

test("unified prompt sections appear in the intended order", () => {
  const order = ["## Rules", "## Mindset", "## Grounded in Evidence", "## Root-Cause Discipline", "## Synthesis", "## Execution Discipline", "# FakeProvider", "## Response Format", "## Writing Style", "## Final Reminders"];
  let last = -1;
  for (const heading of order) {
    const idx = unified.indexOf(heading);
    assert.ok(idx > last, `unified: ${heading} out of order or missing`);
    last = idx;
  }
});

test("prompts allow batching only independent reads and keep writes alone", () => {
  for (const [name, prompt] of allPrompts) {
    assert.ok(prompt.includes("**Batch only independent reads.** You may make up to 4 tool calls in one step"), `${name}: missing batch rule`);
    assert.ok(prompt.includes("Never batch begin_analysis, report_finding, or any tool that records, reports or changes state"), `${name}: missing write rule`);
    assert.ok(!prompt.includes("ONE tool call per step"), `${name}: stale one-call rule`);
  }
});

test("prompts require competing explanations and a challenge check, and never forbid a disproving query", () => {
  for (const [name, prompt] of allPrompts) {
    assert.equal(prompt.split("### Challenge check").length - 1, 1, `${name}: expected one Challenge check`);
    for (const phrase of ["Hold at least two explanations", "Check the base rate", "Check coverage", "Count before you generalize", "Never drop a result that does not fit", "Treat every prior as a hypothesis", "Economy limits breadth, never verification"]) {
      assert.ok(prompt.includes(phrase), `${name}: missing "${phrase}"`);
    }
    for (const stale of ["never run extra investigation queries for it", "they cost thought, not extra steps", "or \"to confirm\""]) {
      assert.ok(!prompt.includes(stale), `${name}: stale rule "${stale}"`);
    }
  }
});

test("prompts tell the agent to report a finding in every turn that ran at least one query", () => {
  for (const [name, prompt] of allPrompts) {
    assert.ok(prompt.includes("call `report_finding` once, alone in its step, in every turn that ran at least one query"), `${name}: missing report_finding rule`);
    assert.ok(prompt.includes("`kind: \"root_cause\"`") && prompt.includes("`kind: \"summary\"`"), `${name}: missing finding kinds`);
    assert.ok(prompt.includes("the one check that would confirm it") && !prompt.includes("only place you may name an action"), `${name}: finding card must not allow an action`);
    assert.ok(prompt.includes("Skip it only when no query ran"), `${name}: missing skip rule`);
    assert.ok(prompt.includes("`details`: 1 to 5 sentences") && prompt.includes("The card is the whole written answer"), `${name}: missing details rule`);
    assert.ok(prompt.includes("at most 3 tool calls") && prompt.includes("Nothing after the last visual"), `${name}: missing visuals rule`);
    for (const stale of ["Visual-first narrative", "End with a concise conclusion", "It does not replace the written answer"]) {
      assert.ok(!prompt.includes(stale), `${name}: stale rule "${stale}"`);
    }
  }
});

test("the evidence rule and the no-fixes principle each appear once in the assembled prompt", () => {
  for (const [name, prompt] of allPrompts) {
    for (const phrase of ["Only the literal text of tool results from this session is evidence", "Never state an action anyone should take on the system", "**Never say you cannot do something that a tool covers.**"]) {
      assert.equal(prompt.split(phrase).length - 1, 1, `${name}: expected one "${phrase}"`);
    }
  }
});
