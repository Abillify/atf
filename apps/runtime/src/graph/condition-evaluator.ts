// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Safe Condition Expression Evaluator (`src/graph/condition-evaluator.ts`)
 *
 * Evaluates routing condition expressions WITHOUT using `eval` or `new Function`.
 * A small recursive-descent parser supports a safe boolean/comparison grammar
 * over a typed context object, so flow authors cannot execute arbitrary code or
 * exfiltrate sensitive state.
 *
 * Grammar (precedence low → high):
 *   or        := and ( "||" and )*
 *   and       := not ( "&&" not )*
 *   not       := "!" not | comparison
 *   comparison:= additive ( ( "==" | "!=" | "===" | "!==" | "<" | "<=" | ">" | ">=" | "=~" ) additive )?
 *   additive  := primary ( ("+" | "-") primary )*
 *   primary   := NUMBER | STRING | BOOL | NULL | IDENT ( "." IDENT )* ( "[" NUMBER "]" )? ( "(" primary ")" )?
 *              | "(" or ")"
 *
 * The `=~` operator is a case-insensitive regular-expression test: the left
 * operand (coerced to string) is tested against the right operand interpreted
 * as a regex source string, e.g. `lastMessageText =~ 'foo|bar'`. It lets flow
 * authors keep domain-specific keyword routing in flow config instead of the
 * engine. An invalid pattern or a non-string left operand evaluates to false.
 *
 * Built-in method calls on dot-path identifiers:
 *   .includes(value)     — array membership or string substring test
 *   .contains(value)     — alias for .includes
 *   .startsWith(value)   — string prefix test
 *   .endsWith(value)     — string suffix test
 *   .length              — resolved as a numeric property (no call syntax)
 *
 * Array index access: `groups[0]`, `params.tags[1]`
 *
 * Supported operand types: number, string, boolean, null.
 * Identifiers resolve against the provided context (dot-path access).
 *
 * No `any` at module boundaries.
 *
 */

export type ConditionContext = Record<string, unknown>;

type Primitive = number | string | boolean | null;

/**
 * ReDoS guard bounds for the `=~` regex operator. Flow authors supply the
 * pattern, so an adversarial/naive pattern with catastrophic backtracking could
 * otherwise block the event loop. JavaScript offers no per-match timeout, so we
 * apply TWO independent guards: (1) a static rejection of pattern shapes prone
 * to catastrophic backtracking ({@link isPotentiallyCatastrophicRegex}) — a
 * length cap alone does NOT bound exponential blow-up — and (2) length caps on
 * both the pattern source and the tested subject to keep even linear-time
 * matching cheap. A pattern longer than the source limit, or one flagged as
 * catastrophic, evaluates to `false`; an oversized subject is truncated.
 */
const MAX_REGEX_SOURCE_LENGTH = 200;
const MAX_REGEX_SUBJECT_LENGTH = 2000;

/**
 * Detects regex sources that are prone to catastrophic backtracking (ReDoS).
 * JavaScript's engine offers no per-match timeout and bounding the input length
 * does NOT bound exponential blow-up (e.g. `(a+)+$` against ~40 chars is already
 * ~2^40 steps regardless of length). Since flow authors supply the `=~` pattern
 * and the left operand is typically user-controlled text, an unsafe pattern is a
 * user-triggerable event-loop DoS. We therefore REJECT patterns that exhibit the
 * classic dangerous shapes rather than pretend a length cap protects us:
 *
 *   - a quantified group whose body itself ends in a quantifier —
 *     `(…+)+`, `(…*)*`, `(…+)*`, `(…*)+`, with optional `{m,n}` forms;
 *   - two adjacent unbounded quantifiers — `.*.*`, `a+a+` style overlap;
 *   - a quantifier applied to an alternation that repeats a token — `(a|a)*`.
 *
 * This is a conservative static heuristic (no false "safe" on the known-bad
 * shapes); a rejected pattern makes the `=~` comparison evaluate to `false`.
 */
