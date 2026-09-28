import { z } from "zod";
import { publicProcedure, router } from "../trpc.js";
import { SKILL_TARGETS, installSkill, skillStatus } from "../../integrations/agent-skill.js";

export const skillRouter = router({
  status: publicProcedure.query(() => skillStatus()),
  install: publicProcedure
    .input(z.enum(SKILL_TARGETS))
    .mutation(({ input }) => installSkill(input)),
});
