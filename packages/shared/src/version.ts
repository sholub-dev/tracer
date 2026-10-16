export function isNewerVersion(latest: string, current: string): boolean {
  // parseInt tolerates prerelease suffixes ("4-rc.1" → 4); NaN would compare false forever.
  const parse = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}
