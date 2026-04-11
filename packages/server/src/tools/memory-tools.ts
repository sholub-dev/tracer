/**
 * Shared memory tool definitions used by both the memory agent and memory optimizer.
 * Each returns AI SDK tool objects backed by the same makeMemoryExecute executor.
 */

import { z } from "zod";
import { tool } from "ai";
import type { makeMemoryExecute } from "./memory-executor.js";

type MemoryExecute = ReturnType<typeof makeMemoryExecute>;

interface MemoryToolOptions {
  description?: string;
  onSuccess?: () => void;
}

export function createUpdateMemoryTool(memoryExecute: MemoryExecute, opts?: MemoryToolOptions) {
  return tool({
    description: opts?.description ?? "Update an existing memory note by ID.",
    inputSchema: z.object({
      id: z.number().describe("ID of the memory to update"),
      note: z.string().describe("Updated note text"),
    }),
    execute: async ({ id, note }) => {
      const result = await memoryExecute({ id, operation: "UPDATE", note });
      if (!("error" in result)) opts?.onSuccess?.();
      return result;
    },
  });
}

export function createDeleteMemoryTool(memoryExecute: MemoryExecute, opts?: MemoryToolOptions) {
  return tool({
    description: opts?.description ?? "Delete a memory note by ID.",
    inputSchema: z.object({
      id: z.number().describe("ID of the memory to delete"),
    }),
    execute: async ({ id }) => {
      const result = await memoryExecute({ id, operation: "DELETE" });
      if (!("error" in result)) opts?.onSuccess?.();
      return result;
    },
  });
}
