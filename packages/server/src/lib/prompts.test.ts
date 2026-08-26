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

test("every agent prompt contains the evidence-grounding section exactly once", () => {
  for (const [name, prompt] of allPrompts) {
    const count = prompt.split("## Grounded in Evidence").length - 1;
    assert.equal(count, 1, `${name}: expected exactly one grounding section, found ${count}`);
  }
});

test("grounding rules cover meaning, absence, and fact/deduction separation", () => {
  for (const phrase of ["opaque labels", "Absence requires an empty probe", "facts, deductions, and gaps", "Exact values only", "Scope claims to what you queried", "Label confidence"]) {
    assert.ok(EVIDENCE_GROUNDING.includes(phrase), `missing grounding rule: ${phrase}`);
  }
});

test("every agent prompt contains the root-cause discipline section exactly once", () => {
  for (const [name, prompt] of allPrompts) {
    const count = prompt.split("## Root-Cause Discipline").length - 1;
    assert.equal(count, 1, `${name}: expected exactly one root-cause section, found ${count}`);
  }
});

test("every agent prompt contains synthesis and writing-style sections exactly once", () => {
  for (const [name, prompt] of allPrompts) {
    for (const heading of ["## Synthesis: Count Incidents, Not Symptoms", "## Writing Style (Simplified Technical English)"]) {
      const count = prompt.split(heading).length - 1;
      assert.equal(count, 1, `${name}: expected exactly one "${heading}", found ${count}`);
    }
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
