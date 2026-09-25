// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Calculations in flow variable values: `{{= vars.max_tokens / 2 }}`.
 *
 * A small, closed expression language — hand-written tokenizer and Pratt
 * parser, no `eval`/`Function`, no property access beyond the three reference
 * roots, no loops. Evaluated once per effective variable set (flow load /
 * request with overrides), never per token.
 *
 * Grammar (loosest binding first):
 *   cond ? a : b
 *   ||   &&
 *   ==  !=  <  <=  >  >=
 *   +  -          (`+` concatenates when either side is a string)
 *   *  /  %
 *   -x  !x
 *   literal | reference | fn(args…) | ( expr )
 *
 * Literals: numbers, 'single' or "double" quoted strings, true, false, null.
 * References: `vars.<name>[.<field>…]`, `const.<name>[.<field>…]`,
 * `env.<FLOW_PUBLIC_NAME>` — resolved through the caller's `lookup`.
 * Functions: min, max, round(x[, digits]), floor, ceil, abs, number, string,
 * upper, lower, trim, length, concat, coalesce.
 */

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpressionError";
  }
}

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "id"; v: string }
  | { t: "op"; v: string };

const OPERATORS = ["===", "!==", "==", "!=", "<=", ">=", "&&", "||", "<", ">", "+", "-", "*", "/", "%", "!", "?", ":", "(", ")", ","];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      const text = m?.[0] ?? c;
      out.push({ t: "num", v: Number(text) });
      i += text.length;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const n = src[j + 1] as string;
          s += n === "n" ? "\n" : n === "t" ? "\t" : n;
          j += 2;
        } else {
          s += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new ExpressionError("Unterminated string literal.");
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      // No "-" in names here: `vars.a-1` is a subtraction.
      const m = /^[A-Za-z_]\w*(?:\.\w+)*/.exec(src.slice(i));
      const text = m?.[0] ?? c;
      out.push({ t: "id", v: text });
      i += text.length;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op === undefined) throw new ExpressionError(`Unexpected character "${c}".`);
    out.push({ t: "op", v: op === "===" ? "==" : op === "!==" ? "!=" : op });
    i += op.length;
  }
  return out;
}

type Node =
  | { k: "lit"; v: unknown }
  | { k: "ref"; path: string }
  | { k: "call"; name: string; args: Node[] }
  | { k: "un"; op: string; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "cond"; c: Node; a: Node; b: Node };

const BINARY_POWER: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

function parse(tokens: Token[]): Node {
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const isOp = (v: string): boolean => {
    const t = peek();
    return t?.t === "op" && t.v === v;
  };
  const expectOp = (v: string): void => {
    if (!isOp(v)) throw new ExpressionError(`Expected "${v}".`);
    pos++;
  };

  const primary = (): Node => {
    const t = peek();
    if (t === undefined) throw new ExpressionError("Unexpected end of expression.");
    pos++;
    if (t.t === "num" || t.t === "str") return { k: "lit", v: t.v };
    if (t.t === "id") {
      if (t.v === "true") return { k: "lit", v: true };
      if (t.v === "false") return { k: "lit", v: false };
      if (t.v === "null") return { k: "lit", v: null };
      if (isOp("(")) {
        pos++;
        const args: Node[] = [];
        if (!isOp(")")) {
          args.push(expr(0));
          while (isOp(",")) {
            pos++;
            args.push(expr(0));
          }
        }
        expectOp(")");
        return { k: "call", name: t.v, args };
      }
      return { k: "ref", path: t.v };
    }
    if (t.v === "(") {
      const inner = expr(0);
      expectOp(")");
      return inner;
    }
    if (t.v === "-" || t.v === "!") return { k: "un", op: t.v, a: primary() };
    throw new ExpressionError(`Unexpected "${t.v}".`);
  };

  const expr = (minPower: number): Node => {
    let left = primary();
    for (;;) {
      const t = peek();
      if (t?.t !== "op") break;
      if (t.v === "?" && minPower === 0) {
        pos++;
        const a = expr(0);
        expectOp(":");
        const b = expr(0);
        left = { k: "cond", c: left, a, b };
        continue;
      }
      const power = BINARY_POWER[t.v];
      if (power === undefined || power <= minPower) break;
      pos++;
      left = { k: "bin", op: t.v, a: left, b: expr(power) };
    }
    return left;
  };

  const root = expr(0);
  if (pos < tokens.length) {
    const t = tokens[pos] as Token;
    throw new ExpressionError(`Unexpected "${String(t.v)}".`);
  }
  return root;
}

function toNumber(v: unknown, what: string): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) throw new ExpressionError(`${what} is not a number (${JSON.stringify(v)}).`);
  return n;
}

function toText(v: unknown): string {
  return typeof v === "string" ? v : v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
}

