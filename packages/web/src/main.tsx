import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchStreamLink, httpSubscriptionLink, retryLink, splitLink, type TRPCLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "@tracer-sh/server/router";
import { trpc } from "./lib/trpc";
import { WEB_CONFIG } from "./lib/config";
import { App } from "./App";
import "./index.css";

function Root({ links }: { links?: TRPCLink<AppRouter>[] }) {
  // No focus refetch: it re-runs every active query at once and can swap the chat view mid-stream.
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: 1,
        staleTime: WEB_CONFIG.sessionStaleTimeMs,
      },
    },
  }));
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: links ?? [
        splitLink({
          condition: (op) => op.type === "subscription",
          // A failed reconnect (e.g. 502 while the server restarts) otherwise ends the subscription for good.
          true: [
            retryLink({ retry: () => true, retryDelayMs: (attempt) => Math.min(1_000 * attempt, WEB_CONFIG.subscriptionRetryMaxMs) }),
            httpSubscriptionLink({ url: "/api/trpc", transformer: superjson }),
          ],
          false: httpBatchStreamLink({ url: "/api/trpc", transformer: superjson }),
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

function render(links?: TRPCLink<AppRouter>[]) {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Root links={links} />
    </StrictMode>,
  );
}

// The mode check stays inline so the desktop build drops the iOS runtime entirely.
if (import.meta.env.MODE === "ios") {
  import("./lib/ios-runtime")
    .then((m) => m.startIosRuntime())
    .then(render, (err: unknown) => {
      console.error("Tracer failed to start:", err instanceof Error ? err.stack : String(err));
      void import("./components/layout/StartupError").then(({ StartupError }) =>
        createRoot(document.getElementById("root")!).render(<StartupError error={err} />));
    });
} else {
  render();
}
