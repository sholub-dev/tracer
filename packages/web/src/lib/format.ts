const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export const formatClock = (unixSec: number) => clock.format(unixSec * 1000);
export const formatShortDate = (unixSec: number) => shortDate.format(unixSec * 1000);
export const formatDateTime = (unixSec: number) => `${formatShortDate(unixSec)}, ${formatClock(unixSec)}`;

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [["day", 86_400], ["hour", 3_600], ["minute", 60]];

export function formatRelative(unixSec: number): string {
  const diff = unixSec - Date.now() / 1000;
  const [unit, size] = UNITS.find(([, s]) => Math.abs(diff) >= s) ?? ["minute", 60];
  return relative.format(Math.round(diff / size), unit);
}

export function formatTime(ts: number | null | undefined): string {
  if (!ts) return "never";
  const sameDay = new Date(ts * 1000).toDateString() === new Date().toDateString();
  return sameDay ? formatClock(ts) : formatDateTime(ts);
}
