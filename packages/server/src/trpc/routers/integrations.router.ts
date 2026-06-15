import { z } from "zod";
import { publicProcedure, router } from "../trpc.js";
import { JiraClient, normalizeJiraDomain } from "../../integrations/jira/jira.client.js";
import { readJiraConfig, writeJiraConfig, deleteJiraConfig } from "../../integrations/jira/config.js";

function maskToken(token: string): string {
  return token.length <= 4 ? "••••" : "••••••••" + token.slice(-4);
}

export const integrationsRouter = router({
  getJira: publicProcedure.query(({ ctx }) => {
    const config = readJiraConfig(ctx.db);
    if (!config) return { configured: false, config: null };
    return {
      configured: true,
      config: {
        domain: config.domain,
        email: config.email,
        apiToken: maskToken(config.apiToken),
      },
    };
  }),

  // Accepts a classic Atlassian API token (email + token). The token authenticates
  // against the site host with the account's permissions; Tracer constrains what it
  // can do at the code/tool layer (read one issue, post one comment). Validated with
  // a /myself call before persisting.
  saveJira: publicProcedure
    .input(
      z.object({
        domain: z.string().min(1),
        email: z.string().min(1),
        apiToken: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const domain = normalizeJiraDomain(input.domain);
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(domain)) {
        return {
          success: false,
          error: 'Enter just your Jira site name, e.g. "yourco" for yourco.atlassian.net',
        };
      }

      const config = { domain, email: input.email.trim(), apiToken: input.apiToken.trim() };
      const result = await new JiraClient(config).validate();
      if (!result.ok) {
        return { success: false, error: result.error ?? "Connection failed" };
      }
      writeJiraConfig(ctx.db, config);
      return { success: true };
    }),

  removeJira: publicProcedure.mutation(({ ctx }) => {
    deleteJiraConfig(ctx.db);
    return { success: true };
  }),
});
