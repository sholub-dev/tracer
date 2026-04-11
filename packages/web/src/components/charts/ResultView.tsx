import { memo } from "react";
import { Streamdown } from "streamdown";
import { theme } from "../../lib/theme";
import { TimeseriesChart, HistogramChart, type Threshold } from "./ChartView";
import { JsonTree } from "../ui/JsonTree";
import { HIDDEN_KEYS, formatValue, isPercentileResult, buildColumns, pivotCompareWith, type Column } from "../../lib/result-utils";
import { ScalarCards } from "./ScalarCards";

function CellText({ value }: { value: string }) {
  return (
    <span className={theme.tableCellText} title={value}>
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

function DataTable({ columns, rows }: { columns: Column[]; rows: Record<string, unknown>[] }) {
  return (
    <div className={`${theme.tableContainer} my-2`}>
      <table className="w-full">
        <thead className="sticky top-0 z-10">
          <tr className={theme.tableHeaderRow}>
            {columns.map((col) => (
              <th key={col.key} className={theme.tableHeaderCell}>{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={theme.tableRow}>
              {columns.map((col) => (
                <td key={col.key} className={theme.tableCell}>
                  <CellValue value={col.get(row)} colKey={col.key} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default memo(function ResultView({ data, containerSize, threshold, chartType }: { data: unknown; containerSize?: { width: number; height: number }; threshold?: Threshold; chartType?: string }) {
  // Markdown summary from LLM summarizer
  if (typeof data === "string") {
    return (
      <div className={theme.analysisBlock}>
        <Streamdown linkSafety={{ enabled: false }}>{data}</Streamdown>
      </div>
    );
  }

  // Error response from tool
  if (data && typeof data === "object" && !Array.isArray(data) && "error" in data) {
    return (
      <div className={theme.resultErrorMessage}>
        {String((data as Record<string, unknown>).error)}
      </div>
    );
  }

  if (data && typeof data === "object" && !Array.isArray(data)) {
    return <JsonTree data={data} />;
  }

  if (!Array.isArray(data) || data.length === 0) {
    return <div className={theme.toolLoading}>No results returned.</div>;
  }

  // Array of primitives (strings, numbers, etc.) — render as simple value list
  if (data.every((v: unknown) => typeof v !== "object" || v === null)) {
    return (
      <div className={`${theme.tableContainer} my-2`}>
        <table className="w-full">
          <thead className="sticky top-0 z-10">
            <tr className={theme.tableHeaderRow}>
              <th className={theme.tableHeaderCell}>Value</th>
            </tr>
          </thead>
          <tbody>
            {data.map((item: unknown, i: number) => (
              <tr key={i} className={theme.tableRow}>
                <td className={theme.tableCell}>
                  <CellText value={formatValue(item)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const rows = data as Record<string, unknown>[];

  // ── chartType override: when explicitly set, skip auto-detection ──
  if (chartType && chartType !== "auto") {
    if (chartType === "timeseries") return <TimeseriesChart rows={rows} containerSize={containerSize} threshold={threshold} />;
    if (chartType === "histogram" && rows.length >= 1) return <HistogramChart row={rows[0]} containerSize={containerSize} />;
    if (chartType === "scalar") {
      const columns = buildColumns([rows[0]]);
      const metricKeys = columns.filter((c) => !c.key.startsWith("facet"));
      return <ScalarCards columns={metricKeys} row={rows[0]} />;
    }
    // "table" → skip all auto-detection, render as table
    if (chartType === "table") {
      const columns = buildColumns(rows);
      return <DataTable columns={columns} rows={rows} />;
    }
  }

  // ── Auto chart detection (before table/card rendering) ──
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
        return (
          <div className={`${theme.tableContainer} my-2`}>
            <table className="w-full">
              <thead className="sticky top-0 z-10">
                <tr className={theme.tableHeaderRow}>
                  <th className={theme.tableHeaderCell}>{visibleKeys[0]}</th>
                </tr>
              </thead>
              <tbody>
                {val.map((item, i) => (
                  <tr key={i} className={theme.tableRow}>
                    <td className={theme.resultListItem}>{String(item)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
    }
  }

  const hasComparison = "comparison" in rows[0];

  // COMPARE WITH pivot view
  if (hasComparison) {
    const { facetLabel, valueKeys, periods, grouped } = pivotCompareWith(rows);
    const hasFacets = "facet" in rows[0];

    // Scalar comparison (no facet) — render as compact comparison table
    if (!hasFacets) {
      const single = [...grouped.values()][0];
      return (
        <div className={`${theme.tableContainer} my-2`}>
          <table className="w-full">
            <thead className="sticky top-0 z-10">
              <tr className={theme.tableHeaderRow}>
                <th className={theme.tableHeaderCell}>Metric</th>
                {periods.map((p) => (
                  <th key={p} className={theme.tableHeaderCell}>{p}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {valueKeys.map((k) => (
                <tr key={k} className={theme.tableRow}>
                  <td className={theme.tableCell}>
                    <CellText value={k} />
                  </td>
                  {periods.map((p) => (
                    <td key={p} className={theme.tableCell}>
                      <CellValue value={single?.byPeriod.get(p)?.[k]} colKey={k} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    // Faceted comparison — pivot table
    return (
      <div className={`${theme.tableContainer} my-2`}>
        <table className="w-full">
          <thead className="sticky top-0 z-10">
            <tr className={theme.tableHeaderRow}>
              <th className={theme.tableHeaderCell}>{facetLabel}</th>
              {valueKeys.map((k) =>
                periods.map((p) => (
                  <th key={`${k}-${p}`} className={theme.tableHeaderCell}>
                    {valueKeys.length > 1 ? `${k} (${p})` : p}
                  </th>
                )),
              )}
            </tr>
          </thead>
          <tbody>
            {[...grouped.values()].map((group, i) => (
              <tr key={i} className={theme.tableRow}>
                <td className={theme.tableCell}>
                  <CellValue value={group.label} colKey={facetLabel} />
                </td>
                {valueKeys.map((k) =>
                  periods.map((p) => (
                    <td key={`${k}-${p}`} className={theme.tableCell}>
                      <CellValue value={group.byPeriod.get(p)?.[k]} colKey={k} />
                    </td>
                  )),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const columns = buildColumns(rows);

  // Scalar: single row, no facet, all values numeric
  const hasFacet = "facet" in rows[0];
  const metricKeys = columns.filter((c) => !c.key.startsWith("facet"));
  const isScalar =
    rows.length === 1 &&
    !hasFacet &&
    metricKeys.length > 0 &&
    metricKeys.every((c) => typeof c.get(rows[0]) === "number");

  if (isScalar) {
    return <ScalarCards columns={metricKeys} row={rows[0]} />;
  }

  // Table
  return <DataTable columns={columns} rows={rows} />;
});
