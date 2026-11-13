import type { ProviderRegistry } from "./registry.js";
import { NewRelicProvider } from "./newrelic/newrelic.provider.js";
import { PosthogProvider } from "./posthog/posthog.provider.js";

/** Registers the New Relic and PostHog factories; `registerPlatformProviders` runs between them to keep the Settings list order. */
export function registerDefaultProviders(
  providers: ProviderRegistry,
  registerPlatformProviders?: (providers: ProviderRegistry) => void,
): void {
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

  registerPlatformProviders?.(providers);

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
