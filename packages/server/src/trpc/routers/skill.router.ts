import { z } from "zod";
import { publicProcedure, router } from "../trpc.js";
import { SKILL_TARGETS } from "../../integrations/skill-targets.js";

// Loaded on demand: it reads and writes files in the home directory, which only the desktop server can do.
const agentSkill = () => import("../../integrations/agent-skill.js");

export const skillRouter = router({
  status: publicProcedure.query(async () => (await agentSkill()).skillStatus()),
  install: publicProcedure
    .input(z.enum(SKILL_TARGETS))
    .mutation(async ({ input }) => (await agentSkill()).installSkill(input)),
});
