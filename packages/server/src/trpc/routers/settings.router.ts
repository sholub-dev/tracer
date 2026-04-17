import { z } from "zod";
import { eq } from "drizzle-orm";
import { DEFAULT_CHAT_MODE } from "@tracer-sh/shared";
import { publicProcedure, router } from "../trpc.js";
import { providerConfigs, appSettings } from "../../db/schema.js";
import { readProviderConfig, readAppSetting, readAppSettings, writeAppSetting } from "../../db/config-reader.js";
import { CONFIG, DEFAULTS, SETTINGS_KEYS, subAgentModelKey, type ModelConfig } from "../../config.js";
import { FEATURES } from "../../feature-flags.js";

export const settingsRouter = router({
  getApiKey: publicProcedure
    .input(z.string())
    .query(({ ctx, input }) => {
      const config = readProviderConfig(ctx.db, input);
      if (!config?.apiKey) return null;
      const masked =
        config.apiKey.length <= 4
          ? "••••"
          : "••••••••" + config.apiKey.slice(-4);
      return { type: input, maskedApiKey: masked };
    }),

  saveApiKey: publicProcedure
    .input(
      z.object({
        type: z.string().min(1),
        apiKey: z.string().min(1),
      }),
    )
    .mutation(({ ctx, input }) => {
      const configJson = JSON.stringify({ apiKey: input.apiKey });
      ctx.db
        .insert(providerConfigs)
        .values({ type: input.type, config: configJson })
        .onConflictDoUpdate({
          target: providerConfigs.type,
          set: { config: configJson },
        })
        .run();
      return { success: true };
    }),

  removeApiKey: publicProcedure
    .input(z.string())
    .mutation(({ ctx, input }) => {
      ctx.db
        .delete(providerConfigs)
        .where(eq(providerConfigs.type, input))
        .run();
      return { success: true };
    }),

  getChatModel: publicProcedure.query(({ ctx }) => {
    return readAppSetting<ModelConfig>(ctx.db, SETTINGS_KEYS.chatModel) ?? CONFIG.defaultChatModel;
  }),

  saveChatModel: publicProcedure
    .input(
      z.object({
        provider: z.string().min(1),
        modelId: z.string().min(1),
      }),
    )
    .mutation(({ ctx, input }) => {
      writeAppSetting(ctx.db, SETTINGS_KEYS.chatModel, { provider: input.provider, modelId: input.modelId });
      return { success: true };
    }),

  getChatMode: publicProcedure.query(({ ctx }) => {
    if (!FEATURES.orchestratorMode) return DEFAULT_CHAT_MODE;
    return readAppSetting<string>(ctx.db, SETTINGS_KEYS.chatMode) ?? DEFAULT_CHAT_MODE;
  }),

  saveChatMode: publicProcedure
    .input(z.enum(["orchestrator", "direct"]))
    .mutation(({ ctx, input }) => {
      if (!FEATURES.orchestratorMode && input === "orchestrator") {
        return { success: false };
      }
      writeAppSetting(ctx.db, SETTINGS_KEYS.chatMode, input);
      return { success: true };
    }),

  getSubAgentModel: publicProcedure
    .input(z.string().describe("Provider type, e.g. 'newrelic'"))
    .query(({ ctx, input }) => {
      return readAppSetting<ModelConfig>(ctx.db, subAgentModelKey(input)) ?? null;
    }),

  saveSubAgentModel: publicProcedure
    .input(
      z.object({
        providerType: z.string().min(1),
        model: z.object({
          provider: z.string().min(1),
          modelId: z.string().min(1),
        }).nullable(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const key = subAgentModelKey(input.providerType);
      if (input.model === null) {
        ctx.db.delete(appSettings).where(eq(appSettings.key, key)).run();
      } else {
        writeAppSetting(ctx.db, key, { provider: input.model.provider, modelId: input.model.modelId });
      }
      return { success: true };
    }),

  getAgentConfig: publicProcedure.query(({ ctx }) => {
    const keys = [
      SETTINGS_KEYS.timezone,
      SETTINGS_KEYS.directModeMaxSteps,
      SETTINGS_KEYS.subAgentMaxSteps,
      SETTINGS_KEYS.thinkingBudgetGoogle,
      SETTINGS_KEYS.thinkingBudgetAnthropic,
    ];
    const vals = readAppSettings(ctx.db, keys);
    return {
      timezone: (vals[SETTINGS_KEYS.timezone] as string) ?? DEFAULTS.timezone,
      directModeMaxSteps: (vals[SETTINGS_KEYS.directModeMaxSteps] as number) ?? DEFAULTS.directModeMaxSteps,
      subAgentMaxSteps: (vals[SETTINGS_KEYS.subAgentMaxSteps] as number) ?? DEFAULTS.subAgentMaxSteps,
      thinkingBudgetGoogle: (vals[SETTINGS_KEYS.thinkingBudgetGoogle] as number) ?? DEFAULTS.thinkingBudgetGoogle,
      thinkingBudgetAnthropic: (vals[SETTINGS_KEYS.thinkingBudgetAnthropic] as number) ?? DEFAULTS.thinkingBudgetAnthropic,
    };
  }),

  saveAgentConfig: publicProcedure
    .input(z.object({
      timezone: z.string().optional(),
      directModeMaxSteps: z.number().min(1).max(500).optional(),
      subAgentMaxSteps: z.number().min(1).max(500).optional(),
      thinkingBudgetGoogle: z.number().min(0).max(100_000).optional(),
      thinkingBudgetAnthropic: z.number().min(0).max(100_000).optional(),
    }))
    .mutation(({ ctx, input }) => {
      const entries: [string, unknown][] = [
        [SETTINGS_KEYS.timezone, input.timezone],
        [SETTINGS_KEYS.directModeMaxSteps, input.directModeMaxSteps],
        [SETTINGS_KEYS.subAgentMaxSteps, input.subAgentMaxSteps],
        [SETTINGS_KEYS.thinkingBudgetGoogle, input.thinkingBudgetGoogle],
        [SETTINGS_KEYS.thinkingBudgetAnthropic, input.thinkingBudgetAnthropic],
      ];
      for (const [key, val] of entries) {
        if (val !== undefined) writeAppSetting(ctx.db, key, val);
      }
      return { success: true };
    }),
});