const FUNCTIONS: Record<string, (args: unknown[]) => unknown> = {
  min: (a) => Math.min(...a.map((x, i) => toNumber(x, `min() argument ${i + 1}`))),
  max: (a) => Math.max(...a.map((x, i) => toNumber(x, `max() argument ${i + 1}`))),
  round: ([x, d]) => {
    const f = 10 ** (d === undefined ? 0 : toNumber(d, "round() digits"));
    return Math.round(toNumber(x, "round() value") * f) / f;
  },
  floor: ([x]) => Math.floor(toNumber(x, "floor() value")),
  ceil: ([x]) => Math.ceil(toNumber(x, "ceil() value")),
  abs: ([x]) => Math.abs(toNumber(x, "abs() value")),
  number: ([x]) => toNumber(x, "number() value"),
  string: ([x]) => toText(x),
  upper: ([x]) => toText(x).toUpperCase(),
  lower: ([x]) => toText(x).toLowerCase(),
  trim: ([x]) => toText(x).trim(),
  length: ([x]) => (Array.isArray(x) ? x.length : toText(x).length),
  concat: (a) => a.map(toText).join(""),
  coalesce: (a) => a.find((x) => x !== null && x !== undefined && x !== ""),
};

export const EXPRESSION_FUNCTIONS = Object.keys(FUNCTIONS);

function evaluate(node: Node, lookup: (path: string) => unknown): unknown {
  switch (node.k) {
    case "lit":
      return node.v;
    case "ref":
      return lookup(node.path);
    case "call": {
      const fn = FUNCTIONS[node.name];
      if (fn === undefined) {
        throw new ExpressionError(`Unknown function "${node.name}" (available: ${EXPRESSION_FUNCTIONS.join(", ")}).`);
      }
      return fn(node.args.map((a) => evaluate(a, lookup)));
    }
    case "un": {
      const v = evaluate(node.a, lookup);
      return node.op === "-" ? -toNumber(v, "Operand of -") : !v;
    }
    case "cond":
      return evaluate(node.c, lookup) ? evaluate(node.a, lookup) : evaluate(node.b, lookup);
    case "bin": {
      if (node.op === "&&") return evaluate(node.a, lookup) && evaluate(node.b, lookup);
      if (node.op === "||") return evaluate(node.a, lookup) || evaluate(node.b, lookup);
      const a = evaluate(node.a, lookup);
      const b = evaluate(node.b, lookup);
      switch (node.op) {
        case "==":
          return a === b || (typeof a !== typeof b && toText(a) === toText(b));
        case "!=":
          return !(a === b || (typeof a !== typeof b && toText(a) === toText(b)));
        case "<":
          return toNumber(a, "Left side of <") < toNumber(b, "Right side of <");
        case "<=":
          return toNumber(a, "Left side of <=") <= toNumber(b, "Right side of <=");
        case ">":
          return toNumber(a, "Left side of >") > toNumber(b, "Right side of >");
        case ">=":
          return toNumber(a, "Left side of >=") >= toNumber(b, "Right side of >=");
        case "+":
          return typeof a === "string" || typeof b === "string"
            ? toText(a) + toText(b)
            : toNumber(a, "Left side of +") + toNumber(b, "Right side of +");
        case "-":
          return toNumber(a, "Left side of -") - toNumber(b, "Right side of -");
        case "*":
          return toNumber(a, "Left side of *") * toNumber(b, "Right side of *");
        case "/": {
          const d = toNumber(b, "Divisor");
          if (d === 0) throw new ExpressionError("Division by zero.");
          return toNumber(a, "Dividend") / d;
        }
        case "%": {
          const d = toNumber(b, "Divisor");
          if (d === 0) throw new ExpressionError("Division by zero.");
          return toNumber(a, "Dividend") % d;
        }
      }
      throw new ExpressionError(`Unknown operator "${node.op}".`);
    }
  }
}

/** Parses and evaluates `source`; references go through `lookup`. Throws {@link ExpressionError}. */
export function evaluateExpression(source: string, lookup: (path: string) => unknown): unknown {
  if (source.trim() === "") throw new ExpressionError("Empty calculation.");
  const result = evaluate(parse(tokenize(source)), lookup);
  if (typeof result === "number" && !Number.isFinite(result)) {
    throw new ExpressionError("Result is not a finite number.");
  }
  return result;
}

/** Reference paths (`vars.x`, `const.y`, `env.Z`) an expression uses — for dependency ordering. */
export function expressionReferences(source: string): string[] {
  try {
    return tokenize(source)
      .filter((t, i, all) => t.t === "id" && !(all[i + 1]?.t === "op" && all[i + 1]?.v === "("))
      .map((t) => t.v as string)
      .filter((v) => /^(vars|const|env)\./.test(v));
  } catch {
    return [];
  }
}
