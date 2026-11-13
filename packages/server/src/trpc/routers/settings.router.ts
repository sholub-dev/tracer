import { z } from "zod";
import { publicProcedure, router } from "../trpc.js";
import type { Db } from "../../db/driver.js";
import { readProviderConfig, writeProviderConfig, deleteProviderConfig, readAppSetting, readAppSettings, writeAppSetting } from "../../db/config-reader.js";
import { maskSecret } from "../../lib/mask-secret.js";
import { getTimezone, isValidTimezone } from "../../lib/current-context.js";
import { ANTHROPIC_MIN_THINKING_BUDGET } from "../../llm/resolve.js";
import { CONFIG, DEFAULTS, SETTINGS_KEYS, type ModelConfig } from "../../config.js";

const apiKeyType = z.enum(["anthropic", "google"]);

const agentConfigInput = z.object({
  timezone: z.string().refine(isValidTimezone, "Invalid time zone").optional(),
  directModeMaxSteps: z.number().int().min(1).max(500).optional(),
  thinkingBudgetGoogle: z.number().int().min(0).max(100_000).optional(),
  thinkingBudgetAnthropic: z.number().int().max(100_000)
    .refine((n) => n === 0 || n >= ANTHROPIC_MIN_THINKING_BUDGET, `Use 0 or at least ${ANTHROPIC_MIN_THINKING_BUDGET}`)
    .optional(),
});

async function readStepAndBudgetSettings(db: Db) {
  const vals = await readAppSettings(db, [
    SETTINGS_KEYS.directModeMaxSteps,
    SETTINGS_KEYS.thinkingBudgetGoogle,
    SETTINGS_KEYS.thinkingBudgetAnthropic,
  ]);
  return {
    directModeMaxSteps: (vals[SETTINGS_KEYS.directModeMaxSteps] as number) ?? DEFAULTS.directModeMaxSteps,
    thinkingBudgetGoogle: (vals[SETTINGS_KEYS.thinkingBudgetGoogle] as number) ?? DEFAULTS.thinkingBudgetGoogle,
    thinkingBudgetAnthropic: (vals[SETTINGS_KEYS.thinkingBudgetAnthropic] as number) ?? DEFAULTS.thinkingBudgetAnthropic,
  };
}

export const settingsRouter = router({
  getApiKey: publicProcedure
    .input(apiKeyType)
    .query(async ({ ctx, input }) => {
      const config = await readProviderConfig(ctx.db, input);
      if (!config?.apiKey) return null;
      return { type: input, maskedApiKey: maskSecret(config.apiKey) };
    }),

  saveApiKey: publicProcedure
    .input(
      z.object({
        type: apiKeyType,
        apiKey: z.string().trim().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await writeProviderConfig(ctx.db, input.type, { apiKey: input.apiKey });
      return { success: true };
    }),

  removeApiKey: publicProcedure
    .input(apiKeyType)
    .mutation(async ({ ctx, input }) => {
      await deleteProviderConfig(ctx.db, input);
      return { success: true };
    }),

  // Vertex AI is enabled with a GCP project + location (credentials come from gcloud ADC,
  // not an API key). The config row's existence is the on/off state; projectId may be empty
  // when enabled but a project hasn't been picked yet. projectId/location aren't secrets, so
  // they're returned unmasked. Returns null when disabled.
  getVertexConfig: publicProcedure.query(async ({ ctx }) => {
    const config = await readProviderConfig(ctx.db, "google-vertex");
    if (!config) return null;
    return { projectId: config.projectId ?? "", location: config.location || "global" };
  }),

  // Upsert with merge semantics: `saveVertexConfig({})` enables Vertex (creates the row with
  // defaults), while passing a single field updates just that field. Used by the toggle and
  // by the project/location pickers.
  saveVertexConfig: publicProcedure
    .input(
      z.object({
        projectId: z.string().optional(),
        location: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await readProviderConfig(ctx.db, "google-vertex") ?? {};
      await writeProviderConfig(ctx.db, "google-vertex", {
        projectId: input.projectId ?? existing.projectId ?? "",
        location: input.location ?? existing.location ?? "global",
      });
      return { success: true };
    }),

  removeVertexConfig: publicProcedure.mutation(async ({ ctx }) => {
    await deleteProviderConfig(ctx.db, "google-vertex");
    return { success: true };
  }),

  getChatModel: publicProcedure.query(async ({ ctx }) => {
    return await readAppSetting<ModelConfig>(ctx.db, SETTINGS_KEYS.chatModel) ?? CONFIG.defaultChatModel;
  }),

  saveChatModel: publicProcedure
    .input(
      z.object({
        provider: z.string().min(1),
        modelId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await writeAppSetting(ctx.db, SETTINGS_KEYS.chatModel, { provider: input.provider, modelId: input.modelId });
      return { success: true };
    }),

  getAlertTriage: publicProcedure.query(async ({ ctx }) => await readAppSetting<boolean>(ctx.db, SETTINGS_KEYS.alertTriage) === true),

  setAlertTriage: publicProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await writeAppSetting(ctx.db, SETTINGS_KEYS.alertTriage, input.enabled);
      return { success: true };
    }),

  getAgentConfig: publicProcedure.query(async ({ ctx }) => ({
    timezone: await getTimezone(ctx.db),
    ...(await readStepAndBudgetSettings(ctx.db)),
  })),

  saveAgentConfig: publicProcedure
    .input(agentConfigInput)
    .mutation(async ({ ctx, input }) => {
      // The UI sends the whole form; writing only changed values keeps untouched defaults unpinned.
      const current = { timezone: await getTimezone(ctx.db), ...(await readStepAndBudgetSettings(ctx.db)) };
      const entries: [string, keyof typeof current][] = [
        [SETTINGS_KEYS.timezone, "timezone"],
        [SETTINGS_KEYS.directModeMaxSteps, "directModeMaxSteps"],
        [SETTINGS_KEYS.thinkingBudgetGoogle, "thinkingBudgetGoogle"],
        [SETTINGS_KEYS.thinkingBudgetAnthropic, "thinkingBudgetAnthropic"],
      ];
      for (const [key, field] of entries) {
        const val = input[field];
        if (val !== undefined && val !== current[field]) await writeAppSetting(ctx.db, key, val);
      }
      return { success: true };
    }),
});
