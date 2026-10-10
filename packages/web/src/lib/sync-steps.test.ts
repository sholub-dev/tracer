import { test } from "node:test";
import assert from "node:assert/strict";
import type { SyncSession } from "@tracer-sh/shared";
import { countdown, isSyncOver, modeText, progressFraction, progressText, stepMessage, stepStates } from "./sync-steps.js";

const session = (extra: Partial<SyncSession>): SyncSession => ({ phase: "waiting", computerName: "Mac", expiresAt: 0, ...extra });

test("each phase marks the steps before it done and itself current", () => {
  assert.deepEqual(stepStates(session({ phase: "waiting" })), ["current", "todo", "todo", "todo"]);
  assert.deepEqual(stepStates(session({ phase: "approval" })), ["done", "current", "todo", "todo"]);
  assert.deepEqual(stepStates(session({ phase: "transfer" })), ["done", "done", "current", "todo"]);
  assert.deepEqual(stepStates(session({ phase: "apply" })), ["done", "done", "done", "current"]);
  assert.deepEqual(stepStates(session({ phase: "done" })), ["done", "done", "done", "done"]);
});

test("a sync that ended badly leaves the step it reached as current", () => {
  assert.deepEqual(stepStates(session({ phase: "denied", reached: "approval" })), ["done", "current", "todo", "todo"]);
  assert.deepEqual(stepStates(session({ phase: "failed", reached: "apply" })), ["done", "done", "done", "current"]);
  assert.deepEqual(stepStates(session({ phase: "expired" })), ["current", "todo", "todo", "todo"]);
});

test("only the last phases end a sync", () => {
  for (const phase of ["done", "denied", "expired", "cancelled", "failed"] as const) assert.equal(isSyncOver(phase), true);
  for (const phase of ["waiting", "approval", "transfer", "apply"] as const) assert.equal(isSyncOver(phase), false);
});

test("the countdown reads minutes and seconds and stops at zero", () => {
  assert.equal(countdown(102_000, 0), "1:42");
  assert.equal(countdown(120_000, 1_000), "1:59");
  assert.equal(countdown(5_000, 9_000), "0:00");
});

test("the transfer text shows megabytes, or only the done part when the total is unknown", () => {
  const mb = 1024 * 1024;
  assert.equal(progressText({ done: 3 * mb, total: 12 * mb }), "3 of 12 MB");
  assert.equal(progressText({ done: 1.5 * mb, total: 4 * mb }), "1.5 of 4.0 MB");
  assert.equal(progressText({ done: 2 * mb, total: 0 }), "2.0 MB");
  assert.equal(progressFraction({ done: mb, total: 4 * mb }), 0.25);
  assert.equal(progressFraction({ done: mb, total: 0 }), null);
});

test("the message says what happens and who acts, for each device", () => {
  const approval = session({ phase: "approval", phoneName: "iPhone 1234" });
  assert.equal(stepMessage(approval, "computer"), "iPhone 1234 asks to sync. Click Allow.");
  assert.equal(stepMessage(approval, "phone"), "Now click Allow on your computer.");
  assert.equal(stepMessage(session({ phase: "apply" }), "phone"), "Saving on the phone. Keep Tracer open.");
  const result = { computer: { applied: 2, deleted: 1 }, phone: { applied: 4, deleted: 0 } };
  assert.equal(stepMessage(session({ phase: "done", mode: "merge", result }), "phone"), "Synced. Computer: 2 changed, 1 removed. Phone: 4 changed, 0 removed.");
});

test("a failure names the device and says when the computer saved its part", () => {
  const failed = session({ phase: "failed", mode: "merge", error: { message: "No space left.", side: "phone" }, result: { computer: { applied: 1, deleted: 0 } } });
  assert.equal(stepMessage(failed, "computer"), "Failed on the phone. No space left. The computer saved its part. Syncing again is safe.");
  const replace = session({ phase: "failed", mode: "replace", error: { message: "Broke.", side: "computer" } });
  assert.equal(stepMessage(replace, "phone"), "Failed on the computer. Broke.");
  assert.equal(stepMessage(session({ phase: "cancelled", error: { message: "Cancelled on the computer.", side: "computer" } }), "phone"), "Cancelled on the computer.");
});

test("the mode text names the computer from the device that reads it", () => {
  assert.equal(modeText("merge", "phone"), "Both devices keep the newest version of each item.");
  assert.match(modeText("replace", "computer"), /copy of this computer's data/);
  assert.match(modeText("replace", "phone"), /copy of the computer's data/);
});
