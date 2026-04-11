const TIMEZONE = "America/Los_Angeles";

/** Returns a short system-prompt block with the current date/time in PST/PDT. */
export function getCurrentDateBlock(): string {
  const now = new Date();
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(now);
  return `## Current Date & Time\n${formatted}`;
}
