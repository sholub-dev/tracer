// ── Deterministic NRQL → CSV formatter (token-efficient for LLM) ──

type Row = Record<string, unknown>;

/** Text budget of one result, in characters. */
const MAX_RESULT_CHARS = 30000;
const MAX_CELL_CHARS = 1000;
const MAX_ARRAY_ITEMS = 50;
/** Points of a timeseries shown in full; a longer one is thinned. */
const MAX_SERIES_POINTS = 400;
/** What NRQL returns when a query has no LIMIT clause. */
const DEFAULT_FACET_LIMIT = 10;
const DEFAULT_EVENT_LIMIT = 100;

function fmtNum(v: number): string {
  if (Number.isInteger(v) || !Number.isFinite(v)) return String(v);
  const isInt = (s: string) => /^-?\d+$/.test(s);
  let s = String(Number(v.toPrecision(4)));
  // Rounding must not make a fraction look like a whole number.
  if (isInt(s)) s = String(Number(v.toPrecision(6)));
  if (isInt(s)) s = String(Number(v.toFixed(2)));
  return s;
}

function cap(s: string): string {
  return s.length > MAX_CELL_CHARS ? `${s.slice(0, MAX_CELL_CHARS)}… (+${s.length - MAX_CELL_CHARS} chars)` : s;
}

function fmtArray(a: unknown[], sep: string): string {
  const items = a.slice(0, MAX_ARRAY_ITEMS).map((x) => (x != null && typeof x === "object" ? JSON.stringify(x) : fmtVal(x)));
  return items.join(sep) + (a.length > MAX_ARRAY_ITEMS ? `${sep}… +${a.length - MAX_ARRAY_ITEMS} more` : "");
}

function fmtVal(v: unknown): string {
  if (v === undefined) return "";
  if (v === null) return "null";
  if (typeof v === "number") return fmtNum(v);
  if (Array.isArray(v)) return cap(fmtArray(v, "; "));
  if (typeof v === "object") return cap(JSON.stringify(v));
  return cap(String(v));
}

/** Escape a value for CSV: quote if it contains commas, quotes, or newlines. */
function csvEscape(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

/** Whole rows from the top while the text fits the budget; a note says what was cut. A string entry is a plain line (a section or date heading) and is not a row. */
function csvBlock(headers: string[], tableRows: (string[] | string)[], uncut = false): string {
  const hdr = headers.map(csvEscape).join(",");
  const lines = tableRows.map((r) => (typeof r === "string" ? r : r.map(csvEscape).join(",")));
  const isRow = (i: number) => typeof tableRows[i] !== "string";
  const totalRows = tableRows.filter((r) => typeof r !== "string").length;
  let size = hdr.length;
  let shown = 0;
  let rowsShown = 0;
  while (shown < lines.length && (uncut || rowsShown === 0 || size + lines[shown].length + 1 <= MAX_RESULT_CHARS)) {
    size += lines[shown].length + 1;
    if (isRow(shown)) rowsShown++;
    shown++;
  }
  while (shown > 0 && !isRow(shown - 1)) shown--;
  if (!uncut && rowsShown === 1 && size > MAX_RESULT_CHARS) {
    const head = lines.slice(0, shown - 1).map((l) => `${l}\n`).join("");
    return `${hdr}\n${head}${lines[shown - 1].slice(0, Math.max(0, MAX_RESULT_CHARS - hdr.length - head.length - 1))}\n(Row cut at ${MAX_RESULT_CHARS} characters; select fewer columns.)`;
  }
  const note = rowsShown < totalRows
    ? `\n(Showing ${rowsShown} of ${totalRows} rows: the rest do not fit the ${MAX_RESULT_CHARS}-character result cap. To see them, narrow the WHERE clause, the window or the LIMIT, or aggregate.)`
    : "";
  return `${hdr}\n${lines.slice(0, shown).join("\n")}${note}`;
}

/** The query without single-quoted strings, so clause words inside text do not match. */
export function stripStrings(query: string | undefined): string | undefined {
  return query?.replace(/'(?:[^'\\]|\\.|'')*'/g, "''");
}

