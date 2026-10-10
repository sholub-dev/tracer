import { useId, useMemo, useState, type ComponentProps } from "react";
import { Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, ReferenceArea, ReferenceDot, ReferenceLine, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegend, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import { formatClock, formatDateTime, formatShortDate } from "../../lib/format";
import { coerceNumeric, expandObjectColumns, mainMemberColumns } from "../../lib/result-utils";

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

const SPIKE_RATIO = 2;
const PEAK_LEAD = 1.5;
const MIN_SPIKE_POINTS = 8;
const MAX_LEGEND_ENTRIES = 5;

function isSpike(value: number | null, median: number): boolean {
  return value != null && median > 0 && value >= SPIKE_RATIO * median;
}

function seriesMedian(values: (number | null)[]): number {
  const v = values.filter((n): n is number => n != null).sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// The highest point and the run of spike points around it, or null. Short series have no stable median.
// The peak must also clear everything outside its run by PEAK_LEAD, so a daily cycle with
// several similar highs does not mark one of them.
function findSpike(values: (number | null)[]): { peak: number; from: number; to: number } | null {
  if (values.filter((v) => v != null).length < MIN_SPIKE_POINTS) return null;
  let peak = -1;
  values.forEach((v, i) => { if (v != null && (peak < 0 || v > values[peak]!)) peak = i; });
  const median = seriesMedian(values);
  if (peak < 0 || !isSpike(values[peak], median)) return null;
  let from = peak;
  let to = peak;
  while (from > 0 && isSpike(values[from - 1], median)) from--;
  while (to < values.length - 1 && isSpike(values[to + 1], median)) to++;
  const rest = values.filter((v, i): v is number => v != null && (i < from || i > to));
  return rest.every((v) => values[peak]! >= PEAK_LEAD * v) ? { peak, from, to } : null;
}

// Dotted class names such as org.foo.UserServiceException read as their last segment. Only a capitalized
// last segment counts, so metric keys (average.duration, max.duration), hosts and IPs keep their full name.
function shortName(name: string): string {
  return /^([A-Za-z_$][\w$]*\.)+[A-Z][\w$]*$/.test(name) ? name.slice(name.lastIndexOf(".") + 1) : name;
}

// `flip` puts the pill left of the line, so a spike near the right edge does not clip it.
function SpikePill({ viewBox, text, flip = false }: { viewBox?: { x?: number; y?: number }; text: string; flip?: boolean }) {
  const w = text.length * 6.6 + 18;
  const x = flip ? (viewBox?.x ?? 0) - 8 - w : (viewBox?.x ?? 0) + 8;
  const y = viewBox?.y ?? 0;
  return (
    <g>
      <rect x={x} y={y} width={w} height={20} rx={10} fill="var(--destructive-tint)" />
      <text x={x + w / 2} y={y + 14} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--destructive)">{text}</text>
    </g>
  );
}

function useSeriesVisibility(series: Series[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (name: string) =>
    setSelected((prev) => { const next = new Set(prev); if (next.has(name)) next.delete(name); else next.add(name); return next; });
  const isVisible = (name: string) => selected.size === 0 || selected.has(name);
  return { toggle, isVisible };
}

function formatTick(unix: number, span: number): string {
  return span <= DAY ? formatClock(unix) : formatShortDate(unix);
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
  // Below 1, three significant digits keep small ticks apart: 0.0075 and 0.015 both read "0.01" at two decimals.
  // From 1 up, two decimals keep 100.5 and 101 apart, which three significant digits would not.
  return String(Number(Math.abs(n) < 1 ? n.toPrecision(3) : n.toFixed(2)));
}

// Union over all rows: a null first bucket must not hide the members a later row expands into.
export function getMetricKeys(rows: Record<string, unknown>[]): string[] {
  const keys = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row)) if (!SKIP_KEYS.has(k) && !isFacetDupe(row, k)) keys.add(k);
  // An all-null raw key is the unexpanded form of an object whose members appear under "<key>." in other rows.
  return [...keys].filter((k) => !([...keys].some((o) => o.startsWith(`${k}.`)) && rows.every((r) => r[k] == null)));
}

function isFacetDupe(row: Record<string, unknown>, key: string): boolean {
  const facet = row.facet;
  if (facet === undefined) return false;
  if (Array.isArray(facet)) return facet.includes(row[key]);
  return row[key] === facet;
}

// Integer-only series are counts: whole-number ticks, and gaps for empty buckets.
function isCountSeries(s: Series): boolean {
  return s.data.every((p) => p.y == null || Number.isInteger(p.y));
}

// Distinct metrics 10x smaller than the largest get a right axis, so a 0-1 rate isn't flat next to request counts.
function rightAxisFlags(series: Series[]): boolean[] {
  const peaks = series.map((s) => Math.max(0, ...s.data.map((p) => Math.abs(p.y ?? 0))));
  const top = Math.max(0, ...peaks);
  return peaks.map((p) => p > 0 && p * 10 < top);
}

