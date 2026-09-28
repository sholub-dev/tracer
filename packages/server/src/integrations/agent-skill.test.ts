import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledSkill, installSkill, skillStatus } from "./agent-skill.js";

test("skillStatus and installSkill track missing, installed and outdated", () => {
  const home = mkdtempSync(join(tmpdir(), "tracer-skill-"));
  try {
    const states = () => Object.fromEntries(skillStatus(home).map((s) => [s.target, s.state]));
    assert.deepEqual(states(), { claude: "missing", cursor: "missing" });

    installSkill("claude", home);
    installSkill("claude", home);
    const claudePath = join(home, ".claude/skills/tracer/SKILL.md");
    assert.equal(readFileSync(claudePath, "utf-8"), bundledSkill());
    assert.deepEqual(states(), { claude: "installed", cursor: "missing" });

    writeFileSync(claudePath, "old");
    installSkill("cursor", home);
    assert.deepEqual(states(), { claude: "outdated", cursor: "installed" });
    assert.equal(skillStatus(home)[1]!.path, "~/.cursor/skills/tracer/SKILL.md");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