export function isPotentiallyCatastrophicRegex(source: string): boolean {
  // Nested quantifier: a (non-nested) group whose BODY contains an UNBOUNDED
  // quantifier (`+`, `*`, or `{n,}`) ANYWHERE — not only in trailing position —
  // that is itself followed by an UNBOUNDED quantifier. This is the classic
  // exponential shape and covers the cases a "trailing-only" check misses:
  //   (a+)+, (a*)*, ([ab]+)*, (?:a+)+   — quantifier at end of body
  //   (\w+\s)+, (\d+,)+, (a+b)+, (\w+-)+ — body ends in a LITERAL (was missed)
  //   (a{2,})+                          — inner {n,} unbounded
  // A BOUNDED outer quantifier `{m,n}` is deliberately NOT matched, so a benign
  // pattern like `(\d+){1,3}` (polynomial, three iterations) is allowed rather
  // than silently turned into `false`.
  const innerUnbounded = "(?:[+*]|\\{\\d+,\\})";
  const nestedQuantifier = new RegExp(
    `\\((?:\\?[:=!])?[^()]*${innerUnbounded}[^()]*\\)${innerUnbounded}`,
  );
  if (nestedQuantifier.test(source)) return true;

  // Two adjacent unbounded quantifiers on repeated-ish content, e.g. `.*.*`,
  // `\d+\d+`, `a*a*` — overlapping repetition that backtracks super-linearly
  // against a non-matching tail.
  if (/([.\w\\])[+*]\1?[+*]/.test(source)) return true;
  if (/\.[+*].*\.[+*]/.test(source)) return true;

  // Quantified alternation with a repeated branch: (a|a)*, (ab|ab)+
  if (/\((?:\?[:=!])?([^)|]+)\|\1\)[+*]/.test(source)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenType =
  | "number"
  | "string"
  | "ident"
  | "op"
  | "lparen"
  | "rparen"
  | "lbracket"
  | "rbracket"
  | "eof";

interface Token {
  type: TokenType;
  value: string;
}

const OPERATORS = [
  "===",
  "!==",
  "==",
  "!=",
  "=~",
  "<=",
  ">=",
  "&&",
  "||",
  "<",
  ">",
  "!",
  "+",
  "-",
  ".",
  "[",
  "]",
];

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i] ?? "";

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    // Parentheses
    if (ch === "(") {
      tokens.push({ type: "lparen", value: "(" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", value: ")" });
      i++;
      continue;
    }
    if (ch === "[") {
      tokens.push({ type: "lbracket", value: "[" });
      i++;
      continue;
    }
    if (ch === "]") {
      tokens.push({ type: "rbracket", value: "]" });
      i++;
      continue;
    }

    // String literal (single or double quotes)
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let str = "";
      while (j < input.length && input[j] !== quote) {
        if (input[j] === "\\" && j + 1 < input.length) {
          str += input[j + 1];
          j += 2;
        } else {
          str += input[j];
          j++;
        }
      }
      if (j >= input.length) throw new Error("Unterminated string literal");
      tokens.push({ type: "string", value: str });
      i = j + 1;
      continue;
    }

    // Number literal
    if (ch >= "0" && ch <= "9") {
      let j = i;
      let num = "";
      while (j < input.length && /[0-9.]/.test(input[j] ?? "")) {
        num += input[j];
        j++;
      }
      tokens.push({ type: "number", value: num });
      i = j;
      continue;
    }

    // Operator (multi-char first)
    const op = OPERATORS.find((o) => input.startsWith(o, i));
    if (op !== undefined) {
      tokens.push({ type: "op", value: op });
      i += op.length;
      continue;
    }

    // Identifier (letters, digits, underscore — must start with letter/underscore)
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      let ident = "";
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] ?? "")) {
        ident += input[j];
        j++;
      }
      tokens.push({ type: "ident", value: ident });
      i = j;
      continue;
    }

    throw new Error(`Unexpected character "${ch}" at position ${i}`);
  }

  tokens.push({ type: "eof", value: "" });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser + evaluator (recursive descent)
// ---------------------------------------------------------------------------

