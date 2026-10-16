/** After a refetch, takes the server's value for every field the user has not changed since the last sync. */
export function syncEdits<T extends Record<string, unknown>>(edited: T, lastSynced: T | null, next: T): T {
  if (!lastSynced) return { ...next };
  const out = { ...next };
  for (const key of Object.keys(next) as (keyof T)[]) if (edited[key] !== lastSynced[key]) out[key] = edited[key];
  return out;
}
