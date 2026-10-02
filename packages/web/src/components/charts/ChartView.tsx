import { useMemo, useState, type ComponentProps } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ReferenceArea, ReferenceLine, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegend, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import { coerceNumeric } from "../../lib/result-utils";

const SKIP_KEYS = new Set(["beginTimeSeconds", "endTimeSeconds", "inspectedCount", "facet", "comparison"]);
// Matches the legend reserve QueryChart adds for growWithLegend.
const LEGEND_RESERVE = 36;
const MINUTE = 60;
const DAY = 86_400;

type ContainerSize = { width: number; height: number };

export interface Threshold {
  value: number;
  operator: ">" | ">=" | "<" | "<=";
}

interface Series {
  name: string;
  data: { x: number; y: number | null }[];
  dashed?: boolean;
}

const seriesColor = (i: number) => `var(--chart-${(i % 5) + 1})`;

function useSeriesVisibility(series: Series[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (name: string) =>
    setSelected((prev) => { const next = new Set(prev); if (next.has(name)) next.delete(name); else next.add(name); return next; });
  const isVisible = (name: string) => selected.size === 0 || selected.has(name);
  return { toggle, isVisible };
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function formatTick(unix: number, span: number): string {
  return span <= DAY ? timeFmt.format(unix * 1000) : dayFmt.format(unix * 1000);
}

function formatFull(unix: number): string {
  return `${dayFmt.format(unix * 1000)}, ${timeFmt.format(unix * 1000)}`;
}

// About six ticks on local clock boundaries: minutes/hours within a day, whole days beyond.
function timeTicks(min: number, max: number): number[] {
  const span = max - min;
  const ticks: number[] = [];
  if (span <= 0) return [min];
  if (span <= DAY) {
    const step = [5, 10, 15, 30, 60, 120, 180, 240, 360].map((m) => m * MINUTE).find((s) => span / s <= 7) ?? 360 * MINUTE;
    const offset = -new Date(min * 1000).getTimezoneOffset() * MINUTE;
    for (let t = Math.ceil((min + offset) / step) * step - offset; t <= max; t += step) ticks.push(t);
    return ticks;
  }
  const days = [1, 2, 7, 14, 30].find((d) => span / (d * DAY) <= 7) ?? 30;
  const d = new Date(min * 1000);
  d.setHours(0, 0, 0, 0);
  if (d.getTime() / 1000 < min) d.setDate(d.getDate() + 1);
  for (; d.getTime() / 1000 <= max; d.setDate(d.getDate() + days)) ticks.push(d.getTime() / 1000);
  return ticks;
}

function formatYAxis(value: unknown): string {
  if (value == null) return "—";
  const n = Number(value);
  if (isNaN(n)) return String(value);
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toFixed(2);
}

// NerdGraph also flattens apdex fields (score, s, t, f, count) next to the apdex object; skip those copies.
function getMetricKeys(row: Record<string, unknown>): string[] {
  const nested = Object.values(row).filter((v): v is Record<string, unknown> => v != null && typeof v === "object" && "score" in v);
  return Object.keys(row).filter((k) => !SKIP_KEYS.has(k) && !isFacetDupe(row, k) && !nested.some((o) => o[k] === row[k]));
}

function isFacetDupe(row: Record<string, unknown>, key: string): boolean {
  const facet = row.facet;
  if (facet === undefined) return false;
  if (Array.isArray(facet)) return facet.includes(row[key]);
  return row[key] === facet;
}

// Integer-only series are counts per bucket, drawn as steps; anything fractional is a continuous measure, drawn smooth.
function isCountSeries(s: Series): boolean {
  return s.data.every((p) => p.y == null || Number.isInteger(p.y));
}

function breaches(value: number, t: Threshold): boolean {
  switch (t.operator) {
    case ">": return value > t.value;
    case ">=": return value >= t.value;
    case "<": return value < t.value;
    case "<=": return value <= t.value;
  }
}

function lastBucketEnd(rows: Record<string, unknown>[]): number | null {
  let end = -Infinity;
  for (const r of rows) if (typeof r.endTimeSeconds === "number") end = Math.max(end, r.endTimeSeconds);
  return Number.isFinite(end) ? Math.min(end, Date.now() / 1000) : null;
}

function SeriesLegend({ series, isVisible, onToggle }: { series: Series[]; isVisible: (name: string) => boolean; onToggle: (name: string) => void }) {
  return (
    <div className="chart-legend flex max-h-16 flex-wrap justify-center gap-x-4 gap-y-1 overflow-y-auto pt-3">
      {series.map((s, i) => {
        const on = isVisible(s.name);
        return (
          <button
            key={s.name}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(s.name)}
            className={cn(
              "flex items-center gap-1.5 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
              !on && "line-through opacity-40",
            )}
          >
            <span
              className={cn("h-2 w-2 shrink-0 rounded-[2px]", s.dashed && "border border-dashed bg-transparent")}
              style={s.dashed ? { borderColor: seriesColor(i) } : { backgroundColor: seriesColor(i) }}
            />
            {s.name}
          </button>
        );
      })}
    </div>
  );
}

function ChartFrame({ config, containerSize, plotHeight, label, children }: {
  config: ChartConfig;
  containerSize?: ContainerSize;
  plotHeight: number;
  label: string;
  children: ComponentProps<typeof ChartContainer>["children"];
}) {
  // The legend reserve is kept without a legend too, so the box matches its loading placeholder.
  const height = containerSize ? Math.max(containerSize.height - 8, 80) : plotHeight + LEGEND_RESERVE;
  return (
    <ChartContainer
      config={config}
      role="img"
      aria-label={label}
      className={cn("aspect-auto w-full font-sans [&_.recharts-cartesian-axis-tick_text]:tabular-nums", !containerSize && "my-2")}
      style={{ height }}
    >
      {children}
    </ChartContainer>
  );
}

function TimeseriesPlot({ series, containerSize, plotHeight, threshold, endAt }: {
  series: Series[];
  containerSize?: ContainerSize;
  plotHeight: number;
  threshold?: Threshold;
  endAt: number | null;
}) {
  const { toggle, isVisible } = useSeriesVisibility(series);
  const keys = useMemo(() => series.map((_, i) => `s${i}`), [series]);
  const counts = useMemo(() => series.map(isCountSeries), [series]);

  const { data, xs } = useMemo(() => {
    const lookup = series.map((s) => new Map(s.data.map((p) => [p.x, p.y])));
    const xSet = new Set<number>();
    for (const s of series) s.data.forEach((p) => xSet.add(p.x));
    const xs = [...xSet].sort((a, b) => a - b);
    const rows: Record<string, number | boolean | null>[] = xs.map((x) => {
      const row: Record<string, number | null> = { x };
      lookup.forEach((m, i) => { row[`s${i}`] = m.get(x) ?? null; });
      return row;
    });
    // Each value covers its whole bucket, so every line runs to the last bucket's end.
    const last = rows[rows.length - 1];
    if (last && endAt != null && endAt > xs[xs.length - 1]) {
      const tail: Record<string, number | boolean | null> = { x: endAt, tail: true };
      keys.forEach((k) => { tail[k] = last[k]; });
      rows.push(tail);
      xs.push(endAt);
    }
    return { data: rows, xs };
  }, [series, keys, endAt]);

  const config: ChartConfig = Object.fromEntries(series.map((s, i) => [keys[i], { label: s.name, color: seriesColor(i) }]));
  const min = xs[0] ?? 0;
  const max = xs[xs.length - 1] ?? 0;
  const span = max - min;
  const ticks = useMemo(() => timeTicks(min, max), [min, max]);

  const values = series.filter((s) => isVisible(s.name)).flatMap((s) => s.data.map((p) => p.y)).filter((v): v is number => v != null);
  const yMin = Math.min(0, ...values);
  const yMax = Math.max(0, ...values);
  const above = threshold && (threshold.operator === ">" || threshold.operator === ">=");
  // Shading is noise when the safe side is empty, e.g. `count > 0` on a zero-based axis.
  const shade = threshold && (above ? threshold.value > yMin : threshold.value < yMax);

  const breachDot = (props: { cx?: number; cy?: number; index?: number; value?: unknown; payload?: { tail?: boolean } }) => {
    const v = Array.isArray(props.value) ? props.value[1] : props.value;
    const hit = threshold && typeof v === "number" && !props.payload?.tail && breaches(v, threshold);
    if (!hit || props.cx == null || props.cy == null) return <g key={props.index} />;
    return <circle key={props.index} cx={props.cx} cy={props.cy} r={3.5} fill="var(--destructive)" stroke="var(--card)" strokeWidth={1.5} />;
  };

  return (
    <ChartFrame config={config} containerSize={containerSize} plotHeight={plotHeight} label={`Chart of ${series.map((s) => s.name).join(", ")}`}>
      <AreaChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} strokeOpacity={0.6} />
        <XAxis
          dataKey="x"
          type="number"
          scale="time"
          domain={["dataMin", "dataMax"]}
          ticks={ticks}
          tickFormatter={(t: number) => formatTick(t, span)}
          interval="preserveStartEnd"
          minTickGap={24}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
        />
        <YAxis width={44} tickFormatter={formatYAxis} allowDecimals={!counts.every(Boolean)} tickCount={4} tickLine={false} axisLine={false} />
        {threshold && shade && (
          // recharts fills a missing y1 to the top edge and a missing y2 to the bottom edge
          above
            ? <ReferenceArea y2={threshold.value} fill="var(--destructive)" fillOpacity={0.05} ifOverflow="hidden" />
            : <ReferenceArea y1={threshold.value} fill="var(--destructive)" fillOpacity={0.05} ifOverflow="hidden" />
        )}
        {threshold && (
          <ReferenceLine y={threshold.value} ifOverflow="extendDomain" stroke="var(--destructive)" strokeDasharray="4 4" strokeOpacity={0.8} />
        )}
        <ChartTooltip
          cursor={{ strokeDasharray: "3 3" }}
          content={
            <ChartTooltipContent
              indicator="line"
              className="[&_.font-mono]:font-sans"
              labelFormatter={(_, payload) => formatFull(Number(payload?.[0]?.payload?.x))}
              formatter={(value, name) => (
                <div className="flex w-full items-center justify-between gap-4">
                  <span className="text-muted-foreground">{config[String(name)]?.label}</span>
                  <span className="font-medium text-foreground tabular-nums">{formatYAxis(value)}</span>
                </div>
              )}
            />
          }
        />
        {series.length > 1 && <ChartLegend content={<SeriesLegend series={series} isVisible={isVisible} onToggle={toggle} />} />}
        {series.map((s, i) => (
          <Area
            key={keys[i]}
            dataKey={keys[i]}
            name={keys[i]}
            hide={!isVisible(s.name)}
            type={counts[i] ? "stepAfter" : "monotone"}
            stroke={`var(--color-${keys[i]})`}
            strokeWidth={1.5}
            strokeDasharray={s.dashed ? "6 4" : undefined}
            fill={`var(--color-${keys[i]})`}
            fillOpacity={series.length === 1 ? 0.06 : 0}
            connectNulls={!counts[i]}
            dot={threshold ? breachDot : false}
            activeDot={{ r: 3.5, strokeWidth: 1.5, stroke: "var(--card)" }}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ChartFrame>
  );
}

export function TimeseriesChart({ rows, containerSize, threshold }: { rows: Record<string, unknown>[]; containerSize?: ContainerSize; threshold?: Threshold }) {
  const hasFacet = "facet" in rows[0];
  const hasComparison = "comparison" in rows[0];
  const series = useMemo(
    () => (hasFacet ? facetSeries(rows) : hasComparison ? compareSeries(rows) : simpleSeries(rows)),
    [rows, hasFacet, hasComparison],
  );
  const endAt = useMemo(() => (hasComparison ? null : lastBucketEnd(rows)), [rows, hasComparison]);
  return (
    <TimeseriesPlot
      series={series}
      containerSize={containerSize}
      plotHeight={hasFacet ? 300 : 280}
      threshold={hasComparison ? undefined : threshold}
      endAt={endAt}
    />
  );
}

function simpleSeries(rows: Record<string, unknown>[]): Series[] {
  return getMetricKeys(rows[0]).map((k) => ({
    name: k,
    data: rows.map((r) => ({ x: r.beginTimeSeconds as number, y: coerceNumeric(r[k]) })),
  }));
}

function facetSeries(rows: Record<string, unknown>[]): Series[] {
  const metricKey = getMetricKeys(rows[0])[0];
  if (!metricKey) return [];
  const facetLabel = (r: Record<string, unknown>) => (Array.isArray(r.facet) ? (r.facet as string[]).join(", ") : String(r.facet));

  const labels: string[] = [];
  const times = new Set<number>();
  const lookup = new Map<number, Map<string, number | null>>();
  for (const r of rows) {
    const label = facetLabel(r);
    const t = r.beginTimeSeconds as number;
    if (!labels.includes(label)) labels.push(label);
    times.add(t);
    if (!lookup.has(t)) lookup.set(t, new Map());
    lookup.get(t)!.set(label, coerceNumeric(r[metricKey]));
  }
  const sorted = [...times].sort((a, b) => a - b);
  return labels.map((label) => ({
    name: label,
    data: sorted.map((t) => ({ x: t, y: lookup.get(t)?.get(label) ?? null })),
  }));
}

function compareSeries(rows: Record<string, unknown>[]): Series[] {
  const mKey = getMetricKeys(rows[0])[0];
  if (!mKey) return [];

  const periodRows = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const p = String(r.comparison);
    if (!periodRows.has(p)) periodRows.set(p, []);
    periodRows.get(p)!.push(r);
  }
  const periods = [...periodRows.keys()];
  const minTime = (rs: Record<string, unknown>[]) => Math.min(...rs.map((r) => r.beginTimeSeconds as number));

  // Shift the earlier period onto the current x-axis.
  let timeOffset = 0;
  const currentRows = periodRows.get("current");
  const otherPeriod = periods.find((p) => p !== "current");
  if (currentRows && otherPeriod) timeOffset = minTime(currentRows) - minTime(periodRows.get(otherPeriod)!);

  return periods.map((p) => ({
    name: `${mKey} (${p})`,
    dashed: p !== "current",
    data: periodRows.get(p)!
      .map((r) => ({ x: (r.beginTimeSeconds as number) + (p !== "current" ? timeOffset : 0), y: coerceNumeric(r[mKey]) }))
      .sort((a, b) => a.x - b.x),
  }));
}

const histogramConfig = { value: { label: "Count", color: "var(--chart-1)" } } satisfies ChartConfig;

export function HistogramChart({ row, containerSize }: { row: Record<string, unknown>; containerSize?: ContainerSize }) {
  const histKey = Object.keys(row).find((k) => k.startsWith("histogram."));

  const data = useMemo(() => {
    if (!histKey) return [];
    const buckets = row[histKey] as Record<string, number>;
    const boundaries = Object.keys(buckets).map(Number).sort((a, b) => a - b);
    return boundaries.map((b, i) => {
      const next = boundaries[i + 1];
      return { label: next !== undefined ? `${b}–${next}` : `${b}+`, value: buckets[String(b)] };
    });
  }, [row, histKey]);

  if (!histKey) return null;
  const metricName = histKey.replace("histogram.", "");

  return (
    <figure className="my-2">
      <figcaption className="text-xs text-muted-foreground">{metricName} distribution</figcaption>
      <ChartFrame
        config={histogramConfig}
        containerSize={containerSize && { ...containerSize, height: containerSize.height - 16 }}
        plotHeight={240}
        label={`${metricName} distribution`}
      >
        <BarChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} strokeOpacity={0.6} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={12} />
          <YAxis width={44} tickFormatter={formatYAxis} allowDecimals={false} tickCount={4} tickLine={false} axisLine={false} />
          <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" className="[&_.font-mono]:font-sans" />} />
          <Bar dataKey="value" fill="var(--color-value)" radius={[2, 2, 0, 0]} maxBarSize={60} isAnimationActive={false} />
        </BarChart>
      </ChartFrame>
    </figure>
  );
}
