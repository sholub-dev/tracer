import { formatValue, isNumericGroup, type Column } from "../../lib/result-utils";

// An even grid: wrapped rows line up with the first one.
const TILES = "grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-6 gap-y-3";

function Figures({ entries }: { entries: [string, unknown][] }) {
  return (
    <dl className={TILES}>
      {entries.map(([key, value]) =>
        isNumericGroup(value) ? (
          <div key={key} className="col-span-full flex min-w-0 flex-col gap-1">
            <dt className="text-xs break-words text-muted-foreground">{key}</dt>
            <dd><Figures entries={Object.entries(value)} /></dd>
          </div>
        ) : (
          <div key={key} className="flex min-w-0 flex-col gap-0.5 border-l border-border pl-3">
            <dt className="text-xs break-words text-muted-foreground">{key}</dt>
            <dd className="text-xl font-semibold tracking-tight break-words text-foreground tabular-nums">{formatValue(value, key)}</dd>
          </div>
        ),
      )}
    </dl>
  );
}

export function KeyFigures({ columns, row }: { columns: Column[]; row: Record<string, unknown> }) {
  return (
    <div className="my-2">
      <Figures entries={columns.map((col) => [col.label, col.get(row)])} />
    </div>
  );
}
