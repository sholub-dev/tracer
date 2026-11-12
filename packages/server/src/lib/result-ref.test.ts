import { test } from "node:test";
import assert from "node:assert/strict";
import { resultRefsToText } from "@tracer-sh/shared";

test("resultRefsToText turns result blocks into plain references and keeps other fences", () => {
  const text = "Errors rose.\n\n```result\nError rate by endpoint\n```\n\n```sql\nSELECT 1\n```";
  assert.equal(resultRefsToText(text), "Errors rose.\n\n[Chart: Error rate by endpoint]\n\n```sql\nSELECT 1\n```");
});
