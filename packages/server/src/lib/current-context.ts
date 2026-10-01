import { DEFAULTS, SETTINGS_KEYS } from "../config.js";
import { readAppSetting } from "../db/config-reader.js";
import type { Db } from "../db/client.js";

export function getTimezone(db?: Db): string {
  return (db ? readAppSetting<string>(db, SETTINGS_KEYS.timezone) : null)
    ?? process.env.TRACER_TIMEZONE
    ?? DEFAULTS.timezone;
}

function formatNow(timezone: string, withTime: boolean): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    ...(withTime && { hour: "2-digit", minute: "2-digit", timeZoneName: "short" }),
  }).format(new Date());
}

/** System-prompt block with today's date and the user's timezone rules; no clock time, so the prompt prefix stays cacheable all day. */
export function getCurrentDateBlock(db?: Db): string {
  const timezone = getTimezone(db);
  return `## Current Date
${formatNow(timezone, false)}. The exact current time is given with the user's latest message.

The user's timezone is ${timezone}. Always report times in it, with the zone label (e.g. "14:00 PDT"); convert any UTC ("Z") times first.
- New Relic: queries run WITH TIMEZONE '${timezone}' automatically, so literal times (SINCE '2026-01-15 14:00') and results are in the user's timezone.
- PostHog: filter and show times in the user's timezone with toTimeZone(timestamp, '${timezone}').`;
}

export function getCurrentTimeText(db?: Db): string {
  return `[Current date and time: ${formatNow(getTimezone(db), true)}]`;
}

export function formatLocalTime(seconds: number, timeZone: string): string {
  return new Date(seconds * 1000).toLocaleString("en-US", {
    timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}