function unionKeys(rows: Row[]): string[] {
  const keys = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) keys.add(k);
  return [...keys];
}

/** Whether the synthetic `facet` / `comparison` keys are NRQL's own, not an attribute of that name. */
function isSynthetic(rows: Row[], key: "facet" | "comparison", query: string | undefined): boolean {
  if (!rows.some((r) => key in r)) return false;
  const q = stripStrings(query);
  if (q === undefined) return true;
  // After FROM: the select list can hold an attribute of that name.
  return new RegExp(`\\bFROM\\b[\\s\\S]*\\b${key === "facet" ? "FACET" : "COMPARE\\s+WITH"}\\b`, "i").test(q);
}

/** Find keys that duplicate facet values (same dedup logic as ResultView.buildColumns). A key counts only when it matches in every row, so a metric equal to the facet in one row stays. */
function facetDupeKeys(rows: Row[], hidden: Set<string>): Set<string> {
  const dupes = new Set<string>();
  for (const k of unionKeys(rows)) {
    if (k === "facet" || hidden.has(k)) continue;
    const matches = rows.every((r) => (Array.isArray(r.facet) ? r.facet.includes(r[k]) : r[k] === r.facet));
    if (matches) dupes.add(k);
  }
  return dupes;
}

interface Shape {
  faceted: boolean;
  compared: boolean;
  timeseries: boolean;
}

function shapeOf(rows: Row[], query: string | undefined): Shape {
  return {
    faceted: isSynthetic(rows, "facet", query),
    compared: isSynthetic(rows, "comparison", query),
    timeseries: rows.some((r) => "beginTimeSeconds" in r),
  };
}

function hiddenKeys(s: Shape): Set<string> {
  return new Set(["inspectedCount", ...(s.timeseries ? ["beginTimeSeconds", "endTimeSeconds"] : [])]);
}

function visibleKeys(rows: Row[], s: Shape): string[] {
  const hidden = hiddenKeys(s);
  const dupes = s.faceted ? facetDupeKeys(rows, hidden) : new Set<string>();
  return unionKeys(rows).filter((k) => !(s.faceted && k === "facet") && !(s.compared && k === "comparison") && !hidden.has(k) && !dupes.has(k));
}

