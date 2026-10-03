import { lazy, memo, Suspense, useState, type ComponentProps, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { Markdown } from "../../lib/markdown";
import { hasErrorOutput } from "../../lib/chat-utils";
import type { Threshold } from "./ChartView";
import { HIDDEN_KEYS, formatValue, isPercentileResult, buildColumns, pivotCompareWith, coerceNumeric, type Column } from "../../lib/result-utils";
import { KeyFigures } from "./KeyFigures";

// Lazy so recharts and react-json-view-lite stay out of the chat entry chunk.
const LazyTimeseriesChart = lazy(() => import("./ChartView").then((m) => ({ default: m.TimeseriesChart })));
const LazyHistogramChart = lazy(() => import("./ChartView").then((m) => ({ default: m.HistogramChart })));
const LazyJsonTree = lazy(() => import("../ui/JsonTree").then((m) => ({ default: m.JsonTree })));

type ContainerSize = { width: number; height: number };

// Reserves the chart's rendered height (plot + legend) so loading causes no layout jump.
function ChartFallback({ containerSize, plotHeight }: { containerSize?: ContainerSize; plotHeight: number }) {
  if (containerSize) return <div style={{ height: Math.max(containerSize.height - 8, 80) }} />;
  return <div className="my-2" style={{ height: plotHeight + 36 }} />;
}

function TimeseriesChart(props: ComponentProps<typeof LazyTimeseriesChart>) {
  return (
    <Suspense fallback={<ChartFallback containerSize={props.containerSize} plotHeight={280} />}>
      <LazyTimeseriesChart {...props} />
    </Suspense>
  );
}

function HistogramChart(props: ComponentProps<typeof LazyHistogramChart>) {
  return (
    <Suspense fallback={<ChartFallback containerSize={props.containerSize} plotHeight={240} />}>
      <LazyHistogramChart {...props} />
    </Suspense>
  );
}

export function preloadResultChunks() {
  const load = () => {
    void import("./ChartView");
    void import("../ui/JsonTree");
  };
  if ("requestIdleCallback" in window) window.requestIdleCallback(load);
  else setTimeout(load, 200);
}

export function JsonTree(props: ComponentProps<typeof LazyJsonTree>) {
  return (
    <Suspense fallback={<div className="h-5" />}>
      <LazyJsonTree {...props} />
    </Suspense>
  );
}

function CellText({ value }: { value: string }) {
  return (
    <span className="line-clamp-2 cursor-default" title={value}>
      {value}
    </span>
  );
}

function CellValue({ value, colKey }: { value: unknown; colKey: string }) {
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    if (isPercentileResult(value)) return <CellText value={formatValue(value, colKey)} />;
    return <JsonTree data={value} collapsed />;
  }
  return <CellText value={formatValue(value, colKey)} />;
}

/** Cap rendered rows — a multi-thousand-row result stalls the frame and janks scrolling. */
const ROW_CAP = 100;