/** Synthetic EOF returned if a caller ever advances past the real EOF token. */
const PARSER_EOF: Token = { type: "eof", value: "" };

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly ctx: ConditionContext,
  ) {}

  private peek(): Token {
    return this.tokens[this.pos] ?? PARSER_EOF;
  }

  private next(): Token {
    const t = this.tokens[this.pos] ?? PARSER_EOF;
    this.pos++;
    return t;
  }

  private expect(type: TokenType): Token {
    const t = this.next();
    if (t.type !== type) {
      throw new Error(`Expected ${type} but got ${t.type} "${t.value}"`);
    }
    return t;
  }

  parse(): Primitive {
    const result = this.parseOr();
    if (this.peek().type !== "eof") {
      throw new Error(`Unexpected token "${this.peek().value}"`);
    }
    return result;
  }

  private parseOr(): Primitive {
    let left = this.parseAnd();
    while (this.peek().type === "op" && this.peek().value === "||") {
      this.next();
      const right = this.parseAnd();
      left = Boolean(left) || Boolean(right);
    }
    return left;
  }

  private parseAnd(): Primitive {
    let left = this.parseNot();
    while (this.peek().type === "op" && this.peek().value === "&&") {
      this.next();
      const right = this.parseNot();
      left = Boolean(left) && Boolean(right);
    }
    return left;
  }

  private parseNot(): Primitive {
    if (this.peek().type === "op" && this.peek().value === "!") {
      this.next();
      return !this.parseNot();
    }
    return this.parseComparison();
  }

  private parseComparison(): Primitive {
    const left = this.parseAdditive();
    const t = this.peek();
    if (
      t.type === "op" &&
      ["==", "!=", "===", "!==", "<", "<=", ">", ">=", "=~"].includes(t.value)
    ) {
      this.next();
      const right = this.parseAdditive();
      return this.applyComparison(t.value, left, right);
    }
    return left;
  }

  private applyComparison(
    op: string,
    left: Primitive,
    right: Primitive,
  ): boolean {
    switch (op) {
      case "==":
      case "===":
        return left === right;
      case "!=":
      case "!==":
        return left !== right;
      case "<":
        return (left as number) < (right as number);
      case "<=":
        return (left as number) <= (right as number);
      case ">":
        return (left as number) > (right as number);
      case ">=":
        return (left as number) >= (right as number);
      case "=~": {
        // Case-insensitive regex test. Left coerced to string; right is the
        // regex source. Invalid patterns or null/undefined left → false.
        //
        // ReDoS guard: a flow author controls the pattern, so a pathological
        // regex (e.g. nested quantifiers like "(a+)+$") could otherwise hang the
        // event loop on a crafted input. JS has no regex timeout, so we bound
        // both the pattern source and the tested subject length — pattern
        // matching time is bounded by (pattern × subject), and both factors are
        // now capped. Oversized inputs fail closed (return false).
        if (left === null || left === undefined) return false;
        const source = String(right);
        if (source.length > MAX_REGEX_SOURCE_LENGTH) return false;
        // Reject patterns prone to catastrophic backtracking — a length cap
        // does NOT bound exponential blow-up (see isPotentiallyCatastrophicRegex).
        if (isPotentiallyCatastrophicRegex(source)) return false;
        const subject = String(left);
        const boundedSubject =
          subject.length > MAX_REGEX_SUBJECT_LENGTH
            ? subject.slice(0, MAX_REGEX_SUBJECT_LENGTH)
            : subject;
        try {
          return new RegExp(source, "i").test(boundedSubject);
        } catch {
          return false;
        }
      }
      default:
        throw new Error(`Unknown comparison operator "${op}"`);
    }
  }

  private parseAdditive(): Primitive {
    let left = this.parsePrimary();
    while (
      this.peek().type === "op" &&
      (this.peek().value === "+" || this.peek().value === "-")
    ) {
      const op = this.next().value;
      const right = this.parsePrimary();
      if (op === "+") {
        // String concat or numeric add
        if (typeof left === "string" || typeof right === "string") {
          left = String(left) + String(right);
        } else {
          left = (left as number) + (right as number);
        }
      } else {
        left = (left as number) - (right as number);
      }
    }
    return left;
  }

  private parsePrimary(): Primitive {
    const t = this.peek();

    if (t.type === "lparen") {
      this.next();
      const inner = this.parseOr();
      this.expect("rparen");
      return inner;
    }

    if (t.type === "number") {
      this.next();
      return Number(t.value);
    }

    if (t.type === "string") {
      this.next();
      return t.value;
    }

    if (t.type === "ident") {
      // Could be a keyword literal or a context path
      if (t.value === "true") {
        this.next();
        return true;
      }
      if (t.value === "false") {
        this.next();
        return false;
      }
      if (t.value === "null") {
        this.next();
        return null;
      }
      return this.parseIdentPath();
    }

    throw new Error(`Unexpected token "${t.value}"`);
  }

  private parseIdentPath(): Primitive {
    let value: unknown = this.ctx;
    // First segment
    const first = this.expect("ident").value;
    value = (value as Record<string, unknown>)[first];

    // Dot-path continuation + array-index + method calls
    while (true) {
      // Dot-path: .propName or .methodName(arg)
      if (this.peek().type === "op" && this.peek().value === ".") {
        this.next();
        const key = this.expect("ident").value;

        // Method call: .includes(x), .contains(x), .startsWith(x), .endsWith(x)
        if (this.peek().type === "lparen") {
          this.next(); // consume '('
          const arg = this.parsePrimary();
          this.expect("rparen");

          switch (key) {
            case "includes":
            case "contains": {
              if (Array.isArray(value)) {
                value = value.includes(arg);
              } else if (typeof value === "string") {
                value = value.includes(String(arg));
              } else {
                value = false;
              }
              break;
            }
            case "startsWith": {
              if (typeof value === "string") {
                value = value.startsWith(String(arg));
              } else {
                value = false;
              }
              break;
            }
            case "endsWith": {
              if (typeof value === "string") {
                value = value.endsWith(String(arg));
              } else {
                value = false;
              }
              break;
            }
            default:
              // Unknown method — return null rather than throw (fail safe)
              value = null;
          }
          continue;
        }

        // Property access (including .length)
        if (value === null || value === undefined) {
          value = null;
          break;
        }
        if (key === "length") {
          if (typeof value === "string" || Array.isArray(value)) {
            value = (value as { length: number }).length;
          } else {
            value = null;
          }
          continue;
        }
        if (typeof value !== "object") {
          value = null;
          break;
        }
        value = (value as Record<string, unknown>)[key];
        continue;
      }

      // Array index access: [NUMBER]
      if (this.peek().type === "lbracket") {
        this.next(); // consume '['
        const idxTok = this.peek();
        let idx: number;
        if (idxTok.type === "number") {
          this.next();
          idx = Number(idxTok.value);
        } else {
          // Non-numeric index — not supported
          this.expect("rbracket");
          value = null;
          break;
        }
        this.expect("rbracket");
        if (Array.isArray(value)) {
          value = idx < value.length ? value[idx] : null;
        } else if (typeof value === "string") {
          value = idx < value.length ? value[idx] : null;
        } else {
          value = null;
        }
        continue;
      }

      break;
    }

    // Only allow primitive leaf values
    if (
      value === null ||
      value === undefined ||
      typeof value === "number" ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return value === undefined ? null : value;
    }
    // Objects/arrays collapse to null (cannot be compared meaningfully)
    return null;
  }
}

/**
 * Safely evaluates a boolean condition expression against a context object.
 * Returns false on any parse or evaluation error.
 */
export function evaluateConditionExpression(
  expression: string,
  ctx: ConditionContext,
): boolean {
  try {
    const tokens = tokenize(expression);
    const result = new Parser(tokens, ctx).parse();
    return Boolean(result);
  } catch {
    return false;
  }
}

/**
 * Parse-checks a condition expression WITHOUT evaluating it against real data.
 * Returns `{ valid: true }` when the grammar accepts it, or `{ valid: false,
 * error }` with the parser message. Used by the flow validator / editor so a
 * malformed routing expression is caught at author time, not silently treated
 * as `false` at runtime.
 */
export function validateConditionExpression(
  expression: string,
): { valid: true } | { valid: false; error: string } {
  try {
    const tokens = tokenize(expression);
    // Parse against an empty context — identifiers resolve to null, which is
    // fine: we only care that the expression is grammatically well-formed.
    new Parser(tokens, {}).parse();
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
