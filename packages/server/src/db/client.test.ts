import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Set before the import: the module opens the database when it loads.
const home = mkdtempSync(join(tmpdir(), "tracer-client-"));
process.env.TRACER_HOME = home;
process.env.TRACER_DB_KEY = "a".repeat(64);
process.umask(0o022);

test("the database keeps temporary data in memory and its files are owner-only", async (t) => {
  const { sqlite } = await import("./client.js");
  t.after(() => {
    sqlite.close();
    rmSync(home, { recursive: true, force: true });
  });
  assert.equal(sqlite.pragma("temp_store", { simple: true }), 2);
  if (process.platform === "win32") return;
  sqlite.exec("CREATE TABLE t (x)");
  for (const suffix of ["", "-wal", "-shm"]) {
    assert.equal(statSync(join(home, "data", `tracer.db${suffix}`)).mode & 0o777, 0o600, `tracer.db${suffix}`);
  }
});
