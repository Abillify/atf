// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Structural redaction for anything mcpgate emits about a request.
 *
 * Why
 * ───
 * Monitor events carry `meta.arguments` (whatever the caller passed to a tool),
 * `meta.content` (whatever the tool returned — i.e. database rows) and
 * `meta.claims` (the full decoded token payload). Those events fan out to the
 * dashboard ring buffer, to the persistent audit log, and — when the cluster
 * bridge is on — to a Redis channel. So a secret or a personal detail that
 * appears in any of those three places has left the process boundary.
 *
 * Design choices
 * ──────────────
 * • **Key-based, not value-based.** Guessing at values (regex for card numbers,
 *   emails, …) both misses and false-positives. Redacting by key name is
 *   predictable, cheap, and matches how this data is actually shaped.
 * • **Claims use an allowlist, everything else a denylist.** A token payload is
 *   a known, small, enumerable shape whose *purpose* is to carry identity
 *   attributes, so allowlisting is feasible and much safer. Tool arguments and
 *   results are arbitrary, so a denylist plus size caps is the honest option.
 * • **Truncation, not removal.** The monitor exists to be useful. Cutting a
 *   long string to a bounded prefix keeps it diagnosable while ensuring one
 *   large result cannot dump a whole table into the audit file.
 * • **Redaction is not a substitute for a PII policy.** It reduces incidental
 *   exposure; a tool whose *non-sensitively-named* column holds personal data
 *   is still surfaced. That is what the per-tool `redact` config is for. Stated
 *   here so the guarantee is not overread.
 */

/** Marker written in place of a redacted value. */
export const REDACTED = "[redacted]";

export interface RedactOptions {
  /** Turn redaction off entirely (not recommended). */
  enabled: boolean;
  /**
   * Lower-cased key fragments. A key is redacted when it *contains* any of
   * these, so `apiKey`, `api_key` and `x-api-key` are all covered by "key"
   * — hence the fragments are chosen narrowly.
   */
  keys: string[];
  /** Strings longer than this are truncated (0 = no truncation). */
  maxStringLength: number;
  /** Max array elements kept before a "+N more" marker (0 = unlimited). */
  maxArrayLength: number;
  /** Max nesting depth before collapsing to a marker. */
  maxDepth: number;
  /** Token claims kept verbatim; every other claim is dropped. */
  claimAllowlist: string[];
}

/** Conservative defaults: block the obvious credential/PII-shaped keys. */
export const DEFAULT_REDACT_KEYS = [
  "password",
  "passwd",
  "secret",
  "token",
  "authorization",
  "cookie",
  "apikey",
  "api_key",
  "private_key",
  "privatekey",
  "client_secret",
  "credential",
  "session_id_secret",
  "iban",
  "bic",
  "ssn",
  "taxid",
  "tax_id",
  "creditcard",
  "credit_card",
  "card_number",
  "cardnumber",
  "cvv",
  // Deliberately NOT a bare "pin": after canonicalisation it is a substring of
  // ordinary words like "mapping" and "shipping", which would redact unrelated
  // fields and quietly make the monitor useless.
  "pincode",
  "pin_code",
];

/**
 * Claims that are operationally necessary (correlating a request to an
 * identity) and not, in themselves, contact details.
 */
export const DEFAULT_CLAIM_ALLOWLIST = [
  "sub",
  "iss",
  "aud",
  "azp",
  "client_id",
  "exp",
  "iat",
  "nbf",
  "jti",
  "scope",
  "scp",
  "roles",
  "groups",
  "preferred_username",
];

export const DEFAULT_REDACT_OPTIONS: RedactOptions = {
  enabled: true,
  keys: DEFAULT_REDACT_KEYS,
  maxStringLength: 2048,
  maxArrayLength: 100,
  maxDepth: 8,
  claimAllowlist: DEFAULT_CLAIM_ALLOWLIST,
};

/**
 * Canonicalise a key for matching: lower-case and strip every non-alphanumeric
 * character.
 *
 * This is what makes one fragment cover every spelling a real payload uses —
 * `apiKey`, `api_key`, `API-KEY` and `x-api-key` all canonicalise to a string
 * containing `apikey`. Matching on the raw lower-cased key silently missed the
 * hyphenated header form, which is precisely the spelling that arrives over
 * HTTP.
 */
export function canonicalKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string, fragments: string[]): boolean {
  const k = canonicalKey(key);
  return fragments.some((f) => {
    const cf = canonicalKey(f);
    return cf.length > 0 && k.includes(cf);
  });
}

