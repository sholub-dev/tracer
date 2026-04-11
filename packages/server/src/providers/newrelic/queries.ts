export function errorQuery(since: string, until?: string): string {
  const untilClause = until ? `UNTIL ${until}` : "";
  return `SELECT count(*) as count, min(timestamp) as firstSeen, max(timestamp) as lastSeen FROM TransactionError SINCE ${since} ${untilClause} FACET appName, error.class, error.message, name LIMIT 100`.trim();
}

export function transactionQuery(since: string, until?: string): string {
  const untilClause = until ? `UNTIL ${until}` : "";
  return `SELECT average(duration), count(*) as throughput, percentage(count(*), WHERE error IS true) as errorRate FROM Transaction FACET name SINCE ${since} ${untilClause} LIMIT 100`.trim();
}

export function logQuery(since: string, filter?: string, until?: string): string {
  const untilClause = until ? `UNTIL ${until}` : "";
  const whereClause = filter ? `WHERE message LIKE '%${filter}%'` : "";
  return `SELECT timestamp, level, message FROM Log ${whereClause} SINCE ${since} ${untilClause} LIMIT 200`.trim();
}
