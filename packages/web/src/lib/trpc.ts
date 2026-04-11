import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@oko/server/router";

export const trpc = createTRPCReact<AppRouter>();
