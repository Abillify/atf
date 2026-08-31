// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Chat Route — Request Handling & OpenAI Compatibility
 *
 * Contains request parsing, validation, RequestContext building, boundary node
 * utilities (request/response visualisation), and the variable overview.
 *
 * Requirements: 1.1, 1.2, 1.4, 1.5, 18.1, 20.1
 */

import type { ChatCompletionRequest, TokenUsage } from "../../types/openai.js";
import type { RequestContext } from "../../types/monitoring.js";
import type { MonitoringServiceInterface } from "../../monitoring/monitoring-service.js";
import type { FlowDefinition, LlmConfig } from "../../types/flow.js";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const REQUEST_NODE_ID = "__request__";
export const RESPONSE_NODE_ID = "__response__";

/** Upper bound on a boundary node's captured text to keep events bounded. */
const BOUNDARY_CAPTURE_LIMIT = 16_000;

/** Upper bound on the user-prompt preview captured for the request list. */
const USER_PROMPT_PREVIEW_LIMIT = 500;

/** Header names whose values carry credentials and must be masked by default. */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-auth-token",
]);

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function truncateBoundary(s: string): string {
  return s.length > BOUNDARY_CAPTURE_LIMIT
    ? s.slice(0, BOUNDARY_CAPTURE_LIMIT) +
        `\n… [truncated ${s.length - BOUNDARY_CAPTURE_LIMIT} chars]`
    : s;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Masks a credential to a non-reusable fingerprint: its length plus the last
 * 4 characters (e.g. "«masked len=312 …a1b2»"). Empty → "(none)".
 */
function maskSecret(value: string): string {
  if (value.length === 0) return "(none)";
  const tail = value.length >= 4 ? value.slice(-4) : "";
  return `«masked len=${value.length}${tail !== "" ? ` …${tail}` : ""}»`;
}

// ---------------------------------------------------------------------------
// Boundary node text builders
// ---------------------------------------------------------------------------

/** Builds the human-readable text shown in the `__request__` node detail. */
export function buildRequestNodeText(opts: {
  payload: unknown;
  headers: Headers;
  rawToken: string;
  claims: Record<string, unknown> | null;
  variablesOverview?: string;
  captureSecrets: boolean;
}): string {
  const headerLines = [...opts.headers.entries()]
    .map(([k, v]) =>
      !opts.captureSecrets && SENSITIVE_HEADERS.has(k.toLowerCase())
        ? `${k}: ${maskSecret(v)}`
        : `${k}: ${v}`,
    )
    .join("\n");
  const rawTokenLine = opts.captureSecrets
    ? opts.rawToken.length > 0
      ? opts.rawToken
      : "(none)"
    : maskSecret(opts.rawToken);
  const sections = [
    ...(opts.variablesOverview !== undefined
      ? [
          "═══ RESOLVED VARIABLES (set + usable downstream) ═══",
          opts.variablesOverview,
          "",
        ]
      : []),
    "═══ PAYLOAD (request body) ═══",
    safeJson(opts.payload),
    "",
    "═══ HEADERS ═══",
    headerLines.length > 0 ? headerLines : "(none)",
    "",
    "═══ DECODED TOKEN (JWT claims) ═══",
    opts.claims !== null
      ? safeJson(opts.claims)
      : "(token is not a decodable JWT, or no token present)",
    "",
    "═══ RAW TOKEN ═══",
    rawTokenLine,
  ];
  return truncateBoundary(sections.join("\n"));
}

/** Builds the human-readable text shown in the `__response__` node detail. */
export function buildResponseNodeText(opts: {
  model: string;
  streaming: boolean;
  responseText: string;
  usage?: TokenUsage;
  hadError: boolean;
}): string {
  const payload = {
    object: opts.streaming
      ? "chat.completion.chunk(assembled)"
      : "chat.completion",
    model: opts.model,
    streaming: opts.streaming,
    finish_reason: opts.hadError ? "error" : "stop",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: opts.responseText },
        finish_reason: opts.hadError ? "error" : "stop",
      },
    ],
    ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
  };
  return truncateBoundary(safeJson(payload));
}

