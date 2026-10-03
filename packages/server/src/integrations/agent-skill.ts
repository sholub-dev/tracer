import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_TARGETS, type SkillTarget } from "./skill-targets.js";

export type SkillState = "installed" | "outdated" | "missing";

const TARGET_DIRS: Record<SkillTarget, string> = {
  claude: ".claude/skills/tracer",
  cursor: ".cursor/skills/tracer",
};

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  resolve(here, "../../../skills/tracer/SKILL.md"),    // bundled: packages/server/dist
  resolve(here, "../../../../skills/tracer/SKILL.md"), // dev: packages/server/src/integrations
];

let cached: string | undefined;

export function bundledSkill(): string {
  if (cached === undefined) {
    const path = candidates.find((p) => existsSync(p));
    if (!path) throw new Error("Bundled Tracer skill not found");
    cached = readFileSync(path, "utf-8");
  }
  return cached;
}

function skillPath(target: SkillTarget, home: string): string {
  return join(home, TARGET_DIRS[target], "SKILL.md");
}

export function skillStatus(home = homedir()) {
  const bundled = bundledSkill();
  return SKILL_TARGETS.map((target) => {
    const path = skillPath(target, home);
    let state: SkillState = "missing";
    if (existsSync(path)) state = readFileSync(path, "utf-8") === bundled ? "installed" : "outdated";
    return { target, state, path: join("~", TARGET_DIRS[target], "SKILL.md") };
  });
}

export function installSkill(target: SkillTarget, home = homedir()): void {
  const path = skillPath(target, home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, bundledSkill());
  renameSync(tmp, path);
}
