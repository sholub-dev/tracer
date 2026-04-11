import { theme } from "../../lib/theme";
import { formatValue, type Column } from "../../lib/result-utils";

export function ScalarCards({ columns, row }: { columns: Column[]; row: Record<string, unknown> }) {
  return (
    <div className="flex flex-wrap gap-3 my-2">
      {columns.map((col) => (
        <div key={col.key} className={`${theme.card} min-w-[120px]`}>
          <div className={theme.cardTitle}>{col.label}</div>
          <div className={theme.cardValue}>{formatValue(col.get(row), col.key)}</div>
        </div>
      ))}
    </div>
  );
}
