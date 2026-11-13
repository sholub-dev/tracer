import { CONFIG } from "../config.js";

const SELECT_FROM_INCIDENT = /^\s*SELECT\s+[\s\S]+?\s+FROM\s+NrAiIncident\b/i;

export const isIncidentQuery = (query: string): boolean => SELECT_FROM_INCIDENT.test(query);

/** The monitor query listing its incident, policy and condition ids; null when it is not on NrAiIncident. */
export function incidentQuery(query: string): string | null {
  if (!isIncidentQuery(query)) return null;
  return query
    .replace(SELECT_FROM_INCIDENT, "SELECT uniques(incidentId), uniques(policyId), uniques(conditionId) FROM NrAiIncident")
    .replace(/\s+TIMESERIES(\s+(\d+\s+[a-z]+|AUTO|MAX))?(\s+SLIDE\s+BY\s+(\d+\s+[a-z]+|AUTO|MAX))?\b/i, "");
}

export const ingestLagSeconds = (query: string) =>
  isIncidentQuery(query) ? CONFIG.monitorIncidentLagSeconds : CONFIG.monitorIngestLagSeconds;

type Window = { start: number; end: number };

/** A full period ending at `end`, reaching back to the last check but no further than `periods` periods, or the
 * catch-up limit when `catchUp` is set. */
function spanStart(lastCheckedAt: number | null, frequencySeconds: number, end: number, periods: number, catchUp: boolean): number {
  const span = periods * frequencySeconds;
  const reach = catchUp ? Math.max(CONFIG.monitorCatchUpSeconds, span) : span;
  return Math.max(Math.min(lastCheckedAt ?? end - frequencySeconds, end - frequencySeconds), end - reach);
}

/** Windows end on clock boundaries (:00, :05, ...); each runs `lag` after its end so late events are in. */
export function nextWindow(
  lastCheckedAt: number | null,
  frequencySeconds: number,
  now: number,
  lagSeconds: number,
  catchUp = false,
): Window | null {
  const end = Math.floor((now - lagSeconds) / frequencySeconds) * frequencySeconds;
  if (lastCheckedAt !== null && end <= lastCheckedAt) return null;
  // A check at an unaligned time (the app opening) must not shorten the next window: it still spans a full period.
  // After a long sleep the missed time is not summed into one check: the window covers at most two periods.
  // Incident events are not counted, so those monitors cover the whole sleep, up to the catch-up limit.
  return { start: spanStart(lastCheckedAt, frequencySeconds, end, 2, catchUp), end };
}

/** A full-period window ending now (less the lag); null when the monitor was checked just before. */
export function openWindow(
  lastCheckedAt: number | null,
  frequencySeconds: number,
  now: number,
  lagSeconds: number,
  catchUp = false,
): Window | null {
  const end = now - lagSeconds;
  if (lastCheckedAt !== null && lastCheckedAt >= end - CONFIG.monitorOpenSkipSeconds) return null;
  // A shorter window would change what a count condition sees; a crossing already investigated is muted when it fires.
  return { start: spanStart(lastCheckedAt, frequencySeconds, end, 1, catchUp), end };
}
