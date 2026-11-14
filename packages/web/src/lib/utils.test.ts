import { test } from "node:test";
import assert from "node:assert/strict";
import { isInlineFileUrl, selectedLabel } from "./utils";

const options = [{ value: "a", label: "Alpha (a)", displayLabel: "Alpha" }, { value: "b", label: "Beta" }];

test("a saved value missing from the options still shows on the button", () => {
  assert.equal(selectedLabel(options, "my-project", "Select project"), "my-project");
});

test("shows the chosen option and the placeholder for an empty value", () => {
  assert.equal(selectedLabel(options, "a", "Select"), "Alpha");
  assert.equal(selectedLabel(options, "b", "Select"), "Beta");
  assert.equal(selectedLabel(options, "", "Select"), "Select");
});

test("singleFlight joins calls made while one runs", async () => {
  const { singleFlight } = await import("./utils");
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const run = singleFlight(async () => { runs++; await gate; });
  const a = run();
  const b = run();
  release();
  await Promise.all([a, b]);
  await run();
  assert.equal(runs, 2);
});

test("only data: and blob: URLs count as inline file URLs", () => {
  for (const url of ["data:image/png;base64,AA==", "DATA:application/pdf;base64,AA==", "blob:http://localhost:3579/1b2c"]) assert.ok(isInlineFileUrl(url), url);
  for (const url of ["javascript:alert(1)", "https://example.com/a.png", "//example.com/a.png", "/api/x", " data:text/html,x", "", undefined]) assert.ok(!isInlineFileUrl(url), String(url));
});
