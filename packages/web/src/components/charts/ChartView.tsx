import { useState, useMemo, type ReactNode } from "react";
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ReferenceArea,
} from "recharts";
import { theme, colors } from "../../lib/theme";
import { useContainerSize } from "../../lib/hooks";

const SKIP_KEYS = new Set(["beginTimeSeconds", "endTimeSeconds", "inspectedCount", "facet", "comparison"]);

function useSeriesVisibility<T extends { name: string }>(series: T[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (name: string) =>
    setSelected((prev) => { const next = new Set(prev); next.has(name) ? next.delete(name) : next.add(name); return next; });
  const visible = useMemo(() =>
    selected.size === 0 ? series : series.filter((s) => selected.has(s.name)),
  [series, selected]);
  return { selected, toggle, visible };
}

function formatTime(unix: number): string {
  const d = new Date(unix * 1000);
  const M = d.getMonth() + 1;
  const D = d.getDate();
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${M}/${D} ${h}:${m}`;
}

function formatYAxis(value: unknown): string {
  const n = Number(value);
  if (isNaN(n)) return String(value);
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toFixed(2);
}

function getMetricKeys(row: Record<string, unknown>): string[] {
  return Object.keys(row).filter((k) => !SKIP_KEYS.has(k) && !isFacetDupe(row, k));
}

function isFacetDupe(row: Record<string, unknown>, key: string): boolean {
  const facet = row.facet;
  if (facet === undefined) return false;
  if (Array.isArray(facet)) return facet.includes(row[key]);
  return row[key] === facet;
}

export interface Threshold {
  value: number;
  operator: ">" | ">=" | "<" | "<=";
}

const TOOLTIP_CONTENT_STYLE = { background: colors.paper, border: `1px solid ${colors.border}`, borderRadius: 4, fontSize: 11 };
const TOOLTIP_LABEL_STYLE = { color: colors.inkMuted, marginBottom: 2 };
const TOOLTIP_ITEM_STYLE = { color: colors.inkLight };

// ── Recharts chart primitives ──

interface LineChartProps {
  width: number;
  height: number;
  series: { name: string; data: { x: number; y: number }[]; color: string; dashed?: boolean }[];
  formatX: (v: number) => string;
  threshold?: Threshold;
}

function RechartsLineChart({ width, height, series, formatX, threshold }: LineChartProps) {
  const data = useMemo(() => {
    // Pre-index each series for O(1) lookup instead of O(N) Array.find per point
    const lookup = new Map(series.map((s) => [s.name, new Map(s.data.map((p) => [p.x, p.y]))]));
    const xSet = new Set<number>();
    for (const s of series) s.data.forEach((p) => xSet.add(p.x));
    const xs = [...xSet].sort((a, b) => a - b);
    return xs.map((x) => {
      const row: Record<string, unknown> = { x };
      for (const s of series) row[s.name] = lookup.get(s.name)?.get(x) ?? null;
      return row;
    });
  }, [series]);

  const thresholdAbove = threshold && (threshold.operator === ">" || threshold.operator === ">=");
  const thresholdBelow = threshold && (threshold.operator === "<" || threshold.operator === "<=");

  return (
    <LineChart width={width} height={height} data={data} margin={{ top: 10, right: 20, bottom: 30, left: 50 }}>
      <CartesianGrid strokeDasharray="3 3" stroke={colors.border} />
      <XAxis
        dataKey="x"
        tickFormatter={formatX}
        tick={{ fontSize: 10, fill: colors.inkMuted }}
        tickLine={false}
        axisLine={{ stroke: colors.inkFaint }}
      />
      <YAxis
        tickFormatter={formatYAxis}
        tick={{ fontSize: 11, fill: colors.inkMuted }}
        tickLine={false}
        axisLine={false}
        width={48}
      />
      <Tooltip
        contentStyle={TOOLTIP_CONTENT_STYLE}
        labelStyle={TOOLTIP_LABEL_STYLE}
        itemStyle={TOOLTIP_ITEM_STYLE}
        labelFormatter={(label) => formatX(label as number)}
        formatter={(val, name) => [formatYAxis(val as number), name]}
      />
      {threshold && (
        <ReferenceLine y={threshold.value} stroke="#b33a2a" strokeWidth={1.5} strokeDasharray="6 4" />
      )}
      {thresholdAbove && (
        <ReferenceArea y1={threshold!.value} fill="rgba(179, 58, 42, 0.12)" />
      )}
      {thresholdBelow && (
        <ReferenceArea y2={threshold!.value} fill="rgba(179, 58, 42, 0.12)" />
      )}
      {series.map((s) => (
        <Line
          key={s.name}
          type="monotone"
          dataKey={s.name}
          stroke={s.color}
          strokeWidth={2}
          strokeDasharray={s.dashed ? "6 4" : undefined}
          dot={false}
          activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff" }}
          connectNulls
        />
      ))}
    </LineChart>
  );
}

interface BarChartProps {
  width: number;
  height: number;
  data: { label: string; value: number }[];
  color: string;
}

function RechartsBarChart({ width, height, data, color }: BarChartProps) {
  return (
    <BarChart width={width} height={height} data={data} margin={{ top: 10, right: 20, bottom: 30, left: 50 }}>
      <CartesianGrid strokeDasharray="3 3" stroke={colors.border} vertical={false} />
      <XAxis
        dataKey="label"
        tick={{ fontSize: 10, fill: colors.inkMuted }}
        tickLine={false}
        axisLine={{ stroke: colors.inkFaint }}
      />
      <YAxis
        tickFormatter={formatYAxis}
        tick={{ fontSize: 11, fill: colors.inkMuted }}
        tickLine={false}
        axisLine={false}
        width={48}
      />
      <Tooltip
        contentStyle={TOOLTIP_CONTENT_STYLE}
        labelStyle={{ color: colors.inkMuted }}
        formatter={(val) => [formatYAxis(val as number), "count"]}
      />
      <Bar dataKey="value" fill={color} radius={[2, 2, 0, 0]} maxBarSize={60} />
    </BarChart>
  );
}

// ── Legend ──

function ChartLegend({
  items,
  selectedNames,
  onToggle,
}: {
  items: { name: string; color: string; dashed?: boolean }[];
  selectedNames?: Set<string>;
  onToggle?: (name: string) => void;
}) {
  if (items.length <= 1) return null;
  const hasSelection = selectedNames && selectedNames.size > 0;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
      {items.map((item) => {
        const dimmed = hasSelection && !selectedNames.has(item.name);
        return (
          <div
            key={item.name}
            className="flex items-center gap-1.5 text-xs font-sans"
            style={{
              color: colors.inkMuted,
              cursor: onToggle ? "pointer" : undefined,
              opacity: dimmed ? 0.35 : 1,
              textDecoration: dimmed ? "line-through" : undefined,
              userSelect: "none",
            }}
            onClick={onToggle ? () => onToggle(item.name) : undefined}
          >
            <svg width={16} height={2}>
              <line x1={0} y1={1} x2={16} y2={1} stroke={item.color} strokeWidth={2} strokeDasharray={item.dashed ? "4 3" : undefined} />
            </svg>
            {item.name}
          </div>
        );
      })}
    </div>
  );
}

// ── ChartContainer — handles containerSize vs. auto-measure ──

function ChartContainer({ containerSize, defaultHeight, legendHeight = 0, children }: {
  containerSize?: { width: number; height: number };
  defaultHeight: number;
  legendHeight?: number;
  children: (size: { width: number; height: number }) => ReactNode;
}) {
  const { ref, size: { width: measuredWidth } } = useContainerSize();
  if (containerSize) {
    const w = Math.max(containerSize.width - 8, 100);
    const h = Math.max(containerSize.height - legendHeight - 8, 80);
    return <>{children({ width: w, height: h })}</>;
  }
  return (
    <div ref={ref} className={theme.chartContainer}>
      {measuredWidth > 0 && children({ width: measuredWidth - 32, height: defaultHeight })}
    </div>
  );
}

// ── TIMESERIES (simple, faceted, and compare-with) ──

export function TimeseriesChart({ rows, containerSize, threshold }: { rows: Record<string, unknown>[]; containerSize?: { width: number; height: number }; threshold?: Threshold }) {
  const hasFacet = "facet" in rows[0];
  const hasComparison = "comparison" in rows[0];

  if (hasFacet) return <FacetTimeseriesChart rows={rows} containerSize={containerSize} threshold={threshold} />;
  if (hasComparison) return <CompareTimeseriesChart rows={rows} containerSize={containerSize} />;
  return <SimpleTimeseriesChart rows={rows} containerSize={containerSize} threshold={threshold} />;
}

function SimpleTimeseriesChart({ rows, containerSize, threshold }: { rows: Record<string, unknown>[]; containerSize?: { width: number; height: number }; threshold?: Threshold }) {
  const metricKeys = useMemo(() => getMetricKeys(rows[0]), [rows]);

  const series = useMemo(() =>
    metricKeys.map((k, i) => ({
      name: k,
      color: theme.chartColors[i % theme.chartColors.length],
      data: rows.map((r) => ({ x: r.beginTimeSeconds as number, y: (r[k] as number) ?? 0 })),
    })),
  [rows, metricKeys]);

  const { selected, toggle, visible } = useSeriesVisibility(series);
  const legendH = series.length > 1 ? 28 : 0;

  return (
    <ChartContainer containerSize={containerSize} defaultHeight={280} legendHeight={legendH}>
      {({ width, height }) => (
        <div>
          <RechartsLineChart width={width} height={height} series={visible} formatX={formatTime} threshold={threshold} />
          <ChartLegend items={series} selectedNames={selected} onToggle={toggle} />
        </div>
      )}
    </ChartContainer>
  );
}

function FacetTimeseriesChart({ rows, containerSize, threshold }: { rows: Record<string, unknown>[]; containerSize?: { width: number; height: number }; threshold?: Threshold }) {
  const series = useMemo(() => {
    const metricKeys = getMetricKeys(rows[0]);
    const metricKey = metricKeys[0];
    if (!metricKey) return [];

    const labels: string[] = [];
    for (const r of rows) {
      const label = Array.isArray(r.facet) ? (r.facet as string[]).join(", ") : String(r.facet);
      if (!labels.includes(label)) labels.push(label);
    }

    const timeSet = new Set<number>();
    for (const r of rows) timeSet.add(r.beginTimeSeconds as number);
    const times = [...timeSet].sort((a, b) => a - b);

    const lookup = new Map<number, Map<string, number>>();
    for (const r of rows) {
      const t = r.beginTimeSeconds as number;
      const label = Array.isArray(r.facet) ? (r.facet as string[]).join(", ") : String(r.facet);
      if (!lookup.has(t)) lookup.set(t, new Map());
      lookup.get(t)!.set(label, r[metricKey] as number);
    }

    return labels.map((label, i) => ({
      name: label,
      color: theme.chartColors[i % theme.chartColors.length],
      data: times.map((t) => ({ x: t, y: lookup.get(t)?.get(label) ?? 0 })),
    }));
  }, [rows]);

  const { selected, toggle, visible } = useSeriesVisibility(series);
  const legendH = series.length > 1 ? 28 : 0;

  return (
    <ChartContainer containerSize={containerSize} defaultHeight={300} legendHeight={legendH}>
      {({ width, height }) => (
        <div>
          <RechartsLineChart width={width} height={height} series={visible} formatX={formatTime} threshold={threshold} />
          <ChartLegend items={series} selectedNames={selected} onToggle={toggle} />
        </div>
      )}
    </ChartContainer>
  );
}

function CompareTimeseriesChart({ rows, containerSize }: { rows: Record<string, unknown>[]; containerSize?: { width: number; height: number } }) {
  const series = useMemo(() => {
    const mKeys = getMetricKeys(rows[0]);
    const mKey = mKeys[0];
    if (!mKey) return [];

    // Group rows by comparison period
    const periodRows = new Map<string, Record<string, unknown>[]>();
    const periods: string[] = [];
    for (const r of rows) {
      const p = String(r.comparison);
      if (!periods.includes(p)) periods.push(p);
      if (!periodRows.has(p)) periodRows.set(p, []);
      periodRows.get(p)!.push(r);
    }

    // Calculate time offset to align non-current periods onto the current x-axis
    let timeOffset = 0;
    const currentRows = periodRows.get("current");
    if (currentRows && periods.length > 1) {
      let minCurrent = Infinity;
      for (const r of currentRows) minCurrent = Math.min(minCurrent, r.beginTimeSeconds as number);
      // Use the first non-current period to compute the offset
      const otherPeriod = periods.find((p) => p !== "current");
      if (otherPeriod) {
        let minOther = Infinity;
        for (const r of periodRows.get(otherPeriod)!) minOther = Math.min(minOther, r.beginTimeSeconds as number);
        timeOffset = minCurrent - minOther;
      }
    }

    return periods.map((p, i) => ({
      name: `${mKey} (${p})`,
      color: theme.chartColors[i % theme.chartColors.length],
      dashed: p !== "current",
      data: (periodRows.get(p) ?? [])
        .map((r) => ({
          x: (r.beginTimeSeconds as number) + (p !== "current" ? timeOffset : 0),
          y: (r[mKey] as number) ?? 0,
        }))
        .sort((a, b) => a.x - b.x),
    }));
  }, [rows]);

  const { selected, toggle, visible } = useSeriesVisibility(series);
  const legendH = series.length > 1 ? 28 : 0;

  return (
    <ChartContainer containerSize={containerSize} defaultHeight={280} legendHeight={legendH}>
      {({ width, height }) => (
        <div>
          <RechartsLineChart width={width} height={height} series={visible} formatX={formatTime} />
          <ChartLegend items={series} selectedNames={selected} onToggle={toggle} />
        </div>
      )}
    </ChartContainer>
  );
}

// ── HISTOGRAM ──

export function HistogramChart({ row, containerSize }: { row: Record<string, unknown>; containerSize?: { width: number; height: number } }) {
  const histKey = Object.keys(row).find((k) => k.startsWith("histogram."));

  const { data, metricName } = useMemo(() => {
    if (!histKey) return { data: [], metricName: "" };
    const buckets = row[histKey] as Record<string, number>;
    const boundaries = Object.keys(buckets).map(Number).sort((a, b) => a - b);
    return {
      metricName: histKey.replace("histogram.", ""),
      data: boundaries.map((b, i) => {
        const next = boundaries[i + 1];
        return { label: next !== undefined ? `${b}–${next}` : `${b}+`, value: buckets[String(b)] };
      }),
    };
  }, [row, histKey]);

  if (!histKey) return null;

  return (
    <ChartContainer containerSize={containerSize} defaultHeight={260} legendHeight={24}>
      {({ width, height }) => (
        <div>
          <div className="text-xs font-sans mb-1" style={{ color: colors.inkMuted }}>{metricName} distribution</div>
          <RechartsBarChart width={width} height={height} data={data} color="#6b9fd4" />
        </div>
      )}
    </ChartContainer>
  );
}
