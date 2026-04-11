import { z } from "zod";
import { eq } from "drizzle-orm";
import { unixNow, DEFAULT_CHAT_MODE } from "@oko/shared";
import { publicProcedure, router } from "../trpc.js";
import { providerConfigs, appSettings } from "../../db/schema.js";
import { readProviderConfig, readAppSetting } from "../../db/config-reader.js";
import { DEFAULT_CHAT_MODEL, type ModelConfig } from "../../llm/resolve.js";

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
    return readAppSetting<ModelConfig>(ctx.db, "chat_model") ?? DEFAULT_CHAT_MODEL;
  }),

  saveChatModel: publicProcedure
    .input(
      z.object({
        provider: z.string().min(1),
        modelId: z.string().min(1),
      }),
    )
    .mutation(({ ctx, input }) => {
      const value = JSON.stringify({ provider: input.provider, modelId: input.modelId });
      const now = unixNow();
      ctx.db
        .insert(appSettings)
        .values({ key: "chat_model", value, updatedAt: now })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value, updatedAt: now },
        })
        .run();
      return { success: true };
    }),

  getChatMode: publicProcedure.query(({ ctx }) => {
    return readAppSetting<string>(ctx.db, "chat_mode") ?? DEFAULT_CHAT_MODE;
  }),

  saveChatMode: publicProcedure
    .input(z.enum(["orchestrator", "direct"]))
    .mutation(({ ctx, input }) => {
      const now = unixNow();
      ctx.db
        .insert(appSettings)
        .values({ key: "chat_mode", value: JSON.stringify(input), updatedAt: now })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: JSON.stringify(input), updatedAt: now },
        })
        .run();
      return { success: true };
    }),

  getSubAgentModel: publicProcedure
    .input(z.string().describe("Provider type, e.g. 'newrelic'"))
    .query(({ ctx, input }) => {
      return readAppSetting<ModelConfig>(ctx.db, `sub_agent_model:${input}`) ?? null;
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
      const key = `sub_agent_model:${input.providerType}`;
      const now = unixNow();
      if (input.model === null) {
        // Reset to default (Gemini Flash)
        ctx.db
          .delete(appSettings)
          .where(eq(appSettings.key, key))
          .run();
      } else {
        const value = JSON.stringify({ provider: input.model.provider, modelId: input.model.modelId });
        ctx.db
          .insert(appSettings)
          .values({ key, value, updatedAt: now })
          .onConflictDoUpdate({
            target: appSettings.key,
            set: { value, updatedAt: now },
          })
          .run();
      }
      return { success: true };
    }),
});
