import { test } from "node:test";
import assert from "node:assert/strict";
import { challengeLedger, createBeginAnalysisTool, type Ledger } from "./analysis-tool.js";

const clean: Ledger = {
  question: "cause",
  chain: "Errors 0 to 500 <- pool in use 50 of 50 <- deploy 42 at 14:30",
  chainEnd: "A change at the onset: deploy 42",
  conclusion: "Deploy 42 raised errors.",
  confidence: "confirmed",
  alternatives: [{ explanation: "Traffic spike", ruledOutBy: "Requests flat at 100/s" }],
  baseline: "0 errors yesterday, 500 today",
  causeEvidence: "Pool in use 50 of 50 from 14:35",
  contradictions: "",
};

const run = async (ledger: Ledger, review?: Parameters<typeof createBeginAnalysisTool>[0]) =>
  (createBeginAnalysisTool(review) as any).execute(ledger, { messages: [], toolCallId: "t" });

test("a lookup or a status check that found nothing wrong gets no challenges", () => {
  for (const question of ["lookup", "status"] as const) {
    assert.deepEqual(challengeLedger({ ...clean, question, chain: "", alternatives: [], baseline: "", contradictions: "x" }), []);
  }
});

test("a clean confirmed cause gets no challenges", () => {
  assert.deepEqual(challengeLedger(clean), []);
});

test("a cause without alternatives gets a challenge", () => {
  const c = challengeLedger({ ...clean, confidence: "likely", alternatives: [] });
  assert.equal(c.length, 1);
  assert.match(c[0], /competing explanation/);
});

test("a cause without its chain or the reason the chain ends gets a challenge", () => {
  for (const ledger of [{ ...clean, chain: "" }, { ...clean, chainEnd: undefined }, { ...clean, confidence: "likely" as const, chainEnd: "None" }]) {
    const c = challengeLedger(ledger);
    assert.equal(c.length, 1);
    assert.match(c[0], /deepest cause/);
  }
});

test("a confirmed cause with an open alternative names it", () => {
  const c = challengeLedger({ ...clean, alternatives: [{ explanation: "Cache miss", ruledOutBy: " " }] });
  assert.equal(c.length, 1);
  assert.match(c[0], /Cache miss/);
});

test("a confirmed cause without cause evidence gets a challenge", () => {
  for (const causeEvidence of ["", undefined]) {
    const c = challengeLedger({ ...clean, causeEvidence });
    assert.equal(c.length, 1);
    assert.match(c[0], /only the symptom/);
  }
  assert.deepEqual(challengeLedger({ ...clean, confidence: "likely", causeEvidence: "" }), []);
});

test("a confirmed cause without a baseline gets a challenge", () => {
  const c = challengeLedger({ ...clean, baseline: "" });
  assert.equal(c.length, 1);
  assert.match(c[0], /normal window/);
});

test("a likely cause needs no baseline or ruled-out result", () => {
  assert.deepEqual(challengeLedger({ ...clean, confidence: "likely", baseline: "", alternatives: [{ explanation: "x", ruledOutBy: "" }] }), []);
});

test("placeholder text counts as empty", () => {
  assert.deepEqual(challengeLedger({ ...clean, contradictions: "None." }), []);
  assert.equal(challengeLedger({ ...clean, baseline: "Not checked" }).length, 1);
  assert.equal(challengeLedger({ ...clean, alternatives: [{ explanation: "Cache miss", ruledOutBy: "N/A" }] }).length, 1);
});

test("contradictions get a challenge", () => {
  const c = challengeLedger({ ...clean, contradictions: "Errors also in service B" });
  assert.equal(c.length, 1);
  assert.match(c[0], /does not fit/);
});

test("output has only a status without challenges", async () => {
  assert.deepEqual(await run(clean), { status: "Analysis mode active. Follow the analysis rules from your system prompt." });
});

test("output lists challenges and the next step", async () => {
  const out = await run({ ...clean, baseline: "" });
  assert.equal(out.challenges.length, 1);
  assert.match(out.next, /Do not call begin_analysis again/);
});

test("a review of OK adds nothing", async () => {
  assert.equal((await run(clean, async () => "OK")).challenges, undefined);
  assert.equal((await run(clean, async () => "ok.")).challenges, undefined);
  assert.equal((await run(clean, async () => "**OK**")).challenges, undefined);
});

test("a review with text adds one challenge", async () => {
  const out = await run(clean, async () => "The error rate result shows no rise.");
  assert.deepEqual(out.challenges, ["The error rate result shows no rise."]);
});

test("a null review adds nothing", async () => {
  assert.equal((await run(clean, async () => null)).challenges, undefined);
});

test("a lookup is reviewed too, so a cause question filed as a lookup is challenged", async () => {
  const out = await run({ ...clean, question: "lookup" }, async () => "The question asks why: it is a cause.");
  assert.deepEqual(out.challenges, ["The question asks why: it is a cause."]);
});

test("a short \"no ...\" contradiction counts as none; elsewhere it is a result", () => {
  for (const empty of ["None found", "No contradictions", "No contradictions found."]) {
    assert.equal(challengeLedger({ ...clean, contradictions: empty }).length, 0, empty);
  }
  assert.equal(challengeLedger({ ...clean, contradictions: "No errors before 14:30, but 3 timeouts at 14:10 in the other pool" }).length, 1);
  assert.deepEqual(challengeLedger({ ...clean, baseline: "No errors yesterday", chainEnd: "No connected source holds it" }), []);
});
