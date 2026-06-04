/**
 * Registers the built-in provider factories (New Relic, GCP, PostHog).
 * Extracted from index.ts for separation of concerns.
 */

import type { ProviderRegistry } from "./registry.js";
import { NewRelicProvider } from "./newrelic/newrelic.provider.js";
import { GcpProvider } from "./gcp/gcp.provider.js";
import { PosthogProvider } from "./posthog/posthog.provider.js";
import { mcpDefinitions } from "../mcp/definitions.js";

export function registerDefaultProviders(providers: ProviderRegistry): void {
  providers.registerFactory(
    "newrelic",
    (cfg) => new NewRelicProvider({
      type: "newrelic",
      apiKey: cfg.apiKey,
      accountId: cfg.accountId,
    }),
    {
      label: "New Relic",
      configFields: [
        { key: "apiKey", label: "API Key", type: "password" },
        { key: "accountId", label: "Account ID", type: "text" },
      ],
    },
  );

  providers.registerFactory(
    "gcp",
    (cfg) => {
      const def = mcpDefinitions.get("gcp");
      if (!def) throw new Error('MCP definition for "gcp" not found');
      return new GcpProvider(def, cfg);
    },
    {
      label: "Google Cloud",
      configFields: [],
    },
  );

  providers.registerFactory(
    "posthog",
    (cfg) => new PosthogProvider({
      type: "posthog",
      apiKey: cfg.apiKey,
      projectId: cfg.projectId,
      host: cfg.host, // default (us.posthog.com) applied in PosthogClient
    }),
    {
      label: "PostHog",
      configFields: [
        { key: "apiKey", label: "Personal API Key", type: "password" },
        { key: "projectId", label: "Project ID", type: "text" },
        { key: "host", label: "Host", type: "text", required: false },
      ],
    },
  );
}
