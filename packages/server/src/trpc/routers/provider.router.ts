import { z } from "zod";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { KNOWN_MODEL_IDS } from "@tracer-sh/shared";
import { publicProcedure, router } from "../trpc.js";
import { providerConfigs } from "../../db/schema.js";
import { readProviderConfig } from "../../db/config-reader.js";
import { getGcpAuth } from "../../providers/gcp/gcp-auth.js";

const timeRangeInput = z.object({
  since: z.string(),
  until: z.string().optional(),
});

export const providerRouter = router({
  list: publicProcedure.query(({ ctx }) => {
    return ctx.providers.getStatus();
  }),

  ping: publicProcedure.query(async ({ ctx }) => {
    const providers = ctx.providers.getAllProviders();
    const results = await Promise.allSettled(
      providers.map(async (p) => {
        const result = await p.ping();
        return { name: p.name, type: p.type, ...result };
      }),
    );
    return results.map((r) =>
      r.status === "fulfilled"
        ? r.value
        : { name: "unknown", type: "unknown", ok: false as const, error: "Ping failed" },
    );
  }),

  getRegisteredTypes: publicProcedure.query(({ ctx }) => {
    return ctx.providers.getRegisteredTypes();
  }),

  getConfigs: publicProcedure.query(({ ctx }) => {
    const rows = ctx.db.select().from(providerConfigs).all();
    const configs: Array<{ type: string; config: Record<string, string> }> = [];
    for (const row of rows) {
      let config: Record<string, string>;
      try {
        config = JSON.parse(row.config) as Record<string, string>;
      } catch {
        console.warn(`[provider] Corrupted config for provider "${row.type}"`);
        continue;
      }
      // Mask sensitive fields
      const masked: Record<string, string> = {};
      for (const [key, value] of Object.entries(config)) {
        if (key.toLowerCase().includes("key") || key.toLowerCase().includes("secret")) {
          masked[key] = value.length <= 4 ? "••••" : "••••••••" + value.slice(-4);
        } else {
          masked[key] = value;
        }
      }
      configs.push({ type: row.type, config: masked });
    }
    return configs;
  }),

  saveConfig: publicProcedure
    .input(
      z.object({
        type: z.string().min(1),
        config: z.record(z.string(), z.string()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.providers.getRegisteredTypes().some(t => t.type === input.type)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Unknown provider type: "${input.type}"`,
        });
      }

      const configJson = JSON.stringify(input.config);

      ctx.db
        .insert(providerConfigs)
        .values({ type: input.type, config: configJson })
        .onConflictDoUpdate({
          target: providerConfigs.type,
          set: { config: configJson },
        })
        .run();

      // Unregister existing provider if any, then create fresh
      await ctx.providers.unregister(input.type);

      const provider = ctx.providers.createFromFactory(input.type, input.config);
      ctx.providers.register(provider);

      let initError: string | undefined;
      try {
        await provider.initialize();
      } catch (err) {
        initError = err instanceof Error ? err.message : String(err);
        console.warn(`[provider] "${input.type}" failed to initialize:`, err);
      }
      return {
        success: provider.connected,
        error: provider.connected ? undefined : initError ?? "Connection test failed",
      };
    }),

  removeConfig: publicProcedure
    .input(z.string())
    .mutation(async ({ ctx, input }) => {
      ctx.db
        .delete(providerConfigs)
        .where(eq(providerConfigs.type, input))
        .run();
      await ctx.providers.unregister(input);
      return { success: true };
    }),

  testConnection: publicProcedure
    .input(z.string())
    .mutation(async ({ ctx, input }) => {
      const provider = ctx.providers.getProvider(input);
      if (!provider) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Provider "${input}" not found`,
        });
      }

      try {
        const success = await provider.testConnection();
        return { success };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }),

  // Generic data queries — replace the old newrelic-specific router
  getErrors: publicProcedure
    .input(z.object({ provider: z.string(), ...timeRangeInput.shape }))
    .query(async ({ ctx, input }) => {
      const p = ctx.providers.getProvider(input.provider);
      if (!p) return [];
      return p.getErrors(input);
    }),

  getTransactions: publicProcedure
    .input(z.object({ provider: z.string(), ...timeRangeInput.shape }))
    .query(async ({ ctx, input }) => {
      const p = ctx.providers.getProvider(input.provider);
      if (!p) return [];
      return p.getTransactions(input);
    }),

  getLogs: publicProcedure
    .input(
      z.object({
        provider: z.string(),
        ...timeRangeInput.shape,
        filter: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const p = ctx.providers.getProvider(input.provider);
      if (!p) return [];
      return p.getLogs(input, input.filter);
    }),

  executeQuery: publicProcedure
    .input(z.object({ provider: z.string(), query: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const p = ctx.providers.getProvider(input.provider);
      if (!p) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Provider "${input.provider}" not found`,
        });
      }
      return p.executeRawQuery(input.query);
    }),

  // Shared gcloud ADC auth status — both the GCP data provider's project selector and the
  // Vertex AI card poll this to surface a re-auth prompt (instead of an empty project list)
  // when credentials are missing or expired. Never returns the token.
  gcpAuthStatus: publicProcedure.query(async () => {
    const auth = await getGcpAuth();
    return auth.ok
      ? { ok: true as const }
      : { ok: false as const, code: auth.code, message: auth.message };
  }),

  listGcpProjects: publicProcedure.query(async () => {
    try {
      const auth = await getGcpAuth();
      if (!auth.ok) {
        console.warn(`[gcp] listGcpProjects: ${auth.code} — ${auth.message}`);
        return [];
      }
      const accessToken = auth.token;

      const all: Array<{ projectId: string; name: string }> = [];
      let pageToken: string | undefined;

      // Paginate through all active projects (max 500 to stay bounded)
      do {
        const url = new URL("https://cloudresourcemanager.googleapis.com/v1/projects");
        url.searchParams.set("filter", "lifecycleState:ACTIVE");
        url.searchParams.set("pageSize", "200");
        if (pageToken) url.searchParams.set("pageToken", pageToken);

        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          console.warn(`[gcp] Failed to list projects: ${res.status} ${res.statusText}`);
          break;
        }
        const data = (await res.json()) as {
          projects?: Array<{ projectId: string; name: string }>;
          nextPageToken?: string;
        };
        for (const p of data.projects ?? []) {
          all.push({ projectId: p.projectId, name: p.name });
        }
        pageToken = data.nextPageToken;
      } while (pageToken && all.length < 500);

      return all.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      console.warn("[gcp] Failed to list projects:", err instanceof Error ? err.message : err);
      return [];
    }
  }),

  // Discover the Gemini models available to the configured Vertex AI project. The
  // publisher-models endpoint isn't project-scoped in the path, so the selected project is
  // attributed via the X-Goog-User-Project header (for API-enablement + quota). Returns []
  // when Vertex isn't configured; falls back to the app's known Gemini IDs when discovery
  // fails, so a configured user never sees an empty dropdown.
  listVertexModels: publicProcedure.query(async ({ ctx }) => {
    const fallback = KNOWN_MODEL_IDS
      .filter((id) => id.startsWith("gemini"))
      .map((id) => ({ modelId: id, label: id }));

    const config = readProviderConfig(ctx.db, "google-vertex");
    const projectId = config?.projectId;
    if (!projectId) return [];
    const location = config.location || "global";

    try {
      const auth = await getGcpAuth();
      if (!auth.ok) {
        console.warn(`[vertex] listVertexModels: ${auth.code} — ${auth.message}`);
        return fallback;
      }
      const host = location === "global"
        ? "aiplatform.googleapis.com"
        : `${location}-aiplatform.googleapis.com`;

      const seen = new Set<string>();
      const models: Array<{ modelId: string; label: string }> = [];
      let pageToken: string | undefined;

      // Paginate the full publisher catalog (Imagen/embeddings/etc. are filtered out below).
      // Bound by pages fetched — the catalog is mostly non-Gemini, so counting kept models
      // wouldn't cap the loop. 20 pages × 200 covers the entire Google publisher catalog.
      for (let page = 0; page < 20; page++) {
        const url = new URL(`https://${host}/v1beta1/publishers/google/models`);
        url.searchParams.set("pageSize", "200");
        if (pageToken) url.searchParams.set("pageToken", pageToken);

        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${auth.token}`,
            "X-Goog-User-Project": projectId,
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          console.warn(`[vertex] Failed to list models: ${res.status} ${res.statusText}`);
          return models.length > 0 ? models : fallback;
        }
        const data = (await res.json()) as {
          publisherModels?: Array<{ name?: string }>;
          nextPageToken?: string;
        };
        for (const m of data.publisherModels ?? []) {
          const id = m.name?.split("/").pop();
          if (!id || !id.startsWith("gemini") || id.includes("embedding")) continue;
          if (seen.has(id)) continue;
          seen.add(id);
          models.push({ modelId: id, label: id });
        }
        pageToken = data.nextPageToken;
        if (!pageToken) break;
      }

      models.sort((a, b) => a.modelId.localeCompare(b.modelId));
      return models.length > 0 ? models : fallback;
    } catch (err) {
      console.warn("[vertex] Failed to list models:", err instanceof Error ? err.message : err);
      return fallback;
    }
  }),
});
