import { test } from "node:test";
import assert from "node:assert/strict";
import { challengeLedger, createBeginAnalysisTool, type Ledger } from "./analysis-tool.js";

const clean: Ledger = {
  question: "cause",
  chain: "Errors 0 to 500 <- pool in use 50 of 50 <- deploy 42 at 14:30",
  chainEnd: "A change at the onset: deploy 42",
  split: {
    volume: { statement: "Requests stayed at 100 per second against 100 normally.", sources: ["Request volume"] },
    rate: { statement: "Error rate rose from 0.2% to 5.4%.", sources: ["Error rate"] },
    slice: { statement: "100% of the rise is on /checkout.", sources: ["Errors by endpoint"] },
  },
  afterEnd: undefined,
  conclusion: "Deploy 42 raised errors.",
  confidence: "confirmed",
  alternatives: [{ explanation: "Traffic spike", ruledOutBy: "Requests flat at 100/s" }],
  baseline: "0 errors yesterday, 500 today",
  causeEvidence: "Pool in use 50 of 50 from 14:35",
  contradictions: "",
};

const query = (id: string, title: string, result: string) => [
  { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: id, toolName: "execute_nrql", input: { title } }] },
  { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: id, toolName: "execute_nrql", output: { type: "text" as const, value: result } }] },
];
const turn = () => [
  { role: "user" as const, content: "why?" },
  ...query("a", "Request volume", "affected,normal\n100,100"),
  ...query("b", "Error rate", "affected,normal\n5.4,0.2"),
  ...query("c", "Errors by endpoint", "endpoint,share\n/checkout,100"),
];
const run = async (ledger: Ledger, review?: Parameters<typeof createBeginAnalysisTool>[0], messages: unknown[] = turn()) =>
  (createBeginAnalysisTool(review) as any).execute(ledger, { messages, toolCallId: "t" });

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

test("a cause without every split part gets one challenge naming the missing parts", () => {
  for (const split of [undefined, { ...clean.split!, slice: { statement: "", sources: [""] } }]) {
    const c = challengeLedger({ ...clean, split }).filter((x) => x.startsWith("The split lacks"));
    assert.equal(c.length, 1);
  }
  assert.match(challengeLedger({ ...clean, split: { ...clean.split!, slice: { statement: "None", sources: [""] } } })[0], /lacks slice:/);
});

test("a conclusion that says the symptom ended needs the count after the end", () => {
  for (const conclusion of ["Errors stopped at 14:40.", "The pool recovered.", "No longer failing."]) {
    const c = challengeLedger({ ...clean, conclusion });
    assert.equal(c.length, 1, conclusion);
    assert.match(c[0], /after the end/);
  }
  const afterEnd = { statement: "0 requests and 0 errors after 14:40.", sources: ["Request volume"] };
  assert.deepEqual(challengeLedger({ ...clean, conclusion: "Errors stopped at 14:40.", afterEnd }), []);
});

test("a split part with an unknown source or a number its result lacks is a challenge", async () => {
  const wrongNumber = { ...clean, split: { ...clean.split!, volume: { statement: "Requests fell to 4,200 per second.", sources: ["Request volume"] } } };
  const out = await run(wrongNumber);
  assert.equal(out.challenges.length, 1);
  assert.match(out.challenges[0], /split\.volume: 4,200 is not in the result of "Request volume"/);
  const unknown = await run({ ...clean, split: { ...clean.split!, rate: { ...clean.split!.rate, sources: ["Made up"] } } });
  assert.match(unknown.challenges[0], /split\.rate: source "Made up" is not the title/);
  const union = await run({ ...clean, split: { ...clean.split!, volume: { statement: "Requests stayed at 100 against 100 normally, error rate 5.4.", sources: ["Request volume", "Error rate"] } } });
  assert.equal(union.challenges, undefined);
  const ended = await run({ ...clean, conclusion: "Errors ended at 14:40.", afterEnd: { statement: "12 errors after 14:40.", sources: ["Error rate"] } });
  assert.match(ended.challenges[0], /afterEnd: 12 is not in the result/);
});

test("calling traffic a bot needs an indicator and its share of the change", () => {
  const bot = { ...clean, conclusion: "A bot from one IP raised errors." };
  assert.ok(challengeLedger(bot).some((c) => /actor\.indicator/.test(c)));
  const part = { statement: "One IP sent 90% of requests against 1% normally.", sources: ["Requests by IP"] };
  assert.ok(!challengeLedger({ ...bot, actor: { verdict: "suspected abuse", indicator: part, holdsChange: part } }).some((c) => /actor\.indicator/.test(c)));
  assert.ok(!challengeLedger(clean).some((c) => /actor\.indicator/.test(c)));
});

test("a negated end, a resolver, a negated bot and a synthetic monitor raise no challenge", () => {
  for (const conclusion of ["DNS resolver timeouts raised errors.", "Errors did not stop.", "The pool never recovered.", "Not a bot: spread over 4,000 clients.", "Synthetic monitor checks failed on login."]) {
    assert.deepEqual(challengeLedger({ ...clean, conclusion }), [], conclusion);
  }
});

test("a split part can cite a query that ran in the same step", async () => {
  const tool = createBeginAnalysisTool(undefined, undefined, new Map(), () => 0, () => [{ toolName: "execute_nrql", input: { title: "Late volume" }, text: "affected,normal\n100,100" }]) as any;
  const ledger = { ...clean, split: { ...clean.split!, volume: { ...clean.split!.volume, sources: ["Late volume"] } } };
  assert.equal((await tool.execute(ledger, { messages: turn(), toolCallId: "t" })).challenges, undefined);
});

test("a conclusion that rules out bots is not a bot claim", () => {
  assert.ok(!challengeLedger({ ...clean, conclusion: "The data rules out bots: the rise is spread over 4,000 clients." }).some((c) => /actor\.indicator/.test(c)));
});