function truncate(value: string, max: number): string {
  if (max <= 0 || value.length <= max) return value;
  return `${value.slice(0, max)}…[+${value.length - max} chars]`;
}

/**
 * Recursively redact a value.
 *
 * Cycles are handled with a `seen` set so a self-referential object (which a
 * driver error or a wrapped request can easily produce) cannot make this
 * recurse forever — the audit path must never be able to hang the process.
 */
function walk(
  value: unknown,
  opts: RedactOptions,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return truncate(value, opts.maxStringLength);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[function]";
  if (typeof value === "symbol") return value.toString();

  if (depth >= opts.maxDepth) return "[depth limit]";

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: truncate(value.message, opts.maxStringLength) };
  }
  if (Buffer.isBuffer(value)) return `[buffer ${value.byteLength} bytes]`;

  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const cap = opts.maxArrayLength > 0 ? opts.maxArrayLength : value.length;
    const out: unknown[] = value
      .slice(0, cap)
      .map((v) => walk(v, opts, depth + 1, seen));
    if (value.length > cap) out.push(`[+${value.length - cap} more]`);
    return out;
  }

  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k, opts.keys)) {
        out[k] = REDACTED;
        continue;
      }
      out[k] = walk(v, opts, depth + 1, seen);
    }
    return out;
  }

  return String(value);
}

/** Redact an arbitrary structure (tool arguments, tool results, log context). */
export function redact(value: unknown, opts: RedactOptions = DEFAULT_REDACT_OPTIONS): unknown {
  if (!opts.enabled) return value;
  return walk(value, opts, 0, new WeakSet<object>());
}

/**
 * Reduce a decoded token payload to the allowlisted claims.
 *
 * Non-allowlisted claims are dropped and *counted* rather than silently
 * disappearing, so an operator debugging a claim-mapping problem can see that
 * the token had more in it and knows to look at the IdP instead of assuming the
 * claim was absent.
 */
export function redactClaims(
  claims: unknown,
  opts: RedactOptions = DEFAULT_REDACT_OPTIONS,
): unknown {
  if (!opts.enabled) return claims;
  if (claims === null || typeof claims !== "object" || Array.isArray(claims)) {
    return redact(claims, opts);
  }
  const allow = new Set(opts.claimAllowlist.map((c) => c.toLowerCase()));
  const out: Record<string, unknown> = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(claims as Record<string, unknown>)) {
    if (allow.has(k.toLowerCase())) {
      out[k] = walk(v, opts, 1, new WeakSet<object>());
    } else {
      dropped++;
    }
  }
  if (dropped > 0) out["_redactedClaims"] = dropped;
  return out;
}

/**
 * Redact a monitor event's `meta` bag.
 *
 * `claims` gets allowlist treatment; everything else gets the denylist plus
 * size caps. Returns the same reference when there is nothing to do, so the
 * hot path does not allocate.
 */
export function redactEventMeta(
  meta: Record<string, unknown> | undefined,
  opts: RedactOptions = DEFAULT_REDACT_OPTIONS,
): Record<string, unknown> | undefined {
  if (!opts.enabled || meta === undefined) return meta;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k === "claims") {
      out[k] = redactClaims(v, opts);
      continue;
    }
    if (isSensitiveKey(k, opts.keys)) {
      out[k] = REDACTED;
      continue;
    }
    out[k] = walk(v, opts, 1, new WeakSet<object>());
  }
  return out;
}

/** The shape of `monitoring.redact` in the config (kept structural on purpose). */
export interface RedactConfigInput {
  enabled: boolean;
  extraKeys: string[];
  keys?: string[] | undefined;
  maxStringLength: number;
  maxArrayLength: number;
  maxDepth: number;
  claimAllowlist?: string[] | undefined;
}

/**
 * Turn the config block into {@link RedactOptions}.
 *
 * `keys` REPLACES the built-in denylist; `extraKeys` EXTENDS it. Both are
 * offered because "add our domain columns" is the common case while "we have our
 * own policy" is a legitimate but rarer one — and conflating them would make the
 * common case silently drop the built-in protections.
 */
export function resolveRedactOptions(cfg: RedactConfigInput): RedactOptions {
  const base = cfg.keys ?? DEFAULT_REDACT_KEYS;
  const keys = [...new Set([...base, ...cfg.extraKeys].map((k) => k.toLowerCase()))];
  return {
    enabled: cfg.enabled,
    keys,
    maxStringLength: cfg.maxStringLength,
    maxArrayLength: cfg.maxArrayLength,
    maxDepth: cfg.maxDepth,
    claimAllowlist: cfg.claimAllowlist ?? DEFAULT_CLAIM_ALLOWLIST,
  };
}
