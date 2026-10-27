/** Returns the keys not seen before and records them. Keys are positions, so a card that remounts keeps its key. */
export function takeFreshKeys(seen: Set<string>, keys: string[]): string[] {
  const fresh = keys.filter((k) => !seen.has(k));
  fresh.forEach((k) => seen.add(k));
  return fresh;
}
