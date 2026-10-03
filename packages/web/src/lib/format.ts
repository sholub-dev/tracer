const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export const formatClock = (unixSec: number) => clock.format(unixSec * 1000);
export const formatShortDate = (unixSec: number) => shortDate.format(unixSec * 1000);
export const formatDateTime = (unixSec: number) => `${formatShortDate(unixSec)}, ${formatClock(unixSec)}`;

export function formatTime(ts: number | null | undefined): string {
  if (!ts) return "never";
  const sameDay = new Date(ts * 1000).toDateString() === new Date().toDateString();
  return sameDay ? formatClock(ts) : formatDateTime(ts);
}
