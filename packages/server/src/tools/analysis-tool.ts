import { z } from "zod";
import { tool } from "ai";
import { TOOL_NAMES } from "@oko/shared";

/** Marker tool the agent calls to signal the start of its analysis section. */
export const beginAnalysisTool = tool({
  description:
    "Call this tool when you are ready to present your findings. This marks the start of your analysis section. Everything you write after calling this tool will be displayed with distinct analysis styling.",
  inputSchema: z.object({}),
  execute: async () => ({
    status: "Analysis mode active. Follow the analysis rules from your system prompt.",
  }),
});

export const ANALYSIS_TOOL_NAME = TOOL_NAMES.BEGIN_ANALYSIS;