// ---------------------------------------------------------------------------
// Request variable overview
// ---------------------------------------------------------------------------

/** Formats a variable value for the overview (quoted strings, JSON arrays). */
function formatVarValue(v: unknown): string {
  if (v === undefined || v === null) return "(not set)";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === "object") return safeJson(v);
  return String(v);
}

/** Formats decoded claim values as a single line for the diagnostics table. */
function formatInlineVarValue(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

interface VarCandidate {
  value: unknown;
  source: string;
}

/** First candidate with a defined, non-empty value — the one that "won". */
function firstDefined(cands: VarCandidate[]): VarCandidate | undefined {
  for (const c of cands) {
    if (c.value === undefined || c.value === null) continue;
    if (typeof c.value === "string" && c.value === "") continue;
    if (Array.isArray(c.value) && c.value.length === 0) continue;
    return c;
  }
  return undefined;
}

/**
 * Builds the "RESOLVED VARIABLES" section for the request boundary node.
 */
export function buildVariableOverview(opts: {
  claims: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  owui?: { id?: string; name?: string; email?: string; role?: string };
  acceptLanguage?: string;
  requestParams?: Record<string, unknown>;
}): string {
  const { claims, metadata, owui } = opts;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v !== "" ? v : undefined;

  const owuiName = (() => {
    if (owui?.name === undefined || owui.name === "") return undefined;
    try {
      return decodeURIComponent(owui.name);
    } catch {
      return owui.name;
    }
  })();

  const rawGroups = claims?.groups ?? claims?.group;
  const groups: string[] | undefined = Array.isArray(rawGroups)
    ? rawGroups.filter((g): g is string => typeof g === "string")
    : typeof rawGroups === "string"
      ? [rawGroups]
      : undefined;
  const groupsSource =
    claims?.groups !== undefined
      ? 'JWT claim "groups"'
      : 'JWT claim "group"';

  const firstLang = opts.acceptLanguage
    ? opts.acceptLanguage.split(",")[0]?.split(";")[0]?.trim()
    : undefined;

  const fields: Array<{ name: string; resolved: VarCandidate | undefined }> = [
    {
      name: "role",
      resolved: firstDefined([
        { value: str(owui?.role), source: "OWUI header X-OpenWebUI-User-Role" },
        { value: str(claims?.role), source: 'JWT claim "role"' },
        {
          value:
            Array.isArray(claims?.roles) &&
            typeof claims.roles[0] === "string"
              ? claims.roles[0]
              : undefined,
          source: 'JWT claim "roles[0]"',
        },
      ]),
    },
    {
      name: "groups",
      resolved:
        groups !== undefined
          ? { value: groups, source: groupsSource }
          : undefined,
    },
    {
      name: "plan",
      resolved: firstDefined([
        { value: str(metadata.plan), source: "metadata.plan" },
        { value: str(claims?.plan), source: 'JWT claim "plan"' },
        {
          value: str(claims?.subscription),
          source: 'JWT claim "subscription"',
        },
      ]),
    },
    {
      name: "language",
      resolved: firstDefined([
        { value: str(metadata.language), source: "metadata.language" },
        { value: firstLang, source: "Accept-Language header" },
      ]),
    },
    {
      name: "clientId",
      resolved: firstDefined([
        { value: str(metadata.clientId), source: "metadata.clientId" },
        {
          value: str(claims?.client_id),
          source: 'JWT claim "client_id"',
        },
        { value: str(claims?.tid), source: 'JWT claim "tid"' },
      ]),
    },
    {
      name: "userId",
      resolved: firstDefined([
        { value: str(claims?.sub), source: 'JWT claim "sub"' },
        { value: str(owui?.id), source: "OWUI header X-OpenWebUI-User-Id" },
      ]),
    },
    {
      name: "userName",
      resolved: firstDefined([
        { value: str(claims?.name), source: 'JWT claim "name"' },
        {
          value: str(claims?.preferred_username),
          source: 'JWT claim "preferred_username"',
        },
        { value: owuiName, source: "OWUI header X-OpenWebUI-User-Name" },
      ]),
    },
    {
      name: "userEmail",
      resolved: firstDefined([
        { value: str(claims?.email), source: 'JWT claim "email"' },
        {
          value: str(owui?.email),
          source: "OWUI header X-OpenWebUI-User-Email",
        },
        { value: str(metadata.email), source: "metadata.email" },
      ]),
    },
  ];

  const pad = (s: string): string => s.padEnd(10);
  const idLines = fields.map((f) => {
    if (f.resolved === undefined) return `  ${pad(f.name)} = (not set)`;
    return `  ${pad(f.name)} = ${formatVarValue(f.resolved.value)}   ← ${f.resolved.source}`;
  });

  const params = opts.requestParams ?? {};
  const paramKeys = Object.keys(params);
  const paramLines =
    paramKeys.length > 0
      ? paramKeys.map((k) => `  ${pad(k)} = ${formatVarValue(params[k])}`)
      : ["  (none)"];

  const scopeValues = (value: unknown): string[] => {
    if (typeof value === "string") {
      return value
        .split(/[\s,]+/u)
        .map((scope) => scope.trim())
        .filter(Boolean);
    }
    if (Array.isArray(value)) {
      return value.filter(
        (scope): scope is string => typeof scope === "string" && scope.trim() !== "",
      );
    }
    return [];
  };
  const scopes = [...new Set([...scopeValues(claims?.scope), ...scopeValues(claims?.scp)])];
  const scopeSource =
    claims?.scope !== undefined && claims?.scp !== undefined
      ? 'JWT claims "scope" + "scp"'
      : claims?.scope !== undefined
        ? 'JWT claim "scope"'
        : claims?.scp !== undefined
          ? 'JWT claim "scp"'
          : undefined;

  const claimNames = claims !== null ? Object.keys(claims) : [];
  const claimLines =
    claims !== null && claimNames.length > 0
      ? Object.entries(claims).map(
          ([name, value]) => `  ${pad(name)} = ${formatInlineVarValue(value)}`,
        )
      : ["  (no decodable JWT claims)"];
  const claimLine =
    claimNames.length > 0 ? claimNames.join(", ") : "(no decodable JWT claims)";

  return [
    "Identity & routing attributes (usable in dispatch whenRole/whenGroup/",
    "whenPlan/whenLanguage and access policies):",
    ...idLines,
    "",
    "Request params (usable in dispatch `whenParam` + router/edge conditions):",
    ...paramLines,
    "",
    "OAuth scopes (JWT claims; diagnostics only):",
    `  scopes     = ${formatVarValue(scopes)}${scopeSource !== undefined ? `   ← ${scopeSource}` : ""}`,
    "",
    "JWT claim values (decoded; diagnostics only):",
    ...claimLines,
    "",
    "JWT claim names (usable in dispatch `whenClaim` expressions):",
    `  ${claimLine}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// RequestContext builder
// ---------------------------------------------------------------------------

/**
 * A client-supplied identity attribute that was rejected or overridden while
 * resolving the RequestContext. Surfaced so the caller can log it — an attempt
 * to assert `role: admin` or another tenant's id is a security-relevant event,
 * not a routine fallback.
 */
export interface IdentityTrustWarning {
  /** Which RequestContext field the conflict concerned. */
  field: "role" | "clientId" | "plan" | "email" | "userId" | "userName";
  /** Where the rejected value came from. */
  source: string;
  /** The asserted value, retained for callbacks; profile values are redacted from logs. */
  clientValue: string;
  /** The authoritative claim value, when the token carried one. */
  claimValue?: string;
  /**
   * `overridden` — a verified claim existed and won.
   * `rejected`   — no claim existed and client identity is not trusted, so the
   *                field stays unset rather than being client-controlled.
   */
  action: "overridden" | "rejected";
}

/**
 * Resolves ONE security-relevant identity attribute under a fixed precedence:
 * verified JWT claims first, client-supplied value only as a fallback and only
 * when client identity is trusted.
 *
 * Pure, so the precedence rule itself is unit-testable without an HTTP request.
 *
 * ## Why the claim must win unconditionally
 *
 * `role`, `clientId` and `plan` are read by authorization decisions
 * (`flows/access.yaml` `allowRoles`/`allowTenants`/`allowPlans`, tool-authz
 * `match.role`) and by BYOK key resolution plus cost attribution. Letting an
 * HTTP header outrank a cryptographically verified claim means a caller with a
 * valid *user* token can satisfy an admin-only rule by adding a header, or bill
 * its traffic to — and use the provider key of — another tenant. The claim is
 * the only value an attacker cannot choose, so it is the only value that may
 * decide access.
 *
 * ## Why the fallback is gated rather than removed
 *
 * Not every IdP emits a tenant or role claim, and Open WebUI legitimately
 * forwards its user attributes as headers. That deployment stays supported via
 * `TRUSTED_IDENTITY_HEADERS=true`, which is only sound when a reverse proxy
 * strips these headers from inbound client requests. The precedence above is
 * NOT relaxed by the flag — a verified claim still wins.
 */
export function resolveTrustedIdentityField(opts: {
  field: IdentityTrustWarning["field"];
  /** Candidate values read from verified token claims, in precedence order. */
  claimCandidates: { value: unknown; source: string }[];
  /** The client-asserted value (header or request-body metadata). */
  clientValue: unknown;
  clientSource: string;
  /** Whether client-supplied identity attributes may be used at all. */
  trustClientIdentity: boolean;
}): { value?: string; warning?: IdentityTrustWarning } {
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v !== "" ? v : undefined;

  const claimValue = (() => {
    for (const candidate of opts.claimCandidates) {
      const v = str(candidate.value);
      if (v !== undefined) return v;
    }
    return undefined;
  })();
  const clientValue = str(opts.clientValue);

  // 1. A verified claim is authoritative.
  if (claimValue !== undefined) {
    // Only worth reporting when the client tried to assert something ELSE. An
    // identical value is the normal proxy case and would be pure log noise.
    if (clientValue !== undefined && clientValue !== claimValue) {
      return {
        value: claimValue,
        warning: {
          field: opts.field,
          source: opts.clientSource,
          clientValue,
          claimValue,
          action: "overridden",
        },
      };
    }
    return { value: claimValue };
  }

  // 2. No claim. The client value is usable only when explicitly trusted.
  if (clientValue === undefined) return {};
  if (opts.trustClientIdentity) return { value: clientValue };

  return {
    warning: {
      field: opts.field,
      source: opts.clientSource,
      clientValue,
      action: "rejected",
    },
  };
}

/**
 * Writes an {@link IdentityTrustWarning} as a structured warning line.
 *
 * Deliberately a plain stderr write in the same one-JSON-object-per-line shape
 * the app logger uses, rather than taking a `Logger` dependency: both call
 * sites sit on the hot request path of a module that is otherwise pure, and a
 * rejected identity assertion must be recorded even in a deployment that
 * configured no logger.
 *
 * Role, tenant and plan assertions are logged verbatim because operators need
 * them to diagnose proxy policy. Profile values are deliberately omitted from
 * JSONL output: source/field/action are sufficient and avoid logging PII.
 */
export function logIdentityTrustWarning(warning: IdentityTrustWarning): void {
  const isStrictProfileField =
    warning.field === "email" ||
    warning.field === "userId" ||
    warning.field === "userName";
  const message =
    warning.action === "overridden"
      ? `Client asserted a different "${warning.field}" than the verified token claim — the claim wins.`
      : isStrictProfileField
        ? `Rejected client-asserted "${warning.field}": STRICT_IDENTITY_HEADERS permits only verified principal values.`
        : `Rejected client-asserted "${warning.field}": the token carries no such claim and TRUSTED_IDENTITY_HEADERS is not enabled.`;
  try {
    process.stderr.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        message,
        event: "identity_trust_conflict",
        field: warning.field,
        source: warning.source,
        action: warning.action,
        // Profile assertions can contain PII. Keep the structured source/action
        // signal while avoiding values; role/tenant/plan logging stays unchanged.
        ...(!isStrictProfileField
          ? {
              client_value: warning.clientValue,
              ...(warning.claimValue !== undefined
                ? { claim_value: warning.claimValue }
                : {}),
            }
          : {}),
      })}\n`,
    );
  } catch {
    /* never fail a request because a log write failed */
  }
}

