/** Language of a fenced block that shows a query result from the same reply; the block body is the query title. */
export const RESULT_FENCE = "result";

const RESULT_BLOCK = /```result[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;

/** Replaces each result block with a plain reference, for outputs that cannot draw a chart (copy, Slack, API, memory). */
export const resultRefsToText = (text: string): string => text.replace(RESULT_BLOCK, (_, title: string) => `[Chart: ${title.trim()}]`);
