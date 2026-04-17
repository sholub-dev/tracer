import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@tracer-sh/server/router";

export const trpc = createTRPCReact<AppRouter>();
