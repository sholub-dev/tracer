/**
 * Shared condition validation and evaluation for monitors.
 * Uses a safe restricted parser instead of new Function() / eval().
 */

type TokenType =
  | "number" | "string" | "boolean" | "null" | "undefined"
  | "identifier" | "dot" | "lbracket" | "rbracket"
  | "op" | "and" | "or" | "not" | "lparen" | "rparen" | "eof";

interface Token { type: TokenType; value: string }

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) { i++; continue; }

    // String literals
    if (ch === '"' || ch === "'") {
      const q = ch; let s = ""; i++;
      while (i < expr.length && expr[i] !== q) {
        if (expr[i] === "\\") { i++; s += expr[i] ?? ""; }
        else s += expr[i];
        i++;
      }
      i++; // closing quote
      tokens.push({ type: "string", value: s });
      continue;
    }

    // Numbers (including negative)
    if (/[0-9]/.test(ch) || (ch === "-" && /[0-9]/.test(expr[i + 1] ?? ""))) {
      let n = ch; i++;
      while (i < expr.length && /[0-9.]/.test(expr[i])) { n += expr[i]; i++; }
      tokens.push({ type: "number", value: n });
      continue;
    }

    // Three-char operators first
    const three = expr.slice(i, i + 3);
    if (three === "===" || three === "!==") {
      tokens.push({ type: "op", value: three }); i += 3; continue;
    }

    // Two-char operators
    const two = expr.slice(i, i + 2);
    if (two === ">=" || two === "<=" || two === "&&" || two === "||") {
      if (two === "&&") { tokens.push({ type: "and", value: two }); }
      else if (two === "||") { tokens.push({ type: "or", value: two }); }
      else { tokens.push({ type: "op", value: two }); }
      i += 2; continue;
    }

    // Single-char
    if (ch === ">") { tokens.push({ type: "op", value: ">" }); i++; continue; }
    if (ch === "<") { tokens.push({ type: "op", value: "<" }); i++; continue; }
    if (ch === "!") { tokens.push({ type: "not", value: "!" }); i++; continue; }
    if (ch === ".") { tokens.push({ type: "dot", value: "." }); i++; continue; }
    if (ch === "[") { tokens.push({ type: "lbracket", value: "[" }); i++; continue; }
    if (ch === "]") { tokens.push({ type: "rbracket", value: "]" }); i++; continue; }
    if (ch === "(") { tokens.push({ type: "lparen", value: "(" }); i++; continue; }
    if (ch === ")") { tokens.push({ type: "rparen", value: ")" }); i++; continue; }

    // Identifiers and keywords
    if (/[a-zA-Z_$]/.test(ch)) {
      let id = "";
      while (i < expr.length && /[a-zA-Z0-9_$]/.test(expr[i])) { id += expr[i]; i++; }
      if (id === "true" || id === "false") tokens.push({ type: "boolean", value: id });
      else if (id === "null") tokens.push({ type: "null", value: id });
      else if (id === "undefined") tokens.push({ type: "undefined", value: id });
      else tokens.push({ type: "identifier", value: id });
      continue;
    }

    throw new Error(`Unexpected character: ${ch}`);
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token { return this.tokens[this.pos] ?? { type: "eof", value: "" }; }
  private consume(): Token { return this.tokens[this.pos++] ?? { type: "eof", value: "" }; }

  parse(): (result: unknown) => unknown {
    const expr = this.parseOr();
    if (this.peek().type !== "eof") throw new Error(`Unexpected token: ${this.peek().value}`);
    return expr;
  }

  private parseOr(): (result: unknown) => unknown {
    let left = this.parseAnd();
    while (this.peek().type === "or") {
      this.consume();
      const right = this.parseAnd();
      const l = left, r = right;
      left = (result) => l(result) || r(result);
    }
    return left;
  }

  private parseAnd(): (result: unknown) => unknown {
    let left = this.parseNot();
    while (this.peek().type === "and") {
      this.consume();
      const right = this.parseNot();
      const l = left, r = right;
      left = (result) => l(result) && r(result);
    }
    return left;
  }

  private parseNot(): (result: unknown) => unknown {
    if (this.peek().type === "not") {
      this.consume();
      const operand = this.parseNot();
      return (result) => !operand(result);
    }
    return this.parseComparison();
  }

  private parseComparison(): (result: unknown) => unknown {
    const left = this.parsePrimary();
    if (this.peek().type === "op") {
      const op = this.consume().value;
      const right = this.parsePrimary();
      return (result) => {
        const l = left(result);
        const r = right(result);
        switch (op) {
          case ">": return (l as number) > (r as number);
          case ">=": return (l as number) >= (r as number);
          case "<": return (l as number) < (r as number);
          case "<=": return (l as number) <= (r as number);
          case "===": return l === r;
          case "!==": return l !== r;
          default: throw new Error(`Unknown operator: ${op}`);
        }
      };
    }
    return left;
  }

  private parsePrimary(): (result: unknown) => unknown {
    const tok = this.peek();

    if (tok.type === "lparen") {
      this.consume();
      const expr = this.parseOr();
      if (this.peek().type !== "rparen") throw new Error("Expected closing )");
      this.consume();
      return expr;
    }

    if (tok.type === "number") {
      this.consume();
      const n = Number(tok.value);
      return () => n;
    }

    if (tok.type === "string") {
      this.consume();
      const s = tok.value;
      return () => s;
    }

    if (tok.type === "boolean") {
      this.consume();
      const b = tok.value === "true";
      return () => b;
    }

    if (tok.type === "null") { this.consume(); return () => null; }
    if (tok.type === "undefined") { this.consume(); return () => undefined; }

    if (tok.type === "identifier") {
      this.consume();
      // Build a property access chain
      let accessor: (result: unknown) => unknown;
      if (tok.value === "result") {
        accessor = (result) => result;
      } else {
        throw new Error(`Unknown identifier: ${tok.value}. Only 'result' is allowed as a root.`);
      }

      while (this.peek().type === "dot" || this.peek().type === "lbracket") {
        if (this.peek().type === "dot") {
          this.consume();
          const prop = this.consume();
          if (prop.type !== "identifier") throw new Error(`Expected property name after dot`);
          const key = prop.value;
          const prev = accessor;
          accessor = (result) => {
            const obj = prev(result);
            if (obj == null) return undefined;
            return (obj as Record<string, unknown>)[key];
          };
        } else {
          // lbracket
          this.consume();
          const idxTok = this.consume();
          if (idxTok.type !== "number") throw new Error("Array index must be a number");
          const idx = parseInt(idxTok.value, 10);
          if (this.peek().type !== "rbracket") throw new Error("Expected ]");
          this.consume();
          const prev = accessor;
          accessor = (result) => {
            const arr = prev(result);
            if (!Array.isArray(arr)) return undefined;
            return arr[idx];
          };
        }
      }
      return accessor;
    }

    throw new Error(`Unexpected token: ${tok.value || tok.type}`);
  }
}

const compiledCache = new Map<string, (result: unknown) => boolean>();

function compileCondition(condition: string): (result: unknown) => boolean {
  const cached = compiledCache.get(condition);
  if (cached) return cached;
  const tokens = tokenize(condition);
  const parser = new Parser(tokens);
  const fn = parser.parse();
  const compiled = (result: unknown) => Boolean(fn(result));
  compiledCache.set(condition, compiled);
  return compiled;
}

export function validateCondition(
  condition: string,
  testData?: unknown,
): { ok: true } | { error: string } {
  let fn: (result: unknown) => boolean;
  try {
    fn = compileCondition(condition);
  } catch (err) {
    return { error: `Invalid condition expression: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (testData !== undefined) {
    try {
      fn(testData);
    } catch (err) {
      return { error: `Condition runtime error against current data: ${err instanceof Error ? err.message : String(err)}. Check field names.` };
    }
  }
  return { ok: true };
}

export function evaluateCondition(condition: string, result: unknown): boolean | null {
  try {
    const fn = compileCondition(condition);
    return fn(result);
  } catch {
    return null;
  }
}
