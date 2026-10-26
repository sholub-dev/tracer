import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { Inline } from "./inline-markdown";

const bold = (text: string) => [...renderToStaticMarkup(<Inline text={text} highlight />).matchAll(/<strong[^>]*>([^<]*)<\/strong>/g)].map((m) => m[1]);

test("figures are highlighted; step numbers, times, names and ids are not", () => {
  assert.deepEqual(bold("5,548 users on Step 1 averaged 28.18 seconds, up 82% at 15:41 PDT"), ["5,548", "28.18", "82%"]);
  assert.deepEqual(bold("PROD-SVC-2 call v2 took 0.76s vs 1.4 s on 2026-10-22, error rate −12%"), ["0.76s", "1.4 s", "−12%"]);
  assert.deepEqual(bold("**3 errors** in 7 days"), ["3 errors"]);
  assert.equal(renderToStaticMarkup(<Inline text="12 calls" />), "12 calls");
});
