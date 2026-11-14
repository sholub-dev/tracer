import { test } from "node:test";
import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { transcriptOf } from "./MessageView";

const wakeup = (note: string): UIMessage => ({
  id: "",
  role: "user",
  parts: [{ type: "text", text: `Follow-up timer (set 10:00, due 10:15, now 10:16): scheduled re-check\nThe timer_note block is your note.\n<timer_note>\n${note}\n</timer_note>` }],
});

test("the follow-up row shows the first line of the timer note, cut when it is long", () => {
  assert.equal(transcriptOf("", [wakeup("Check the error rate\nThen compare it with 09:00\nAnd close the issue")]), "Follow-up: Check the error rate");
  const long = transcriptOf("", [wakeup(`${"word ".repeat(60)}\nsecond line`)]);
  assert.equal(long.length, "Follow-up: ".length + 120);
  assert.ok(long.endsWith("word…"));
  assert.doesNotMatch(long, /second line/);
});
