import { DEFAULTS, ENV, SETTINGS_KEYS } from "../config.js";
import { readAppSetting } from "../db/config-reader.js";
import type { Db } from "../db/driver.js";

export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** A stored or env value that Intl rejects would break every chat, so it falls back to the next source. */
export async function getTimezone(db?: Db): Promise<string> {
  const stored = db ? await readAppSetting<string>(db, SETTINGS_KEYS.timezone) : null;
  for (const candidate of [stored, ENV.TRACER_TIMEZONE]) {
    if (candidate && isValidTimezone(candidate)) return candidate;
  }
  return DEFAULTS.timezone;
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
export async function getCurrentDateBlock(db?: Db): Promise<string> {
  const timezone = await getTimezone(db);
  return `## Current Date
${formatNow(timezone, false)}. The exact current time is given with the user's latest message.

The user's timezone is ${timezone}. Always report times in it, with the zone label (e.g. "14:00 PDT"); convert any UTC ("Z") times first.
- New Relic: queries run WITH TIMEZONE '${timezone}' automatically, so literal times (SINCE '2026-01-15 14:00') and results are in the user's timezone.
- PostHog: filter and show times in the user's timezone with toTimeZone(timestamp, '${timezone}').`;
}

export async function getCurrentTimeText(db?: Db): Promise<string> {
  return `[Current date and time: ${formatNow(await getTimezone(db), true)}]`;
}

export function formatLocalTime(seconds: number, timeZone: string): string {
  return new Date(seconds * 1000).toLocaleString("en-US", {
    timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}
