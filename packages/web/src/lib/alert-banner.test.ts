import { test } from "node:test";
import assert from "node:assert/strict";
import { detectBanners, type SessionRow } from "./alert-banner.js";

const row = (id: string, status: string, kind: string | null = "monitor"): SessionRow => ({ id, kind, status });
const none = new Set<string>();

test("the first list only seeds the known ids", () => {
  const out = detectBanners(null, none, [row("a", "streaming"), row("b", "done")], null);
  assert.deepEqual([out.show, out.update], [[], []]);
  assert.deepEqual([...out.known], ["a", "b"]);
});

test("a new streaming monitor session shows a banner", () => {
  const out = detectBanners(new Set(["a"]), none, [row("a", "done"), row("b", "streaming")], null);
  assert.deepEqual(out.show, ["b"]);
});

test("a new session that is not a streaming monitor run shows nothing", () => {
  const list = [row("a", "done"), row("b", "streaming", "api"), row("c", "streaming", null), row("d", "idle")];
  assert.deepEqual(detectBanners(new Set(), none, list, null).show, []);
});

test("a re-check that reuses a known session shows nothing", () => {
  const out = detectBanners(new Set(["a"]), none, [row("a", "streaming")], null);
  assert.deepEqual(out.show, []);
});

test("a new idle monitor session shows once its run starts streaming", () => {
  const idle = detectBanners(new Set(), none, [row("a", "idle")], null);
  assert.deepEqual(idle.show, []);
  assert.equal(idle.known.has("a"), false);
  assert.deepEqual(detectBanners(idle.known, none, [row("a", "streaming")], null).show, ["a"]);
});

test("a shown session updates when its run ends", () => {
  const known = new Set(["a"]);
  assert.deepEqual(detectBanners(known, new Set(["a"]), [row("a", "streaming")], null).update, []);
  assert.deepEqual(detectBanners(known, new Set(["a"]), [row("a", "done")], null).update, ["a"]);
  assert.deepEqual(detectBanners(known, none, [row("a", "done")], null).update, []);
});

test("the active session is skipped", () => {
  assert.deepEqual(detectBanners(new Set(), none, [row("a", "streaming")], "a").show, []);
  assert.deepEqual(detectBanners(new Set(["a"]), new Set(["a"]), [row("a", "done")], "a").update, []);
});

test("a shown session that leaves the list is reported gone", () => {
  const known = new Set(["a", "b"]);
  const out = detectBanners(known, new Set(["a", "b"]), [row("b", "streaming")], null);
  assert.deepEqual(out.gone, ["a"]);
  assert.deepEqual(detectBanners(known, none, [row("b", "streaming")], null).gone, []);
});
