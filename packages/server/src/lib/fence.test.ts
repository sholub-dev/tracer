import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeTag, fence, oneLine } from "./fence.js";

test("a fence escapes its own tag in any case and spacing, and leaves other text", () => {
  assert.equal(fence("tool_result", "rows"), "<tool_result>\nrows\n</tool_result>");
  for (const tag of ["</tool_result>", "</TOOL_RESULT>", "</tool_result >", "< / Tool_Result\n>", "<tool_result>", "<tool_result x=1>"]) {
    const escaped = escapeTag(`a${tag}b`, "tool_result");
    assert.ok(!/<\s*\/?\s*tool_result/i.test(escaped), tag);
    assert.ok(escaped.startsWith("a&lt;") && escaped.endsWith("&gt;b"), tag);
  }
  assert.equal(escapeTag("a</tool_result b", "tool_result"), "a&lt;/tool_result b");
  assert.equal(escapeTag("x < 5 and <b>y</b> </tool_results>", "tool_result"), "x < 5 and <b>y</b> </tool_results>");
});

test("oneLine joins lines and trims", () => {
  assert.equal(oneLine(" a\n\nb\tc "), "a b c");
});
