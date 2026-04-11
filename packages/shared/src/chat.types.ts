/** Progress part types streamed from sub-agents to the client */
export type ProgressPart =
  | { type: "query"; query: string; results: unknown }
  | { type: "text"; content: string }
  | { type: "tool-call"; toolName: string }
  | { type: "reasoning"; content: string }
  | { type: "summary"; content: string };

/** Tool names as registered on the server */
export const TOOL_NAMES = {
  CREATE_WIDGET: "create_widget",
  UPDATE_WIDGET: "update_widget",
  DELETE_WIDGET: "delete_widget",
  CREATE_MONITOR: "create_monitor",
  UPDATE_MONITOR: "update_monitor",
  DELETE_MONITOR: "delete_monitor",
  TOGGLE_MONITOR: "toggle_monitor",
  BEGIN_ANALYSIS: "begin_analysis",
} as const;

/** AI SDK prefixes tool names with "tool-" on the client */
export const CLIENT_TOOL_NAMES = Object.fromEntries(
  Object.entries(TOOL_NAMES).map(([k, v]) => [k, `tool-${v}`]),
) as { [K in keyof typeof TOOL_NAMES]: `tool-${(typeof TOOL_NAMES)[K]}` };
