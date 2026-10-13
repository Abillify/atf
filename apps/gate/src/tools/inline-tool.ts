// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { AuthContext } from "../auth/context.ts";
import type { InlineTool } from "../config/schema.ts";
import type { ToolDefinition, ToolExecutor, ToolResult, ToolRuntime } from "./types.ts";

// ---------------------------------------------------------------------------
// Built-in handler registry
// ---------------------------------------------------------------------------

type InlineHandler = (args: Record<string, unknown>, options: Record<string, unknown>) => ToolResult;

/**
 * All built-in inline handlers, keyed by the `handler` field value used in
 * tool.yaml. Add new entries here to register additional inline tools.
 */
const HANDLERS: Record<string, InlineHandler> = {
  calculate: handleCalculate,
  datetime: handleDatetime,
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Executes a built-in inline tool by dispatching to the registered handler
 * function. No database or network access is required.
 */
export class InlineToolExecutor implements ToolExecutor {
  readonly definition: ToolDefinition;

  constructor(
    private readonly cfg: InlineTool,
    _runtime: ToolRuntime,
  ) {
    this.definition = {
      name: cfg.name,
      description: cfg.description,
      inputSchema: cfg.inputSchema as Record<string, unknown>,
      ...(cfg.outputSchema !== undefined
        ? { outputSchema: cfg.outputSchema as Record<string, unknown> }
        : {}),
    };
  }

  async execute(args: Record<string, unknown>, _ctx: AuthContext): Promise<ToolResult> {
    const handler = HANDLERS[this.cfg.handler];
    if (!handler) {
      return {
        content: [
          {
            type: "text",
            text: `Unknown inline handler '${this.cfg.handler}'. Available handlers: ${Object.keys(HANDLERS).join(", ")}`,
          },
        ],
        isError: true,
      };
    }
    try {
      return handler(args, this.cfg.options);
    } catch (err) {
      return {
        content: [{ type: "text", text: String(err instanceof Error ? err.message : err) }],
        isError: true,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Handler: calculate
// ---------------------------------------------------------------------------

/**
 * Evaluates one or more arithmetic expressions supplied as `input`.
 * Multiple expressions may be separated by semicolons or newlines and are each
 * evaluated independently. Results are returned one per line.
 */
function handleCalculate(args: Record<string, unknown>, _options: Record<string, unknown>): ToolResult {
  const input = args["input"];
  if (typeof input !== "string" || input.trim() === "") {
    return {
      content: [{ type: "text", text: "Parameter 'input' must be a non-empty string." }],
      isError: true,
    };
  }

  const exprs = input.split(/[\n;]/).map((s) => s.trim()).filter((s) => s.length > 0);
  const lines: string[] = [];
  const results: Array<{ input: string; result: number }> = [];
  let hasError = false;

  for (const expr of exprs) {
    try {
      const result = parseExpression(expr);
      const display = formatNumber(result);
      lines.push(exprs.length === 1 ? display : `${expr} = ${display}`);
      results.push({ input: expr, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lines.push(exprs.length === 1 ? `Error: ${msg}` : `${expr} → Error: ${msg}`);
      hasError = true;
    }
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    ...(hasError ? { isError: true } : {}),
    meta: { expressions: results },
  };
}

/** Integer if whole, otherwise up to 10 significant digits with trailing zeros stripped. */
function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  return parseFloat(n.toPrecision(10)).toString();
}

// ---------------------------------------------------------------------------
// Safe recursive-descent arithmetic parser
//
// Grammar:
//   expr   = term  ( ( '+' | '-' ) term  )*
//   term   = power ( ( '*' | '/' | '%' ) power )*
//   power  = unary ( '^' power )?                  -- right-associative
//   unary  = ( '+' | '-' ) unary | atom
//   atom   = '(' expr ')'
//          | ident '(' args ')'                    -- function call
//          | ident                                 -- named constant
//          | number
//   args   = expr ( ',' expr )*
//   ident  = /[a-zA-Z_][a-zA-Z0-9_]*/
//   number = /[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/
// ---------------------------------------------------------------------------

/** Named constants available in expressions. */
const CONSTANTS: Record<string, number> = {
  pi:  Math.PI,
  PI:  Math.PI,
  e:   Math.E,
  tau: 2 * Math.PI,
  inf: Infinity,
};

/** Built-in functions: name → variadic implementation. */
const FUNCTIONS: Record<string, (...a: number[]) => number> = {
  sqrt:  (x) => Math.sqrt(x),
  cbrt:  (x) => Math.cbrt(x),
  pow:   (x, y) => Math.pow(x, y),
  abs:   (x) => Math.abs(x),
  floor: (x) => Math.floor(x),
  ceil:  (x) => Math.ceil(x),
  round: (x) => Math.round(x),
  trunc: (x) => Math.trunc(x),
  sign:  (x) => Math.sign(x),
  log:   (x) => Math.log(x),
  log2:  (x) => Math.log2(x),
  log10: (x) => Math.log10(x),
  exp:   (x) => Math.exp(x),
  sin:   (x) => Math.sin(x),
  cos:   (x) => Math.cos(x),
  tan:   (x) => Math.tan(x),
  asin:  (x) => Math.asin(x),
  acos:  (x) => Math.acos(x),
  atan:  (x) => Math.atan(x),
  atan2: (y, x) => Math.atan2(y, x),
  hypot: (...a) => Math.hypot(...a),
  min:   (...a) => Math.min(...a),
  max:   (...a) => Math.max(...a),
};

/** Allowed argument counts [min, max] per function. */
const ARITY: Record<string, [number, number]> = {
  sqrt:  [1, 1], cbrt:  [1, 1], pow:   [2, 2],
  abs:   [1, 1], floor: [1, 1], ceil:  [1, 1],
  round: [1, 1], trunc: [1, 1], sign:  [1, 1],
  log:   [1, 1], log2:  [1, 1], log10: [1, 1],
  exp:   [1, 1], sin:   [1, 1], cos:   [1, 1],
  tan:   [1, 1], asin:  [1, 1], acos:  [1, 1],
  atan:  [1, 1], atan2: [2, 2],
  hypot: [1, 64], min: [1, 64], max: [1, 64],
};

function parseExpression(src: string): number {
  const p = new Parser(src);
  const value = p.expr();
  p.expectEnd();
  return value;
}

class Parser {
  private pos = 0;

  constructor(private readonly src: string) {}

  // ── public ───────────────────────────────────────────────────────────────

  expr(): number {
    let left = this.term();
    this.ws();
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]!;
      if (ch !== "+" && ch !== "-") break;
      this.pos++;
      this.ws();
      const right = this.term();
      left = ch === "+" ? left + right : left - right;
      this.ws();
    }
    return left;
  }

  expectEnd(): void {
    this.ws();
    if (this.pos < this.src.length) {
      throw new Error(`Unexpected character '${this.src[this.pos]}' at position ${this.pos + 1}`);
    }
  }

  // ── grammar rules ────────────────────────────────────────────────────────

  private term(): number {
    let left = this.power();
    this.ws();
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]!;
      if (ch !== "*" && ch !== "/" && ch !== "%") break;
      this.pos++;
      this.ws();
      const right = this.power();
      if (ch === "*") {
        left = left * right;
      } else if (ch === "/") {
        if (right === 0) throw new Error("Division by zero");
        left = left / right;
      } else {
        if (right === 0) throw new Error("Modulo by zero");
        left = left % right;
      }
      this.ws();
    }
    return left;
  }

  /** Right-associative: 2^3^2 → 2^(3^2) = 512. */
  private power(): number {
    const base = this.unary();
    this.ws();
    if (this.pos < this.src.length && this.src[this.pos] === "^") {
      this.pos++;
      this.ws();
      return Math.pow(base, this.power()); // right-recursive
    }
    return base;
  }

  private unary(): number {
    this.ws();
    if (this.pos >= this.src.length) throw new Error("Unexpected end of expression");
    const ch = this.src[this.pos]!;
    if (ch === "+" || ch === "-") {
      this.pos++;
      this.ws();
      const v = this.unary();
      return ch === "-" ? -v : v;
    }
    return this.atom();
  }

  private atom(): number {
    this.ws();
    if (this.pos >= this.src.length) throw new Error("Unexpected end of expression");
    const ch = this.src[this.pos]!;

    if (ch === "(") {
      this.pos++;
      this.ws();
      const v = this.expr();
      this.ws();
      if (this.pos >= this.src.length || this.src[this.pos] !== ")") {
        throw new Error("Missing closing parenthesis");
      }
      this.pos++;
      return v;
    }

    // Identifier: function call or named constant
    if (/[a-zA-Z_]/.test(ch)) return this.identOrCall();

    // Number (may start with digit or leading dot like .5)
    if ((ch >= "0" && ch <= "9") || ch === ".") return this.number();

    throw new Error(`Unexpected character '${ch}' at position ${this.pos + 1}`);
  }

  private identOrCall(): number {
    const start = this.pos;
    while (this.pos < this.src.length && /[a-zA-Z0-9_]/.test(this.src[this.pos]!)) {
      this.pos++;
    }
    const name = this.src.slice(start, this.pos);
    this.ws();

    // Function call
    if (this.pos < this.src.length && this.src[this.pos] === "(") {
      if (!(name in FUNCTIONS)) throw new Error(`Unknown function '${name}'`);
      this.pos++; // consume '('
      this.ws();
      const argValues: number[] = [];
      if (this.pos < this.src.length && this.src[this.pos] !== ")") {
        argValues.push(this.expr());
        this.ws();
        while (this.pos < this.src.length && this.src[this.pos] === ",") {
          this.pos++;
          this.ws();
          argValues.push(this.expr());
          this.ws();
        }
      }
      if (this.pos >= this.src.length || this.src[this.pos] !== ")") {
        throw new Error(`Missing ')' after arguments to '${name}'`);
      }
      this.pos++;
      const [min, max] = ARITY[name] ?? [0, 64];
      if (argValues.length < min || argValues.length > max) {
        const range = min === max ? `${min}` : `${min}–${max}`;
        throw new Error(`'${name}' expects ${range} argument(s), got ${argValues.length}`);
      }
      const result = FUNCTIONS[name]!(...argValues);
      if (Number.isNaN(result)) throw new Error(`'${name}(${argValues.join(", ")})' produced NaN`);
      return result;
    }

    // Named constant
    if (name in CONSTANTS) return CONSTANTS[name]!;
    throw new Error(`Unknown identifier '${name}'`);
  }

  private number(): number {
    const start = this.pos;
    while (this.pos < this.src.length && this.src[this.pos]! >= "0" && this.src[this.pos]! <= "9") {
      this.pos++;
    }
    if (this.pos < this.src.length && this.src[this.pos] === ".") {
      this.pos++;
      while (this.pos < this.src.length && this.src[this.pos]! >= "0" && this.src[this.pos]! <= "9") {
        this.pos++;
      }
    }
    if (this.pos < this.src.length && (this.src[this.pos] === "e" || this.src[this.pos] === "E")) {
      this.pos++;
      if (this.pos < this.src.length && (this.src[this.pos] === "+" || this.src[this.pos] === "-")) {
        this.pos++;
      }
      const expStart = this.pos;
      while (this.pos < this.src.length && this.src[this.pos]! >= "0" && this.src[this.pos]! <= "9") {
        this.pos++;
      }
      if (this.pos === expStart) throw new Error("Invalid exponent in number literal");
    }
    const str = this.src.slice(start, this.pos);
    const v = Number(str);
    if (Number.isNaN(v)) throw new Error(`Invalid number literal '${str}'`);
    return v;
  }

  private ws(): void {
    while (this.pos < this.src.length && (this.src[this.pos] === " " || this.src[this.pos] === "\t")) {
      this.pos++;
    }
  }
}

// ---------------------------------------------------------------------------
// Handler: datetime
// ---------------------------------------------------------------------------

/**
 * Returns the current date/time (or an optionally supplied base date) in a
 * configurable timezone, with an optional arithmetic modifier.
 *
 * Args:
 *   timezone        – IANA tz name; falls back to options.timezone or "UTC"
 *   modifier_value  – numeric offset (e.g. 2); requires modifier_unit
 *   modifier_unit   – one of: milliseconds, seconds, minutes, hours,
 *                     days, weeks, months, years  (singular forms also accepted)
 *   date            – ISO 8601 base date/datetime instead of now;
 *                     date-only strings (YYYY-MM-DD) are treated as midnight
 *                     in the resolved timezone
 */
function handleDatetime(args: Record<string, unknown>, options: Record<string, unknown>): ToolResult {
  // ── resolve timezone ────────────────────────────────────────────────────
  const tz =
    (typeof args["timezone"] === "string" ? args["timezone"].trim() : undefined) ??
    (typeof options["timezone"] === "string" ? options["timezone"].trim() : undefined) ??
    "UTC";

  if (!isValidTimezone(tz)) {
    return {
      content: [{ type: "text", text: `Unknown timezone '${tz}'. Use an IANA name like "Europe/Berlin" or "America/New_York".` }],
      isError: true,
    };
  }

  // ── resolve base date ───────────────────────────────────────────────────
  let base: Date;
  const dateArg = args["date"];
  if (typeof dateArg === "string" && dateArg.trim() !== "") {
    const raw = dateArg.trim();
    // Date-only (YYYY-MM-DD): treat as midnight in the target timezone.
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      base = localMidnight(raw, tz);
    } else {
      base = new Date(raw);
    }
    if (Number.isNaN(base.getTime())) {
      return {
        content: [{ type: "text", text: `Invalid date '${dateArg}'. Use ISO 8601, e.g. "2026-06-19" or "2026-06-19T10:00:00".` }],
        isError: true,
      };
    }
  } else {
    base = new Date();
  }

  // ── apply modifier ──────────────────────────────────────────────────────
  const modValue = args["modifier_value"];
  const modUnit  = args["modifier_unit"];
  if (modValue !== undefined || modUnit !== undefined) {
    if (typeof modValue !== "number") {
      return {
        content: [{ type: "text", text: "modifier_value must be a number." }],
        isError: true,
      };
    }
    if (typeof modUnit !== "string") {
      return {
        content: [{ type: "text", text: "modifier_unit must be a string (e.g. \"days\")." }],
        isError: true,
      };
    }
    try {
      base = applyModifier(base, modValue, modUnit);
    } catch (err) {
      return {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  }

  // ── format and return ───────────────────────────────────────────────────
  const result = formatDatetime(base, tz);
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    meta: result as unknown as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// datetime helpers
// ---------------------------------------------------------------------------

/** Parse a YYYY-MM-DD string as midnight in the given IANA timezone. */
function localMidnight(dateOnly: string, tz: string): Date {
  // Build a local-time ISO string and figure out what UTC instant that is.
  // Strategy: try both adjacent UTC offsets until one round-trips correctly.
  const [y, m, d] = dateOnly.split("-").map(Number) as [number, number, number];

  // Initial guess: UTC midnight.
  let candidate = new Date(Date.UTC(y, m - 1, d));

  // Iteratively adjust: compute what local date the candidate maps to in tz,
  // and nudge if it's off (handles DST edge cases after at most two passes).
  for (let i = 0; i < 3; i++) {
    const parts = dtParts(candidate, tz);
    const diff =
      Date.UTC(parseInt(parts.year ?? "0"), parseInt(parts.month ?? "1") - 1, parseInt(parts.day ?? "1")) -
      Date.UTC(y, m - 1, d);
    if (diff === 0) break;
    candidate = new Date(candidate.getTime() - diff);
  }
  return candidate;
}

/** Apply a numeric modifier (value + unit) to a Date. */
function applyModifier(date: Date, value: number, unit: string): Date {
  const u = unit.trim().toLowerCase().replace(/s$/, ""); // "days" → "day"
  const ms = date.getTime();
  switch (u) {
    case "millisecond": case "ms":    return new Date(ms + value);
    case "second":      case "sec":   return new Date(ms + value * 1_000);
    case "minute":      case "min":   return new Date(ms + value * 60_000);
    case "hour":                       return new Date(ms + value * 3_600_000);
    case "day":                        return new Date(ms + value * 86_400_000);
    case "week":                       return new Date(ms + value * 7 * 86_400_000);
    case "month": {
      const d = new Date(ms);
      d.setUTCMonth(d.getUTCMonth() + value);
      return d;
    }
    case "year": {
      const d = new Date(ms);
      d.setUTCFullYear(d.getUTCFullYear() + value);
      return d;
    }
    default:
      throw new Error(
        `Unknown unit '${unit}'. Use: milliseconds, seconds, minutes, hours, days, weeks, months, years`,
      );
  }
}

interface DatetimeResult {
  iso:       string;
  date:      string;
  time:      string;
  datetime:  string;
  weekday:   string;
  timezone:  string;
  utcOffset: string;
  timestamp: number;
}

/** Format a UTC instant as a structured object in the given IANA timezone. */
function formatDatetime(date: Date, tz: string): DatetimeResult {
  const p = dtParts(date, tz);

  // hour "24" can appear for midnight in some locales — normalise to "00"
  const hour = p.hour === "24" ? "00" : p.hour;

  const dateStr     = `${p.year}-${p.month}-${p.day}`;
  const timeStr     = `${hour}:${p.minute}:${p.second}`;
  const offsetStr   = utcOffsetString(date, tz);
  const weekday     = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(date);

  return {
    iso:       `${dateStr}T${timeStr}${offsetStr}`,
    date:      dateStr,
    time:      timeStr,
    datetime:  `${dateStr} ${timeStr}`,
    weekday,
    timezone:  tz,
    utcOffset: offsetStr,
    timestamp: date.getTime(),
  };
}

/** Extract zero-padded date/time components in a given timezone. */
function dtParts(date: Date, tz: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
}

/**
 * Compute the UTC offset for a given instant in an IANA timezone and return
 * it as a ±HH:MM string suitable for ISO 8601.
 *
 * Approach: interpret the formatted local time as a UTC instant, then compare
 * with the real UTC instant. Works with any Intl-compliant runtime.
 */
function utcOffsetString(date: Date, tz: string): string {
  const p = dtParts(date, tz);
  const hour = p.hour === "24" ? "00" : p.hour;
  // Treat the local components as a UTC instant to compute the diff.
  const localAsUtc = Date.UTC(
    parseInt(p.year ?? "0"), parseInt(p.month ?? "1") - 1, parseInt(p.day ?? "1"),
    parseInt(hour ?? "0"), parseInt(p.minute ?? "0"), parseInt(p.second ?? "0"),
  );
  const offsetMin = Math.round((localAsUtc - date.getTime()) / 60_000);
  const sign   = offsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const hh     = Math.floor(absMin / 60).toString().padStart(2, "0");
  const mm     = (absMin % 60).toString().padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/** Return true if the IANA timezone name is recognised by the runtime. */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
