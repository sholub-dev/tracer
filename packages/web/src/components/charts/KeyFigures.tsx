import { formatValue, isNumericGroup, type Column } from "../../lib/result-utils";

const TILES = "grid grid-cols-2 gap-x-4 gap-y-3 sm:flex sm:flex-wrap sm:gap-x-0 sm:divide-x sm:divide-border";

function Figures({ entries }: { entries: [string, unknown][] }) {
  return (
    <dl className={TILES}>
      {entries.map(([key, value]) =>
        isNumericGroup(value) ? (
          <div key={key} className="col-span-2 flex min-w-0 flex-col gap-1 sm:px-5 sm:first:pl-0 sm:last:pr-0">
            <dt className="text-xs break-words text-muted-foreground">{key}</dt>
            <dd><Figures entries={Object.entries(value)} /></dd>
          </div>
        ) : (
          <div key={key} className="flex min-w-0 flex-col gap-0.5 sm:px-5 sm:first:pl-0 sm:last:pr-0">
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