function CappedRows<T>({ items, colSpan, render }: { items: readonly T[]; colSpan: number; render: (item: T, i: number) => ReactNode }) {
  // Track which items were expanded, so new data in the same slot re-caps.
  const [expandedFor, setExpandedFor] = useState<readonly T[] | null>(null);
  const showAll = expandedFor === items;
  const visible = showAll ? items : items.slice(0, ROW_CAP);
  return (
    <>
      {visible.map(render)}
      {!showAll && items.length > ROW_CAP && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={colSpan} className="py-1">
            <Button variant="link" size="xs" className="px-0" onClick={() => setExpandedFor(items)}>
              Show all {items.length} rows
            </Button>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

// shadcn's <Table> wraps its own scroll box, which would break the sticky header; the outer box scrolls instead.
function ResultTable({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="my-2 max-h-[440px] overflow-auto rounded-md border border-border bg-card">
      <table className="w-full caption-bottom text-[13px] leading-[18px] tabular-nums">
        <TableHeader className="sticky top-0 z-10 bg-card shadow-[inset_0_-1px_0_var(--border)] [&_tr]:border-b-0">
          <TableRow className="hover:bg-transparent">{head}</TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </table>
    </div>
  );
}

function Th({ children, numeric }: { children: ReactNode; numeric?: boolean }) {
  return <TableHead className={cn("h-8 px-3 text-xs font-medium text-muted-foreground", numeric && "text-right")}>{children}</TableHead>;
}

function Td({ children, numeric }: { children: ReactNode; numeric?: boolean }) {
  return <TableCell className={cn("max-w-[300px] px-3 py-1.5 whitespace-normal text-foreground", numeric && "text-right")}>{children}</TableCell>;
}

const isNumeric = (value: unknown) => coerceNumeric(value) !== null;

function DataTable({ columns, rows }: { columns: Column[]; rows: Record<string, unknown>[] }) {
  const numeric = columns.map((col) => isNumeric(col.get(rows[0])));
  return (
    <ResultTable head={columns.map((col, c) => <Th key={col.key} numeric={numeric[c]}>{col.label}</Th>)}>
      <CappedRows
        items={rows}
        colSpan={columns.length}
        render={(row, i) => (
          <TableRow key={i} className="hover:bg-muted/40">
            {columns.map((col, c) => (
              <Td key={col.key} numeric={numeric[c]}>
                <CellValue value={col.get(row)} colKey={col.key} />
              </Td>
            ))}
          </TableRow>
        )}
      />
    </ResultTable>
  );
}

function ValueList({ label, items }: { label: string; items: readonly unknown[] }) {
  return (
    <ResultTable head={<Th>{label}</Th>}>
      <CappedRows
        items={items}
        colSpan={1}
        render={(item, i) => (
          <TableRow key={i} className="hover:bg-muted/40">
            <Td><CellText value={formatValue(item)} /></Td>
          </TableRow>
        )}
      />
    </ResultTable>
  );
}

export default memo(function ResultView({ data, containerSize, threshold, chartType }: { data: unknown; containerSize?: ContainerSize; threshold?: Threshold; chartType?: string }) {
  // Markdown summary from LLM summarizer
  if (typeof data === "string") {
    return (
      <Markdown text={data} className="my-2 rounded-md border border-border bg-card px-4 py-3 text-sm leading-relaxed text-foreground" />
    );
  }

  // Error response from tool
  if (hasErrorOutput(data)) {
    return (
      <div role="alert" className="my-2 rounded-md border border-destructive/25 bg-destructive-tint px-3 py-2 text-[13px] leading-[18px] text-destructive">
        {String(data.error)}
      </div>
    );
  }

  if (data && typeof data === "object" && !Array.isArray(data)) {
    return <JsonTree data={data} />;
  }

  if (!Array.isArray(data) || data.length === 0) {
    return <p className="text-[13px] leading-[18px] text-muted-foreground">No results returned.</p>;
  }

  if (data.every((v: unknown) => typeof v !== "object" || v === null)) {
    return <ValueList label="Value" items={data} />;
  }

  const rows = data as Record<string, unknown>[];

  // chartType override: when explicitly set, skip auto-detection
  if (chartType && chartType !== "auto") {
    if (chartType === "timeseries") return <TimeseriesChart rows={rows} containerSize={containerSize} threshold={threshold} />;
    if (chartType === "histogram" && rows.length >= 1) return <HistogramChart row={rows[0]} containerSize={containerSize} />;
    if (chartType === "scalar") {
      const columns = buildColumns([rows[0]]);
      return <KeyFigures columns={columns.filter((c) => !c.key.startsWith("facet"))} row={rows[0]} />;
    }
    if (chartType === "table") return <DataTable columns={buildColumns(rows)} rows={rows} />;
  }

  const hasTimeKeys = "beginTimeSeconds" in rows[0];
  const hasHistogram = rows.length === 1 && Object.keys(rows[0]).some((k) => k.startsWith("histogram."));

  if (hasTimeKeys) return <TimeseriesChart rows={rows} containerSize={containerSize} threshold={threshold} />;
  if (hasHistogram) return <HistogramChart row={rows[0]} containerSize={containerSize} />;

  // Single-row, single-key array value (e.g. uniques() result)
  if (rows.length === 1) {
    const visibleKeys = Object.keys(rows[0]).filter((k) => !HIDDEN_KEYS.has(k));
    if (visibleKeys.length === 1) {
      const val = rows[0][visibleKeys[0]];
      if (Array.isArray(val) && val.every((v) => typeof v !== "object" || v === null)) {
        return <ValueList label={visibleKeys[0]} items={val} />;
      }
    }
  }

  // COMPARE WITH pivot view
  if ("comparison" in rows[0]) {
    const { facetLabel, valueKeys, periods, grouped } = pivotCompareWith(rows);

    // Scalar comparison (no facet): one row per metric
    if (!("facet" in rows[0])) {
      const single = [...grouped.values()][0];
      return (
        <ResultTable head={<><Th>Metric</Th>{periods.map((p) => <Th key={p} numeric>{p}</Th>)}</>}>
          {valueKeys.map((k) => (
            <TableRow key={k} className="hover:bg-muted/40">
              <Td><CellText value={k} /></Td>
              {periods.map((p) => (
                <Td key={p} numeric><CellValue value={single?.byPeriod.get(p)?.[k]} colKey={k} /></Td>
              ))}
            </TableRow>
          ))}
        </ResultTable>
      );
    }

    // Faceted comparison: pivot table
    return (
      <ResultTable
        head={
          <>
            <Th>{facetLabel}</Th>
            {valueKeys.map((k) => periods.map((p) => <Th key={`${k}-${p}`} numeric>{valueKeys.length > 1 ? `${k} (${p})` : p}</Th>))}
          </>
        }
      >
        <CappedRows
          items={[...grouped.values()]}
          colSpan={1 + valueKeys.length * periods.length}
          render={(group, i) => (
            <TableRow key={i} className="hover:bg-muted/40">
              <Td><CellValue value={group.label} colKey={facetLabel} /></Td>
              {valueKeys.map((k) =>
                periods.map((p) => (
                  <Td key={`${k}-${p}`} numeric><CellValue value={group.byPeriod.get(p)?.[k]} colKey={k} /></Td>
                )),
              )}
            </TableRow>
          )}
        />
      </ResultTable>
    );
  }

  const columns = buildColumns(rows);
  const metricKeys = columns.filter((c) => !c.key.startsWith("facet"));
  const isScalar =
    rows.length === 1 &&
    !("facet" in rows[0]) &&
    metricKeys.length > 0 &&
    metricKeys.every((c) => isNumeric(c.get(rows[0])));

  if (isScalar) return <KeyFigures columns={metricKeys} row={rows[0]} />;

  return <DataTable columns={columns} rows={rows} />;
});