/**
 * Builds a fully-enriched RequestContext from the HTTP request, the decoded JWT
 * and the request body metadata.
 *
 * `role`, `clientId` and `plan` are resolved through
 * {@link resolveTrustedIdentityField} — verified claims win, client-supplied
 * values are a gated fallback. Any conflict is reported via
 * `onIdentityWarning` so the route can log it.
 */
export function buildRequestContext(opts: {
  ssoToken: string;
  claims: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  acceptLanguage?: string;
  owui?: {
    id?: string;
    name?: string;
    email?: string;
    role?: string;
  };
  /** See `TRUSTED_IDENTITY_HEADERS`. Defaults to false (fail-closed). */
  trustClientIdentity?: boolean;
  /**
   * When true, email/userId/userName may only use verified principal claims;
   * OWUI and metadata fallbacks are rejected. Defaults to false for compatibility.
   */
  strictIdentityHeaders?: boolean;
  /** Whether `claims` were cryptographically verified by auth middleware. */
  identityClaimsVerified?: boolean;
  /** Called once per rejected/overridden client-asserted identity attribute. */
  onIdentityWarning?: (warning: IdentityTrustWarning) => void;
  /**
   * Tenant identity resolved from an `aip-…` API key, when the request
   * authenticated that way.
   *
   * Ranks ABOVE every other source for `clientId`/`plan`: it comes from a hash
   * lookup against the tenant store, so — unlike a JWT claim (which at least
   * needs a verifier configured) or a client header (which needs
   * TRUSTED_IDENTITY_HEADERS) — it cannot be influenced by the caller at all.
   * The key IS the tenant.
   */
  /** Tenant already resolved by the authentication middleware. */
  verifiedTenantId?: string;
  apiKeyIdentity?: {
    tenantId: string;
    tenantName: string;
    plan: string;
  };
}): RequestContext {
  const { ssoToken, claims, metadata, owui } = opts;
  const trustClientIdentity = opts.trustClientIdentity ?? false;
  const strictIdentityHeaders = opts.strictIdentityHeaders ?? false;
  const profileClaims =
    !strictIdentityHeaders || opts.identityClaimsVerified === true
      ? claims
      : null;
  const apiKeyIdentity = opts.apiKeyIdentity;

  const identityWarnings: IdentityTrustWarning[] = [];
  const resolveIdentity = (
    field: IdentityTrustWarning["field"],
    claimCandidates: { value: unknown; source: string }[],
    clientValue: unknown,
    clientSource: string,
  ): string | undefined => {
    const { value, warning } = resolveTrustedIdentityField({
      field,
      claimCandidates,
      clientValue,
      clientSource,
      trustClientIdentity,
    });
    if (warning !== undefined) identityWarnings.push(warning);
    return value;
  };

  const owuiName = (() => {
    if (owui?.name === undefined || owui.name === "") return undefined;
    try {
      return decodeURIComponent(owui.name);
    } catch {
      return owui.name;
    }
  })();

  // ----- role ----- (verified JWT claim wins; OWUI header only when trusted)
  const role = resolveIdentity(
    "role",
    [
      { value: claims?.role, source: 'JWT claim "role"' },
      {
        value: Array.isArray(claims?.roles)
          ? claims.roles[0]
          : undefined,
        source: 'JWT claim "roles[0]"',
      },
    ],
    owui?.role,
    "OWUI header X-OpenWebUI-User-Role",
  );

  // ----- groups -----
  let groups: string[] | undefined;
  const rawGroups = claims?.groups ?? claims?.group;
  if (Array.isArray(rawGroups)) {
    groups = rawGroups.filter((g): g is string => typeof g === "string");
  } else if (typeof rawGroups === "string") {
    groups = [rawGroups];
  }

  const resolveStrictProfile = (
    field: "email" | "userId" | "userName",
    claimCandidates: unknown[],
    clientCandidates: Array<{ value: unknown; source: string }>,
  ): string | undefined => {
    const authoritative = claimCandidates.find(
      (value): value is string => typeof value === "string" && value !== "",
    );
    for (const candidate of clientCandidates) {
      if (typeof candidate.value !== "string" || candidate.value === "") continue;
      if (authoritative !== undefined && candidate.value === authoritative) continue;
      identityWarnings.push({
        field,
        source: candidate.source,
        clientValue: candidate.value,
        ...(authoritative !== undefined ? { claimValue: authoritative } : {}),
        action: authoritative !== undefined ? "overridden" : "rejected",
      });
    }
    return authoritative;
  };

  // ----- email ----- (legacy: JWT > OWUI > metadata; strict: verified JWT only)
  const userEmail = strictIdentityHeaders
    ? resolveStrictProfile(
        "email",
        [profileClaims?.email],
        [
          { value: owui?.email, source: "OWUI header X-OpenWebUI-User-Email" },
          { value: metadata.email, source: "metadata.email" },
        ],
      )
    : (typeof claims?.email === "string" ? claims.email : undefined) ??
      (typeof owui?.email === "string" && owui.email !== ""
        ? owui.email
        : undefined) ??
      (typeof metadata.email === "string" ? metadata.email : undefined);

  // ----- userId ----- (legacy: JWT sub > OWUI; strict: verified JWT only)
  const userId = strictIdentityHeaders
    ? resolveStrictProfile(
        "userId",
        [profileClaims?.sub],
        [{ value: owui?.id, source: "OWUI header X-OpenWebUI-User-Id" }],
      )
    : (typeof claims?.sub === "string" ? claims.sub : undefined) ??
      (typeof owui?.id === "string" && owui.id !== "" ? owui.id : undefined);

  // ----- userName -----
  // Legacy keeps JWT > OWUI > resolved email/id exactly. Strict mode permits
  // only verified profile fields: name/preferred_username first, then the
  // already-resolved verified email or subject. OWUI/metadata never feed it.
  const userName = strictIdentityHeaders
    ? resolveStrictProfile(
        "userName",
        [profileClaims?.name, profileClaims?.preferred_username],
        [{ value: owuiName, source: "OWUI header X-OpenWebUI-User-Name" }],
      ) ?? userEmail ?? userId
    : (typeof claims?.name === "string" ? claims.name : undefined) ??
      (typeof claims?.preferred_username === "string"
        ? (claims.preferred_username as string)
        : undefined) ??
      owuiName ??
      userEmail ??
      userId;

  // ----- client ----- (verified claim wins; body metadata only when trusted)
  //
  // This is the highest-impact field of the three: it selects the tenant's BYOK
  // provider key, the budget the run is charged against, and the `tenant_id`
  // every tenant-scoped store filters on. A client-chosen value here is a
  // cross-tenant boundary crossing, not a routing hint.
  const clientId = resolveIdentity(
    "clientId",
    [
      // Listed first: an API key resolves to exactly one tenant via a hash
      // lookup against the tenant store, so it is the strongest evidence
      // available and must not be overridable by anything the caller sends.
      { value: opts.verifiedTenantId, source: "verified principal" },
      { value: apiKeyIdentity?.tenantId, source: "API key (aip-…)" },
      { value: claims?.client_id, source: 'JWT claim "client_id"' },
      { value: claims?.tid, source: 'JWT claim "tid"' },
    ],
    metadata.clientId,
    "metadata.clientId",
  );

  // ----- language -----
  // Deliberately NOT gated like role/clientId/plan: a language preference
  // cannot be derived from a token, so requiring a claim would break i18n for
  // every deployment. Consequently `allowLanguages` in flows/access.yaml is a
  // routing convenience, NOT a security boundary — it is client-controlled by
  // construction. Do not use it as the only constraint on a sensitive flow.
  const language =
    (typeof metadata.language === "string"
      ? metadata.language
      : undefined) ??
    (opts.acceptLanguage
      ? opts.acceptLanguage.split(",")[0]?.split(";")[0]?.trim()
      : undefined);

  // ----- plan ----- (verified claim wins; body metadata only when trusted)
  // Read by `flows/access.yaml` `allowPlans`, so a client-chosen plan would let
  // a free-tier caller into a rule reserved for a paid one.
  const plan = resolveIdentity(
    "plan",
    [
      // Same reasoning as clientId: the key's tenant record carries the plan.
      { value: apiKeyIdentity?.plan, source: "API key (aip-…)" },
      { value: claims?.plan, source: 'JWT claim "plan"' },
      { value: claims?.subscription, source: 'JWT claim "subscription"' },
    ],
    metadata.plan,
    "metadata.plan",
  );

  // ----- conversation identifiers -----
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v !== "" ? v : undefined;
  const metadataChatId = str(metadata.chat_id);
  const metadataSessionId = str(metadata.session_id);
  const conversationId =
    str(metadata.conversation_id) ?? metadataChatId ?? metadataSessionId;
  const chatId = metadataChatId ?? crypto.randomUUID();
  const sessionId = metadataSessionId ?? crypto.randomUUID();
  // Transaction authorization must be bound only to a session asserted by the
  // verified bearer. OpenWebUI's metadata.session_id is merely a client-side
  // chat/socket correlation id and can differ from the authenticated session.
  const authenticatedSessionId = str(claims?.sid) ?? str(claims?.session_id);
  const messageId = str(metadata.message_id) ?? crypto.randomUUID();

  // ----- requestParams: metadata minus known/internal keys -----
  const RESERVED_KEYS = new Set([
    "token",
    "email",
    "clientId",
    "language",
    "plan",
    "variables",
  ]);
  const requestParams: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (!RESERVED_KEYS.has(k)) {
      requestParams[k] = v;
    }
  }
  // OpenWebUI identifies a conversation with `chat_id` (and some clients only
  // provide `session_id`), while the graph checkpointer consumes
  // `conversation_id`. Normalize those equivalent client identifiers here so
  // follow-up turns use the same LangGraph thread instead of starting from an
  // empty state on every request. An explicit conversation_id always wins.
  if (conversationId !== undefined) {
    requestParams.conversation_id = conversationId;
  }

  // Report identity conflicts AFTER all fields are resolved, so a request that
  // asserts several attributes produces one warning per field rather than
  // aborting on the first. A throwing sink must not break the request.
  if (opts.onIdentityWarning !== undefined) {
    for (const warning of identityWarnings) {
      try {
        opts.onIdentityWarning(warning);
      } catch {
        /* observability must never fail a request */
      }
    }
  }

  return {
    ssoToken,
    executionId: crypto.randomUUID(),
    userEmail,
    userId,
    userName,
    clientId,
    chatId,
    sessionId,
    authenticatedSessionId,
    messageId,
    claims: claims ?? undefined,
    role,
    groups,
    language,
    plan,
    requestParams:
      Object.keys(requestParams).length > 0 ? requestParams : undefined,
  };
}

