export const SKILL_TARGETS = ["claude", "cursor"] as const;
export type SkillTarget = (typeof SKILL_TARGETS)[number];