/** Attribute names of the FACET clause, split at top-level commas. */
export function parseFacetNames(query: string | undefined): string[] {
  const q = stripStrings(query);
  const m = q && /\bFACET\s+/i.exec(q);
  if (!m) return [];
  const rest = q.slice(m.index + m[0].length);
  // A clause ends the list only outside parentheses: FACET cases(WHERE ...) holds WHERE inside.
  const end = [...rest.matchAll(/\b(?:WHERE|SINCE|UNTIL|LIMIT|TIMESERIES|COMPARE|ORDER|WITH|OFFSET|SLIDE|EXTRAPOLATE)\b/gi)]
    .find((k) => rest.slice(0, k.index).split("(").length === rest.slice(0, k.index).split(")").length)?.index ?? rest.length;
  const items: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of rest.slice(0, end)) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      items.push(cur);
      cur = "";
    } else cur += c;
  }
  items.push(cur);
  return items.map((x) => x.trim().replace(/^[\s\S]*\bAS\s+/i, "").replace(/^[`']|[`']$/g, "")).filter(Boolean);
}

function facetLabel(rows: Row[], s: Shape, query: string | undefined): string {
  const names = parseFacetNames(query);
  if (names.length > 1 && rows.some((r) => Array.isArray(r.facet) && r.facet.length === names.length)) return names.join(" / ");
  return [...facetDupeKeys(rows, hiddenKeys(s))][0] ?? (names.length === 1 ? names[0] : "Name");
}

function facetValue(row: Row): string {
  const one = (v: unknown) => (v == null ? "(none)" : fmtVal(v));
  return Array.isArray(row.facet) ? row.facet.map(one).join(" / ") : one(row.facet);
}

// Object columns (apdex) hold their numbers as members.
function numbers(v: unknown, path: string): [string, number][] {
  if (typeof v === "number") return Number.isFinite(v) ? [[path, v]] : [];
  if (v == null || typeof v !== "object" || Array.isArray(v)) return [];
  return Object.entries(v).flatMap(([k, x]) => numbers(x, `${path}.${k}`));
}

/** Keep about `target` evenly spaced points, plus the first and last, the max and min of each number and every gap, in time order. */
function downsample(rows: Row[], keys: string[], target: number): { rows: Row[]; step: number } {
  const step = Math.ceil(rows.length / target);
  const keep = new Set<number>([0, rows.length - 1]);
  for (let i = 0; i < rows.length; i += step) keep.add(i);
  const max = new Map<string, { i: number; v: number }>();
  const min = new Map<string, { i: number; v: number }>();
  rows.forEach((r, i) => {
    if (keys.some((k) => r[k] == null)) keep.add(i);
    for (const [path, v] of keys.flatMap((k) => numbers(r[k], k))) {
      if (!max.has(path) || v > max.get(path)!.v) max.set(path, { i, v });
      if (!min.has(path) || v < min.get(path)!.v) min.set(path, { i, v });
    }
  });
  for (const { i } of [...max.values(), ...min.values()]) keep.add(i);
  return { rows: rows.filter((_, i) => keep.has(i)), step };
}

// A result that fills the query's row limit, explicit or default, can be cut short.
function limitNote(rows: number, query: string | undefined, defaultLimit: number): string {
  const q = stripStrings(query);
  if (q === undefined || isUncut(query)) return "";
  const m = /\bLIMIT\s+(\d+|MAX)\b/i.exec(q);
  const limit = !m ? defaultLimit : /^max$/i.test(m[1]) ? null : Number(m[1]);
  return rows === limit ? `\n(The result fills the query's row limit of ${limit}; there can be more. This is not a total.)` : "";
}

/** The change from the previous to the current period, as a difference and a ratio. */
function change(current: unknown, previous: unknown): string {
  if (typeof current === "number" && typeof previous === "number") {
    const diff = current - previous;
    const sign = diff > 0 ? "+" : "";
    return previous === 0 ? `${sign}${fmtVal(diff)}` : `${sign}${fmtVal(diff)} (x${fmtVal(current / previous)})`;
  }
  // Object values (percentile, apdex): only when both periods hold the same members.
  const a = numbers(current, "");
  const b = new Map(numbers(previous, ""));
  if (a.length === 0 || a.length !== b.size || !a.every(([p]) => b.has(p))) return "";
  return a.map(([p, v]) => `${p.slice(1)}: ${change(v, b.get(p))}`).join("; ");
}

/** Period labels in display order; "current" first and "previous" second when both exist. */
function periodsOf(rows: Row[]): string[] {
  const seen = [...new Set(rows.map((r) => String(r.comparison)))];
  return seen.includes("current") && seen.includes("previous") ? ["current", "previous", ...seen.filter((p) => p !== "current" && p !== "previous")] : seen;
}

const BUCKET_START = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d):(\d\d) (\S+?)( \(partial\))?$/;

/**
 * Timeseries rows as one block per series (a heading line instead of a facet column), times shortened to HH:MM[:SS]
 * under a date line, and 3+ identical neighbours merged into one run row. Times stay in full when any one does not parse.
 * Runs are only safe when every bucket is present: after thinning, neighbours are not adjacent buckets.
 */
function seriesTable(rows: Row[], keys: string[], facet: string | undefined, canMerge: boolean): { body: (string[] | string)[]; legend: string } {
  const parsed = rows.map((r) => BUCKET_START.exec(String(r.beginTimeSeconds)));
  const ok = parsed.every((m) => m !== null) && new Set(parsed.map((m) => m![4])).size === 1;
  const seconds = ok ? new Set(parsed.map((m) => m![3])) : new Set<string>();
  const sameSeconds = seconds.size === 1;
  const clock = (m: RegExpExecArray) => (sameSeconds ? m[2] : `${m[2]}:${m[3]}`);
  const sections = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const id = facet ? facetValue(r) : "";
    const idx = sections.get(id);
    if (idx) idx.push(i);
    else sections.set(id, [i]);
  });
  const body: (string[] | string)[] = [];
  let runs = false;
  for (const [id, idx] of sections) {
    if (facet) body.push(`${facet}: ${id}`);
    let date = "";
    for (let a = 0; a < idx.length; ) {
      const i = idx[a];
      const m = parsed[i]!;
      const vals = keys.map((k) => fmtVal(rows[i][k]));
      if (!ok) {
        body.push([rows[i].beginTimeSeconds != null ? String(rows[i].beginTimeSeconds) : "—", ...vals]);
        a++;
        continue;
      }
      if (m[1] !== date) body.push((date = m[1]));
      let z = a + 1;
      while (canMerge && !m[5] && z < idx.length && parsed[idx[z]]![1] === date && !parsed[idx[z]]![5] && keys.every((k, j) => fmtVal(rows[idx[z]][k]) === vals[j])) z++;
      if (z - a >= 3) {
        runs = true;
        body.push([`${clock(m)}-${clock(parsed[idx[z - 1]]!)} (${z - a} buckets)`, ...vals]);
        a = z;
      } else {
        body.push([clock(m) + (m[5] ?? ""), ...vals]);
        a++;
      }
    }
  }
  if (!ok) return { body, legend: "" };
  const parts = [`Bucket starts in ${parsed[0]![4]}${sameSeconds ? `, seconds :${[...seconds][0]}` : ""}`, "a date line starts each day"];
  if (runs) parts.push("a row 'A-B (N buckets)' stands for N buckets in a row with the same values");
  return { body, legend: `\n(${parts.join("; ")}.)` };
}

