/** True when every whitespace-separated word of the query appears in the title, ignoring case. */
export function matchesQuery(title: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = title.toLowerCase();
  return words.every((w) => lower.includes(w));
}
