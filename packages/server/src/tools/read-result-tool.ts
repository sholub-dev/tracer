import { tool, type Tool } from "ai";
import { z } from "zod";
import { toolModelOutput } from "./provider-tool-helpers.js";

/** Returns a tool result that was cut from the context, whole. */
export function readResultTool(originals: Map<string, string>): Tool<{ id: string }, string | { error: string }> {
  return tool({
    description: "Read one tool result that was cut from the context, whole, by the id in its stub.",
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => originals.get(id) ?? { error: "No result with that id." },
    toModelOutput: ({ output }) => toolModelOutput(output),
  });
}