// ---------------------------------------------------------------------------
// Flow model collection
// ---------------------------------------------------------------------------

/**
 * Statically enumerates the models a flow may use, from its nodes' `llm`
 * config. Used to match model-specific token limits at admission.
 */
export function collectFlowModels(flow: FlowDefinition | undefined): string[] {
  if (flow === undefined) return [];
  const models = new Set<string>();
  for (const node of flow.nodes) {
    const m = node.llm?.model;
    if (typeof m === "string" && m !== "") models.add(m);
  }
  return [...models];
}

/**
 * Collects the distinct LLM configs (provider+model) statically declared
 * across a flow's nodes, deduplicated. Used by the compliance policy check
 * (`checkCompliancePolicy` in `chat/metering.ts`) to evaluate data/model
 * rules against every model the flow could call.
 *
 * Same limitation as `collectFlowModels`: a node that omits `llm` (falling
 * back to the deployment's global default) is not represented, since the
 * effective model then depends on runtime config not visible from the flow
 * definition alone.
 */
export function collectFlowLlmConfigs(
  flow: FlowDefinition | undefined,
): LlmConfig[] {
  if (flow === undefined) return [];
  const seen = new Set<string>();
  const configs: LlmConfig[] = [];
  for (const node of flow.nodes) {
    const llm = node.llm;
    if (llm === undefined) continue;
    const key = `${llm.provider}/${llm.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    configs.push(llm);
  }
  return configs;
}

// ---------------------------------------------------------------------------
// User prompt preview extraction
// ---------------------------------------------------------------------------

/**
 * Extracts a short, human-readable preview of the end user's prompt.
 */
export function extractUserPromptPreview(
  messages: ChatCompletionRequest["messages"],
): string | undefined {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (lastUser === undefined) return undefined;
  const text =
    typeof lastUser.content === "string"
      ? lastUser.content
      : Array.isArray(lastUser.content)
        ? lastUser.content
            .map((b) => {
              const bb = b as { type?: string; text?: string };
              return bb.type === "text" ? (bb.text ?? "") : "";
            })
            .join(" ")
        : "";
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > USER_PROMPT_PREVIEW_LIMIT
    ? `${trimmed.slice(0, USER_PROMPT_PREVIEW_LIMIT)}…`
    : trimmed;
}

// ---------------------------------------------------------------------------
// Boundary node emission
// ---------------------------------------------------------------------------

/** Emits a boundary node lifecycle (single completed/error event). */
export function emitBoundaryNode(
  monitoring: MonitoringServiceInterface | undefined,
  executionId: string,
  meta: { flowId?: string; tenantId?: string },
  node: {
    nodeId: string;
    sequence?: number;
    hadError?: boolean;
    prompt?: string;
    response?: string;
    userName?: string;
    userPrompt?: string;
    userId?: string;
  },
): void {
  if (monitoring === undefined) return;
  const now = new Date().toISOString();
  monitoring.emitNodeEvent(
    executionId,
    {
      execution_id: executionId,
      node_id: node.nodeId,
      status: node.hadError === true ? "error" : "completed",
      start_time: now,
      end_time: now,
      latency_ms: 0,
      ...(meta.flowId !== undefined ? { flow_id: meta.flowId } : {}),
      ...(node.sequence !== undefined ? { sequence: node.sequence } : {}),
      ...(node.prompt !== undefined ? { prompt: node.prompt } : {}),
      ...(node.response !== undefined ? { response: node.response } : {}),
      ...(node.userName !== undefined ? { user_name: node.userName } : {}),
      ...(node.userPrompt !== undefined
        ? { user_prompt: node.userPrompt }
        : {}),
      ...(node.userId !== undefined ? { user_id: node.userId } : {}),
    },
    meta,
  );
}