function SeriesLegend({ series, isVisible, onToggle, onRight }: { series: Series[]; isVisible: (name: string) => boolean; onToggle: (name: string) => void; onRight?: boolean[] }) {
  return (
    <div className="chart-legend flex flex-wrap justify-center gap-x-4 gap-y-1.5 pt-3">
      {series.slice(0, MAX_LEGEND_ENTRIES).map((s, i) => {
        const on = isVisible(s.name);
        return (
          <button
            key={s.name}
            type="button"
            title={s.name}
            aria-pressed={on}
            onClick={() => onToggle(s.name)}
            className={cn(
              "flex min-w-0 max-w-full items-center gap-1.5 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
              !on && "line-through opacity-40",
            )}
          >
            <span
              className={cn("h-2 w-2 shrink-0 rounded-[2px]", s.dashed && "border border-dashed bg-transparent")}
              style={s.dashed ? { borderColor: seriesColor(i) } : { backgroundColor: seriesColor(i) }}
            />
            <span className="truncate">{shortName(s.name)}</span>
            {onRight?.[i] && <span className="shrink-0 whitespace-nowrap text-muted-foreground/70">(right axis)</span>}
          </button>
        );
      })}
      {series.length > MAX_LEGEND_ENTRIES && <span className="shrink-0 text-xs text-muted-foreground">+{series.length - MAX_LEGEND_ENTRIES} more</span>}
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
      className={cn("aspect-auto w-full font-sans [&_.recharts-cartesian-axis-tick_text]:tabular-nums [&_[tabindex='-1']]:outline-hidden", !containerSize && "my-2")}
      style={{ height }}
      // A finger that drags across the chart is scrolling the page; a tap still opens the tooltip.
      onTouchMoveCapture={(e) => e.stopPropagation()}
    >
      {children}
    </ChartContainer>
  );
}

