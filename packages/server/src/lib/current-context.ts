import { DEFAULTS, SETTINGS_KEYS } from "../config.js";
import { readAppSetting } from "../db/config-reader.js";
import type { Db } from "../db/client.js";

/** Returns a short system-prompt block with the current date/time. */
export function getCurrentDateBlock(db?: Db): string {
  const timezone = (db ? readAppSetting<string>(db, SETTINGS_KEYS.timezone) : null)
    ?? process.env.TRACER_TIMEZONE
    ?? DEFAULTS.timezone;
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
  return `## Current Date & Time\n${formatted}`;
}
