/** Hides all but the last four characters of a stored secret. */
export function maskSecret(value: string): string {
  return value.length <= 4 ? "••••" : "••••••••" + value.slice(-4);
}