const isUncut = (query: string | undefined) => {
  const q = stripStrings(query);
  return q !== undefined && (/\bkeyset\s*\(/i.test(q) || /^\s*SHOW\s+EVENT\s+TYPES\b/i.test(q));
};

export function formatNrqlCsv(rows: Row[], query?: string): string {
  if (rows.length === 0) return "No results.";

  const sample = rows[0];
  const shape = shapeOf(rows, query);
  const uncut = isUncut(query);

  // ── Timeseries ──
  if (shape.timeseries) {
    if (shape.compared) {
      // One block per period: mixed rows would not say which period a row belongs to.
      return periodsOf(rows)
        .map((p) => `${p}:\n` + formatNrqlCsv(rows.filter((r) => String(r.comparison) === p).map(({ comparison: _, ...r }) => r), query))
        .join("\n\n");
    }
    const keys = visibleKeys(rows, shape);
    const { faceted } = shape;
    let displayRows = rows;
    let note = "";
    if (rows.length > MAX_SERIES_POINTS) {
      // Each series keeps its own peaks: sampling the mixed rows would hide a spike in one series.
      const series = new Map<string, Row[]>();
      for (const r of rows) {
        const id = faceted ? facetValue(r) : "";
        const list = series.get(id);
        if (list) list.push(r);
        else series.set(id, [r]);
      }
      const target = Math.max(3, Math.floor(MAX_SERIES_POINTS / series.size));
      const sampled = [...series.values()].map((s) => (s.length > target ? downsample(s, keys, target) : { rows: s, step: 1 }));
      displayRows = sampled.flatMap((s) => s.rows);
      const step = Math.max(...sampled.map((s) => s.step));
      if (displayRows.length < rows.length) {
        note = `\n(Showing ${displayRows.length} of ${rows.length} buckets: about 1 in ${step} points${faceted ? " per series" : ""}, plus the first, last, peak and low points and every gap. Query a narrower window to see every bucket.)`;
      }
    }
    if (faceted) note += limitNote(new Set(rows.map(facetValue)).size, query, DEFAULT_FACET_LIMIT);
    const { body, legend } = seriesTable(displayRows, keys, faceted ? facetLabel(rows, shape, query) : undefined, displayRows.length === rows.length);
    return csvBlock(["Bucket start", ...keys], body) + legend + note;
  }

  // ── Histogram ──
  if (rows.length === 1 && Object.keys(sample).some((k) => k.startsWith("histogram."))) {
    const buckets = sample[Object.keys(sample).find((k) => k.startsWith("histogram."))!];
    if (Array.isArray(buckets) && buckets.length > 0) {
      if (buckets.every((b) => typeof b === "number")) return csvBlock(["Bucket index", "Count"], buckets.map((b, i) => [String(i), fmtVal(b)]));
      if (buckets.every((b) => b != null && typeof b === "object")) {
        return csvBlock(["Bucket", "Count"], buckets.map((b: any) => [fmtVal(b.bucketStart ?? b.start), fmtVal(b.count)]));
      }
    }
  }

  // ── Compare-with ──
  if (shape.compared) {
    const keys = visibleKeys(rows, shape);
    const periods = periodsOf(rows);
    const hasChange = periods.length === 2 && periods[0] === "current" && periods[1] === "previous";

    if (shape.faceted) {
      // Compare + Facet → pivot table
      const grouped = new Map<string, Map<string, Row>>();
      for (const r of rows) {
        const fk = facetValue(r);
        if (!grouped.has(fk)) grouped.set(fk, new Map());
        grouped.get(fk)!.set(String(r.comparison), r);
      }
      // A ranking by change needs the change of every row; the model would otherwise subtract each pair itself.
      const changed = hasChange ? keys : [];
      const headers = [
        facetLabel(rows, shape, query),
        ...keys.flatMap((k) => periods.map((p) => (keys.length > 1 ? `${k} (${p})` : p))),
        ...changed.map((k) => (keys.length > 1 ? `${k} (change)` : "change")),
      ];
      const body = [...grouped.entries()].map(([fk, byPeriod]) => [
        fk,
        ...keys.flatMap((k) => periods.map((p) => fmtVal(byPeriod.get(p)?.[k]))),
        ...changed.map((k) => change(byPeriod.get("current")?.[k], byPeriod.get("previous")?.[k])),
      ]);
      return csvBlock(headers, body, uncut) + limitNote(grouped.size, query, DEFAULT_FACET_LIMIT);
    }

    // Scalar comparison (no facet) → inline
    const parts: string[] = [];
    for (const k of keys) {
      const byPeriod = new Map(rows.map((r) => [String(r.comparison), r[k]]));
      for (const p of periods) parts.push(`${k} (${p}): ${fmtVal(byPeriod.get(p))}`);
      const diff = hasChange ? change(byPeriod.get("current"), byPeriod.get("previous")) : "";
      if (diff) parts.push(`${k} (change): ${diff}`);
    }
    return parts.join(", ");
  }

  // ── Uniques (single row, single key, array value) ──
  if (rows.length === 1) {
    const vKeys = visibleKeys(rows, shape);
    if (vKeys.length === 1) {
      const val = sample[vKeys[0]];
      if (Array.isArray(val) && val.every((v) => typeof v !== "object" || v === null)) {
        return `${vKeys[0]}: ${fmtArray(val, ", ")}`;
      }
    }
  }

  // ── Scalar (single row, all numeric, no facet) ──
  if (rows.length === 1 && !shape.faceted) {
    const keys = visibleKeys(rows, shape);
    if (keys.length > 0 && keys.every((k) => typeof sample[k] === "number")) {
      return keys.map((k) => `${k}: ${fmtVal(sample[k])}`).join(", ");
    }
  }

  // ── Faceted table ──
  if (shape.faceted) {
    const keys = visibleKeys(rows, shape);
    const headers = [facetLabel(rows, shape, query), ...keys];
    const body = rows.map((r) => [facetValue(r), ...keys.map((k) => fmtVal(r[k]))]);
    return csvBlock(headers, body, uncut) + limitNote(rows.length, query, DEFAULT_FACET_LIMIT);
  }

  // ── Raw events (fallback) ──
  const keys = visibleKeys(rows, shape);
  const headers = keys.length > 0 ? keys : unionKeys(rows);
  const body = rows.map((r) => headers.map((k) => fmtVal(r[k])));
  return csvBlock(headers, body, uncut) + limitNote(rows.length, query, DEFAULT_EVENT_LIMIT);
}

/** Strip NerdGraph internal metadata from rows before sending to UI. */
export function sanitizeNrqlRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === "inspectedCount") continue;
      out[k] = v;
    }
    return out;
  });
}
