import { substituteTimeRange } from "@oko/shared";
import type { IProvider } from "@oko/shared";

/** Check that a query contains the required {{SINCE}} and {{UNTIL}} placeholders. */
export function requireTimeRangePlaceholders(query: string): { error: string } | null {
  if (!query.includes("{{SINCE}}") || !query.includes("{{UNTIL}}")) {
    return {
      error: "Query must contain {{SINCE}} and {{UNTIL}} placeholders. Use SINCE {{SINCE}} UNTIL {{UNTIL}} instead of literal time values.",
    };
  }
  return null;
}

/** Substitute placeholders and execute the query for validation. Returns null on success. */
export async function executeValidationQuery(
  query: string,
  provider: IProvider,
  defaultSince: string,
): Promise<{ result: unknown } | { error: string }> {
  const validationQuery = substituteTimeRange(query, defaultSince);
  try {
    const result = await provider.executeRawQuery(validationQuery);
    return { result };
  } catch (err) {
    return {
      error: `Query validation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
