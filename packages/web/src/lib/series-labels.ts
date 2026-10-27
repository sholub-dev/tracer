/**
 * Series keys from compound functions share a dotted prefix (`apdex.x.score`, `apdex.x.t`).
 * The prefix moves out of the labels; only whole segments count and every label keeps at least one.
 * Display only: the data keys stay as they are.
 */
export function splitSeriesLabels(names: string[]): { prefix: string; labels: string[] } {
  const unchanged = { prefix: "", labels: names };
  if (names.length < 2) return unchanged;
  const parts = names.map((n) => n.split("."));
  const max = Math.min(...parts.map((p) => p.length)) - 1;
  let n = 0;
  while (n < max && parts.every((p) => p[n] === parts[0][n])) n++;
  if (n === 0) return unchanged;
  const labels = parts.map((p) => p.slice(n).join("."));
  return new Set(labels).size === labels.length ? { prefix: parts[0].slice(0, n).join("."), labels } : unchanged;
}
