import { DEFAULTS, SETTINGS_KEYS } from "../config.js";
import { readAppSetting } from "../db/config-reader.js";
import type { Db } from "../db/client.js";

export function getTimezone(db?: Db): string {
  return (db ? readAppSetting<string>(db, SETTINGS_KEYS.timezone) : null)
    ?? process.env.TRACER_TIMEZONE
    ?? DEFAULTS.timezone;
}

/** Returns a short system-prompt block with the current date/time and the user's timezone rules. */
export function getCurrentDateBlock(db?: Db): string {
  const timezone = getTimezone(db);
  const now = new Date();
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(now);
  return `## Current Date & Time
${formatted}

The user's timezone is ${timezone}. Always report times in it, with the zone label (e.g. "14:00 PDT"); convert any UTC ("Z") times first.
- New Relic: queries run WITH TIMEZONE '${timezone}' automatically, so literal times (SINCE '2026-01-15 14:00') and results are in the user's timezone.
- PostHog: filter and show times in the user's timezone with toTimeZone(timestamp, '${timezone}').`;
}
