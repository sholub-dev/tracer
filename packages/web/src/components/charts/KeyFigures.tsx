import { formatValue, type Column } from "../../lib/result-utils";

export function KeyFigures({ columns, row }: { columns: Column[]; row: Record<string, unknown> }) {
  return (
    <dl className="my-2 flex flex-wrap gap-y-3 divide-x divide-border">
      {columns.map((col) => (
        <div key={col.key} className="flex min-w-0 flex-col gap-0.5 px-5 first:pl-0 last:pr-0">
          <dt className="text-xs text-muted-foreground">{col.label}</dt>
          <dd className="text-xl font-semibold tracking-tight text-foreground tabular-nums">{formatValue(col.get(row), col.key)}</dd>
        </div>
      ))}
    </dl>
  );
}
