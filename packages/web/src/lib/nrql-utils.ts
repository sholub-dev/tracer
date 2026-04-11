export const TIME_RANGE_PRESETS = [
  { label: "30 min", since: "30 minutes ago" },
  { label: "1 hour", since: "1 hour ago" },
  { label: "3 hours", since: "3 hours ago" },
  { label: "24 hours", since: "24 hours ago" },
  { label: "7 days", since: "7 days ago" },
  { label: "30 days", since: "30 days ago" },
] as const;

export const DEFAULT_SINCE = "24 hours ago";
export const DEFAULT_UNTIL = "NOW";
