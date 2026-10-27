import { test } from "node:test";
import assert from "node:assert/strict";
import { diffBanners, remainingSeconds, type PendingFiring } from "./firing-confirm.js";

const firing = (id: string): PendingFiring => ({ id, monitorName: "M", detail: "Value 2", remainingMs: 5000 });

test("the countdown starts from the server's remaining time and ticks down locally", () => {
  assert.equal(remainingSeconds(5000, 1000, 1000), 5);
  assert.equal(remainingSeconds(5000, 1000, 2500), 4);
  assert.equal(remainingSeconds(4200, 0, 0), 5);
});

test("the countdown stops at zero", () => {
  assert.equal(remainingSeconds(5000, 0, 5000), 0);
  assert.equal(remainingSeconds(5000, 0, 9000), 0);
});

test("a new list opens a banner per new firing and closes those the server dropped", () => {
  const first = diffBanners(new Set(), [firing("a"), firing("b")]);
  assert.deepEqual(first.show.map((f) => f.id), ["a", "b"]);
  assert.deepEqual(first.gone, []);
  const next = diffBanners(new Set(["a", "b"]), [firing("b"), firing("c")]);
  assert.deepEqual(next.show.map((f) => f.id), ["c"]);
  assert.deepEqual(next.gone, ["a"]);
});

test("an empty list closes every banner", () => {
  assert.deepEqual(diffBanners(new Set(["a", "b"]), []), { show: [], gone: ["a", "b"] });
});