function TimeseriesPlot({ series, containerSize, plotHeight, threshold, dualAxis }: {
  series: Series[];
  containerSize?: ContainerSize;
  plotHeight: number;
  threshold?: Threshold;
  dualAxis: boolean;
}) {
  const { toggle, isVisible } = useSeriesVisibility(series);
  const gradientId = useId();
  const keys = useMemo(() => series.map((_, i) => `s${i}`), [series]);
  const counts = useMemo(() => series.map(isCountSeries), [series]);
  const onRight = useMemo(() => rightAxisFlags(series).map((r) => dualAxis && r), [series, dualAxis]);
  const hasRight = onRight.some(Boolean);

  const { data, xs } = useMemo(() => {
    const lookup = series.map((s) => new Map(s.data.map((p) => [p.x, p.y])));
    const xSet = new Set<number>();
    for (const s of series) s.data.forEach((p) => xSet.add(p.x));
    const xs = [...xSet].sort((a, b) => a - b);
    const rows = xs.map((x) => {
      const row: Record<string, number | null> = { x };
      lookup.forEach((m, i) => { row[`s${i}`] = m.get(x) ?? null; });
      return row;
    });
    return { data: rows, xs };
  }, [series]);

  const config: ChartConfig = Object.fromEntries(series.map((s, i) => [keys[i], { label: onRight[i] ? `${s.name} (right axis)` : s.name, color: seriesColor(i) }]));
  const min = xs[0] ?? 0;
  const max = xs[xs.length - 1] ?? 0;
  const span = max - min;
  const ticks = useMemo(() => timeTicks(min, max), [min, max]);

  const values = series.filter((s) => isVisible(s.name)).flatMap((s) => s.data.map((p) => p.y)).filter((v): v is number => v != null);
  const yMin = Math.min(0, ...values);
  const yMax = Math.max(0, ...values);
  // Recharts pads integer axes to 5 ticks, so a max of 1 would read 0-4.
  const integers = counts.every(Boolean);
  const above = threshold && (threshold.operator === ">" || threshold.operator === ">=");
  // Shading is noise when the safe side is empty, e.g. `count > 0` on a zero-based axis.
  const shade = threshold && (above ? threshold.value > yMin : threshold.value < yMax);

  // A lone `count` series is a per-bucket total, so it draws as bars; averages and other metrics stay lines.
  const single = series.length === 1 ? series[0] : undefined;
  const asBars = !!single && single.name === "count" && counts[0] && !threshold;
  const run = single ? findSpike(data.map((row) => row.s0)) : null;
  const spike = run ? (data[run.peak] as { x: number; s0: number }) : undefined;
  const fillOpacity = single ? 0.15 : 0.06;

  return (
    <ChartFrame config={config} containerSize={containerSize} plotHeight={plotHeight} label={`Chart of ${series.map((s) => s.name).join(", ")}`}>
      <ComposedChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
        <defs>
          {keys.map((k) => (
            <linearGradient key={k} id={`${gradientId}${k}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={`var(--color-${k})`} stopOpacity={fillOpacity} />
              <stop offset="1" stopColor={`var(--color-${k})`} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid vertical={false} stroke="var(--border)" />
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
        <YAxis
          width="auto"
          tickFormatter={formatYAxis}
          allowDecimals={!integers}
          tickCount={integers ? Math.min(5, Math.max(2, Math.ceil(yMax - yMin) + 1)) : undefined}
          tickLine={false}
          axisLine={false}
        />
        {hasRight && (
          <YAxis yAxisId="right" orientation="right" width="auto" tickFormatter={formatYAxis} tickLine={false} axisLine={false} />
        )}
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
              labelFormatter={(_, payload) => formatDateTime(Number(payload?.[0]?.payload?.x))}
              formatter={(value, name) => (
                <div className="flex w-full items-center justify-between gap-4">
                  <span className="text-muted-foreground">{config[String(name)]?.label}</span>
                  <span className="font-medium text-foreground tabular-nums">{formatYAxis(value)}</span>
                </div>
              )}
            />
          }
        />
        {!single && <ChartLegend content={<SeriesLegend series={series} isVisible={isVisible} onToggle={toggle} onRight={onRight} />} />}
        {series.map((s, i) => asBars ? (
          <Bar
            key={keys[i]}
            dataKey={keys[i]}
            name={keys[i]}
            hide={!isVisible(s.name)}
            radius={[2, 2, 0, 0]}
            maxBarSize={5}
            fill={spike ? "var(--muted-foreground)" : `var(--color-${keys[i]})`}
            fillOpacity={spike ? 0.35 : 0.7}
            isAnimationActive={false}
          >
            {run && data.map((row, n) => {
              const hot = n >= run.from && n <= run.to;
              return <Cell key={row.x} fill={hot ? "var(--destructive)" : "var(--muted-foreground)"} fillOpacity={hot ? 1 : 0.35} />;
            })}
          </Bar>
        ) : (
          <Area
            key={keys[i]}
            dataKey={keys[i]}
            name={keys[i]}
            yAxisId={onRight[i] ? "right" : undefined}
            hide={!isVisible(s.name)}
            type="monotone"
            stroke={`var(--color-${keys[i]})`}
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray={s.dashed ? "6 4" : undefined}
            fill={`url(#${gradientId}${keys[i]})`}
            connectNulls={!counts[i]}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
            isAnimationActive={false}
          />
        ))}
        {spike && (
          <ReferenceLine x={spike.x} stroke="var(--destructive)" strokeDasharray="4 4" strokeOpacity={0.7} ifOverflow="visible" label={<SpikePill text={`${formatClock(spike.x)} spike`} flip={spike.x - min > span / 2} />} />
        )}
        {spike && !asBars && <ReferenceDot x={spike.x} y={spike.s0} r={5} fill="var(--card)" stroke="var(--destructive)" strokeWidth={2.5} ifOverflow="visible" />}
      </ComposedChart>
    </ChartFrame>
  );
}

export function TimeseriesChart({ rows: raw, containerSize, threshold }: { rows: Record<string, unknown>[]; containerSize?: ContainerSize; threshold?: Threshold }) {
  const monitored = !!threshold;
  const rows = useMemo(() => expandObjectColumns(monitored ? mainMemberColumns(raw) : raw), [raw, monitored]);
  const hasFacet = "facet" in rows[0];
  const hasComparison = "comparison" in rows[0];
  const series = useMemo(
    () => (hasFacet ? facetSeries(rows) : hasComparison ? compareSeries(rows) : simpleSeries(rows)),
    [rows, hasFacet, hasComparison],
  );
  const dualAxis = !hasFacet && !hasComparison && !threshold;
  const plotHeight = hasFacet ? 300 : 280;
  const shared = { plotHeight, threshold: hasComparison ? undefined : threshold };
  return <TimeseriesPlot series={series} containerSize={containerSize} dualAxis={dualAxis} {...shared} />;
}

function simpleSeries(rows: Record<string, unknown>[]): Series[] {
  return getMetricKeys(rows).map((k) => ({
    name: k,
    data: rows.map((r) => ({ x: r.beginTimeSeconds as number, y: coerceNumeric(r[k]) })),
  }));
}

function facetSeries(rows: Record<string, unknown>[]): Series[] {
  const metricKey = getMetricKeys(rows)[0];
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
  const mKey = getMetricKeys(rows)[0];
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
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={12} />
          <YAxis width="auto" tickFormatter={formatYAxis} allowDecimals={false} tickLine={false} axisLine={false} />
          <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" className="[&_.font-mono]:font-sans" />} />
          <Bar dataKey="value" fill="var(--color-value)" radius={[2, 2, 0, 0]} maxBarSize={60} isAnimationActive={false} />
        </BarChart>
      </ChartFrame>
    </figure>
  );
}
