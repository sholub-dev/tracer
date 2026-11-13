// Caps on what reaches the model: tool results are re-sent on every later step, so the cost compounds.
// The UI still gets the full rows through the query parts.

/** Text budget of one result, in characters. */
export const MAX_RESULT_CHARS = 30_000;
const MAX_CELL_CHARS = 1000;
export const MAX_ARRAY_ITEMS = 50;

export function clipCell(s: string): string {
  return s.length > MAX_CELL_CHARS ? `${s.slice(0, MAX_CELL_CHARS)}… (+${s.length - MAX_CELL_CHARS} chars)` : s;
}

/** Escape a value for CSV: quote if it contains commas, quotes, or newlines. */
function csvEscape(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

/**
 * Whole rows from the top while the text fits the budget. A string entry is a plain line (a section or date heading) and is not a row;
 * a function entry is a row built only when the budget reaches it. `cut` words the note for rows left out.
 */
export function csvBlock(
  headers: string[],
  tableRows: (string[] | string | (() => string[]))[],
  opts: { cut: (shown: number, total: number) => string; uncut?: boolean },
): string {
  const hdr = headers.map(csvEscape).join(",");
  const isRow = (r: (typeof tableRows)[number]) => typeof r !== "string";
  const totalRows = tableRows.filter(isRow).length;
  const lines: string[] = [];
  let size = hdr.length;
  let rowsShown = 0;
  for (const r of tableRows) {
    const cells = typeof r === "function" ? r() : r;
    const line = typeof cells === "string" ? cells : cells.map(csvEscape).join(",");
    if (!opts.uncut && rowsShown > 0 && size + line.length + 1 > MAX_RESULT_CHARS) break;
    lines.push(line);
    size += line.length + 1;
    if (isRow(r)) rowsShown++;
  }
  while (lines.length > 0 && !isRow(tableRows[lines.length - 1])) lines.pop();
  let rowCut = "";
  if (!opts.uncut && rowsShown === 1 && size > MAX_RESULT_CHARS) {
    const head = lines.slice(0, -1).map((l) => `${l}\n`).join("");
    lines[lines.length - 1] = lines[lines.length - 1].slice(0, Math.max(0, MAX_RESULT_CHARS - hdr.length - head.length - 1));
    rowCut = `\n(Row cut at ${MAX_RESULT_CHARS} characters; select fewer columns.)`;
  }
  return `${hdr}\n${lines.join("\n")}${rowCut}${rowsShown < totalRows ? opts.cut(rowsShown, totalRows) : ""}`;
}
