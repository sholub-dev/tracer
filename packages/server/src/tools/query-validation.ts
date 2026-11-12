/** Check that a query contains the required {{SINCE}} and {{UNTIL}} placeholders. */
export function requireTimeRangePlaceholders(query: string): { error: string } | null {
  if (!query.includes("{{SINCE}}") || !query.includes("{{UNTIL}}")) {
    return {
      error: "Query must contain {{SINCE}} and {{UNTIL}} placeholders. Use SINCE {{SINCE}} UNTIL {{UNTIL}} instead of literal time values.",
    };
  }
  return null;
}
