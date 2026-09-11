// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * config.ts
 *
 * Application configuration: type definition and environment variable parsing.
 *
 * Every variable is parsed here with an explicit default, a range check and
 * cross-constraint validation, and the process fails fast on startup with a
 * descriptive message. Extract has its own environment contract: names that also
 * exist in Search or Runtime are NOT shared, except the access-control block
 * (`AUTHN_MODE`, `OIDC_*`, `UI_*`, …) which is deliberately identical so an
 * operator configures SSO once for the whole fabric.
 */

import { PAGE_LABELS, type PageLabel } from "@atf/extract-contract";

export interface UiBffConfig {
  /** Server-selected tenant for every verified browser session. */
  tenantId: string;
  /** Server-selected operation scopes; OIDC scopes are never promoted. */
  scopes: string[];
  /** Optional allowlist applied to groups from the verified ID token. */
  allowedGroups: string[];
  /** Exact group required in addition to admin scopes for UI administration. */
  operatorGroup: string | null;
}

export interface ApiOidcIssuerConfig {
  /** Issuer URL — builds the discovery URL and validates the `iss` claim. */
  issuer: string;
  /**
   * Expected `aud` claim. When omitted, audience validation is skipped, which
   * means a token the same IdP minted for a *different* service authenticates
   * here. The production gate flags that.
   */
  audience?: string;
  /** Claim carrying the end-user identity. Default: `sub`. */
  userClaim?: string;
  /** Claim carrying group membership. Default: `groups`. */
  groupsClaim?: string;
  /** Claim carrying the tenant partition. */
  tenantClaim?: string;
  /** Claim carrying permissions as a string or string array. */
  scopesClaim?: string;
  /** Optional claim for client-id binding. */
  clientIdClaim?: string;
}

/**
 * OpenID Connect configuration for browser-based UI login.
 *
 * Identical in shape to Search's so the same IdP client can serve both.
 */
export interface OidcConfig {
  /** OIDC_ISSUER — issuer URL, used for discovery and `iss` validation. */
  issuer: string;
  /** OIDC_CLIENT_ID — registered client identifier. */
  clientId: string;
  /** OIDC_CLIENT_SECRET — client secret for the token exchange. */
  clientSecret: string;
  /** OIDC_REDIRECT_URI — exact callback URL; derived per request when null. */
  redirectUri: string | null;
  /** OIDC_SCOPES — space-separated scopes. Default: "openid profile email". */
  scopes: string;
  /** OIDC_SESSION_SECRET — HMAC secret signing session/transaction cookies. */
  sessionSecret: string;
  /** OIDC_ALLOWED_EMAILS — allow-list of exact addresses (empty = any). */
  allowedEmails: string[];
  /** OIDC_ALLOWED_EMAIL_DOMAINS — allow-list of domains (empty = any). */
  allowedEmailDomains: string[];
  /** OIDC_GROUPS_CLAIM — ID-token claim carrying group membership. */
  groupsClaim: string;
  /** OIDC_SESSION_TTL — session lifetime in seconds. Default: 28 800 (8 h). */
  sessionTtlSeconds: number;
}

/** Where converted documents are pushed when ingest is requested. */
export interface SearchTargetConfig {
  /** SEARCH_URL — base URL of the @atf/search service. */
  url: string;
  /** SEARCH_TOKEN — Bearer credential presented to Search. */
  token: string | null;
  /** SEARCH_COLLECTION — target collection. */
  collection: string;
  /** SEARCH_TIMEOUT_MS — per-request timeout. */
  timeoutMs: number;
  /** SEARCH_UPLOAD_ASSETS — push figure crops to /document-assets. */
  uploadAssets: boolean;
}

export interface Config {
  // ── Server ────────────────────────────────────────────────────────────────
  port: number; // PORT (default: 3004)
  nodeEnv: string; // NODE_ENV (default: "development")
  logLevel: string; // LOG_LEVEL (default: "info")
  /** PUBLIC_URL — external base URL, used for OIDC redirects behind a proxy. */
  publicUrl: string | null; // PUBLIC_URL

  // ── Vision model ──────────────────────────────────────────────────────────
  /** VISION_URL — base URL of an OpenAI-compatible chat-completions API. */
  visionUrl: string; // VISION_URL (required)
  visionModel: string; // VISION_MODEL (required)
  /**
   * VISION_API_KEY — optional, because a self-hosted vLLM behind the cluster
   * network commonly has no auth. Omitted means no Authorization header.
   */
  visionApiKey: string | null; // VISION_API_KEY
  /**
   * VISION_TIMEOUT_MS — per-page timeout. Default 600 s: a dense A4 page on a
   * local 27B vision model routinely takes two to four minutes, and cutting it
   * off wastes the whole page. 0 disables the timeout.
   */
  visionTimeoutMs: number; // VISION_TIMEOUT_MS (default: 600000, 0=disabled)
  visionTemperature: number; // VISION_TEMPERATURE (default: 0.1)
  visionTopP: number; // VISION_TOP_P (default: 1.0)
  /**
   * VISION_MAX_TOKEN_VARIANTS — escalating output budgets, tried in order when
   * the model stops with `finish_reason: "length"`. A truncated page is a
   * silently corrupted page, so retrying with more room is the only correct
   * response; starting at the largest budget instead would slow every page down.
   */
  visionMaxTokenVariants: number[]; // VISION_MAX_TOKEN_VARIANTS (default: 8192,16384,32768)
  /** VISION_MAX_RETRIES — transient-failure retries per token budget. */
  visionMaxRetries: number; // VISION_MAX_RETRIES (default: 3)
  /**
   * VISION_REASONING_EFFORT — forwarded as `chat_template_kwargs` for models
   * that support a thinking budget. Unset means the field is not sent, which
   * matters because strict servers reject unknown fields.
   */
  visionReasoningEffort: string | null; // VISION_REASONING_EFFORT
  /** VISION_INPUT_TOKEN_COST — USD per million input tokens, for reporting. */
  visionInputTokenCost: number; // VISION_INPUT_TOKEN_COST (default: 0.15)
  /** VISION_OUTPUT_TOKEN_COST — USD per million output tokens. */
  visionOutputTokenCost: number; // VISION_OUTPUT_TOKEN_COST (default: 0.6)

  // ── Rendering ─────────────────────────────────────────────────────────────
  /**
   * RENDER_DPI — resolution the page is rasterised at for the vision model.
   * 200 is the knee of the curve: below it small table text stops being legible,
   * above it the image cost grows without improving transcription.
   */
  renderDpi: number; // RENDER_DPI (default: 200)
  /**
   * FIGURE_DPI — resolution figure crops are rendered at. Higher than
   * RENDER_DPI on purpose: a crop is shown to a human in a search result, and
   * re-rendering the page is cheap next to a vision call.
   */
  figureDpi: number; // FIGURE_DPI (default: 300)
  /** MAX_PAGES — refuse documents longer than this. 0 disables the limit. */
  maxPages: number; // MAX_PAGES (default: 0, 0=unlimited)
  /** TEMP_DIR — scratch space for rendered pages and converted PDFs. */
  tempDir: string; // TEMP_DIR (default: "/tmp/atf-extract")
  /** PAGE_LABEL — page-marker label emitted in the canonical Markdown. */
  pageLabel: PageLabel; // PAGE_LABEL (default: "Seite")
  /** LIBREOFFICE_BIN — binary used to convert DOCX/XLSX to PDF. */
  libreofficeBin: string; // LIBREOFFICE_BIN (default: "libreoffice")
  /** POPPLER_BIN_DIR — directory holding pdfinfo/pdftotext/pdftoppm. */
  popplerBinDir: string | null; // POPPLER_BIN_DIR

  // ── Limits ────────────────────────────────────────────────────────────────
  /** MAX_UPLOAD_BYTES — largest accepted upload. Default 50 MiB. */
  maxUploadBytes: number; // MAX_UPLOAD_BYTES (default: 52428800)
  /** BODY_LIMIT — limit for JSON/text request bodies. */
  bodyLimit: string; // BODY_LIMIT (default: "1mb")
  /**
   * CONVERT_CONCURRENCY — documents converted at once. Kept low because each
   * one holds a LibreOffice process and a page's worth of image buffers.
   */
  convertConcurrency: number; // CONVERT_CONCURRENCY (default: 2)
  /** PAGE_CONCURRENCY — pages of one document in flight against the model. */
  pageConcurrency: number; // PAGE_CONCURRENCY (default: 4)
  /** QUEUE_MAX_DEPTH — queued documents before new uploads get 503. */
  queueMaxDepth: number; // QUEUE_MAX_DEPTH (default: 32)
  rateLimit: number; // RATE_LIMIT req/min/IP (default: 120, 0=disabled)
  /** CALLBACK_MAX_RETRIES — delivery attempts for an async conversion result. */
  callbackMaxRetries: number; // CALLBACK_MAX_RETRIES (default: 3)
  /** CALLBACK_TIMEOUT_MS — per-attempt timeout for callback delivery. */
  callbackTimeoutMs: number; // CALLBACK_TIMEOUT_MS (default: 30000)
  /**
   * CALLBACK_ALLOWED_HOSTS — allowlist for `X-Callback-URL` hosts. An entry
   * beginning with `.` matches any subdomain.
   *
   * Empty permits any host, because an internal orchestrator on an arbitrary
   * cluster DNS name is the normal case. `X-Callback-URL` is a server-side
   * request forgery primitive, so the production gate flags the empty list.
   */
  callbackAllowedHosts: string[]; // CALLBACK_ALLOWED_HOSTS

  // ── Search integration ────────────────────────────────────────────────────
  /** Populated only when SEARCH_URL is set; null disables /v1/ingest. */
  search: SearchTargetConfig | null;

  // ── Access ────────────────────────────────────────────────────────────────
  authnMode: AuthnMode; // AUTHN_MODE (inferred from credentials)
  apiToken: string | null; // API_TOKEN
  monitorToken: string | null; // MONITOR_TOKEN
  apiOidcIssuers: ApiOidcIssuerConfig[]; // API_OIDC_ISSUERS (JSON array)
  authzEnabled: boolean; // AUTHZ_ENABLED (default: true)
  tenantIsolationEnabled: boolean; // TENANT_ISOLATION_ENABLED (default: true)
  defaultTenantId: string; // DEFAULT_TENANT_ID (default: "default")
  /** API_SERVICE_SCOPES — scopes granted to a static-token caller. */
  apiServiceScopes: string[]; // API_SERVICE_SCOPES
  /** API_SERVICE_TENANT_ID — tenant a static-token caller acts in. */
  apiServiceTenantId: string | undefined; // API_SERVICE_TENANT_ID
  trustProxy: boolean; // TRUST_PROXY (default: false)
  exposeErrorDetail: boolean; // EXPOSE_ERROR_DETAIL (default: false)
  oidc: OidcConfig | null; // OIDC_* (opt-in via OIDC_ISSUER)
  uiBff: UiBffConfig; // UI_*
}

/** Credentials the API accepts. */
export type AuthnMode = "disabled" | "token" | "oidc" | "token_or_oidc";

/** Operation scopes this service authorises against. */
export const EXTRACT_SCOPES = [
  "extract.convert",
  "extract.ingest",
  "extract.metrics",
  "extract.admin",
] as const;

export function loadConfig(): Config {
  // ── Env-var parse helpers ───────────────────────────────────────────────────
  // Each reads one variable, applies a default, validates, and throws a
  // descriptive Error. Same helper set as apps/search/src/config.ts so the two
  // services reject bad input identically.

  function requireString(name: string): string {
    const v = process.env[name] ?? "";
    if (!v) throw new Error(`Missing required environment variable: ${name}`);
    return v;
  }

  function optionalString(name: string, fallback?: string): string | null {
    const v = (process.env[name] ?? "").trim();
    if (!v) return fallback !== undefined ? fallback : null;
    return v;
  }

  function parseIntEnv(
    name: string,
    defaultVal: number,
    opts: { min?: number; max?: number } = {},
  ): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return defaultVal;
    const parsed = Number.parseInt(raw, 10);
    const { min = 1, max } = opts;
    if (
      !Number.isInteger(parsed) ||
      parsed < min ||
      (max !== undefined && parsed > max)
    ) {
      const range = max !== undefined ? `between ${min} and ${max}` : `>= ${min}`;
      throw new Error(
        `${name} must be an integer ${range}` + (min === 0 ? " (or 0 to disable)" : ""),
      );
    }
    return parsed;
  }

  function parseNonNegIntEnv(name: string, defaultVal: number): number {
    return parseIntEnv(name, defaultVal, { min: 0 });
  }

  function parseFloatEnv(
    name: string,
    defaultVal: number,
    range?: { min: number; max: number },
  ): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return defaultVal;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${name} must be a finite number`);
    }
    if (range && (parsed < range.min || parsed > range.max)) {
      throw new Error(`${name} must be between ${range.min} and ${range.max}`);
    }
    return parsed;
  }

  function parseBoolEnv(name: string, defaultVal: boolean): boolean {
    const raw = (process.env[name] ?? "").trim().toLowerCase();
    if (!raw) return defaultVal;
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
    return defaultVal;
  }

  function parseEnumEnv<T extends string>(
    name: string,
    allowed: readonly T[],
    defaultVal: T,
  ): T {
    const raw = (process.env[name] ?? "").trim().toLowerCase() as T;
    if (!raw) return defaultVal;
    if (allowed.includes(raw)) return raw;
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }

  function parseCsvEnv(name: string): string[] {
    const raw = (process.env[name] ?? "").trim();
    if (!raw) return [];
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /** Ascending, de-duplicated positive integers. */
  function parseIntListEnv(name: string, defaultVal: number[]): number[] {
    const raw = parseCsvEnv(name);
    if (raw.length === 0) return defaultVal;
    const parsed = raw.map((value) => {
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`${name} must be a comma-separated list of positive integers`);
      }
      return n;
    });
    return [...new Set(parsed)].sort((a, b) => a - b);
  }

  /**
   * OIDC is opt-in: an empty OIDC_ISSUER disables the whole feature. When the
   * issuer is present the remaining required fields must be too, so a
   * half-configured provider can never silently do nothing.
   */
  function parseOidcConfig(): OidcConfig | null {
    const issuer = optionalString("OIDC_ISSUER");
    if (!issuer) return null;

    const clientId = optionalString("OIDC_CLIENT_ID");
    const clientSecret = optionalString("OIDC_CLIENT_SECRET");
    const sessionSecret = optionalString("OIDC_SESSION_SECRET");

    const missing: string[] = [];
    if (!clientId) missing.push("OIDC_CLIENT_ID");
    if (!clientSecret) missing.push("OIDC_CLIENT_SECRET");
    if (!sessionSecret) missing.push("OIDC_SESSION_SECRET");
    if (missing.length > 0) {
      throw new Error(`OIDC is enabled (OIDC_ISSUER set) but missing: ${missing.join(", ")}`);
    }
    if ((sessionSecret as string).length < 16) {
      throw new Error("OIDC_SESSION_SECRET must be at least 16 characters for HMAC signing");
    }

    return {
      issuer: issuer.replace(/\/+$/, ""),
      clientId: clientId as string,
      clientSecret: clientSecret as string,
      redirectUri: optionalString("OIDC_REDIRECT_URI"),
      scopes: optionalString("OIDC_SCOPES") ?? "openid profile email",
      sessionSecret: sessionSecret as string,
      allowedEmails: parseCsvEnv("OIDC_ALLOWED_EMAILS").map((e) => e.toLowerCase()),
      allowedEmailDomains: parseCsvEnv("OIDC_ALLOWED_EMAIL_DOMAINS").map((d) =>
        d.toLowerCase().replace(/^@/, ""),
      ),
      groupsClaim: optionalString("OIDC_GROUPS_CLAIM") ?? "groups",
      sessionTtlSeconds: parseIntEnv("OIDC_SESSION_TTL", 28_800, { min: 60 }),
    };
  }

  /** `[{"issuer":"https://…","audience":"atf-extract"}]` */
  function parseApiOidcIssuers(): ApiOidcIssuerConfig[] {
    const raw = (process.env["API_OIDC_ISSUERS"] ?? "").trim();
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `API_OIDC_ISSUERS: invalid JSON — ${err instanceof Error ? err.message : err}. ` +
          `Expected format: '[{"issuer":"https://...","audience":"optional-client-id"}]'`,
      );
    }
    if (!Array.isArray(parsed)) throw new Error("API_OIDC_ISSUERS must be a JSON array");
    return parsed.map((entry: unknown, i: number) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error(`API_OIDC_ISSUERS[${i}]: each entry must be an object`);
      }
      const e = entry as Record<string, unknown>;
      if (typeof e["issuer"] !== "string" || !e["issuer"].trim()) {
        throw new Error(`API_OIDC_ISSUERS[${i}]: "issuer" must be a non-empty string`);
      }
      for (const key of [
        "audience",
        "userClaim",
        "groupsClaim",
        "tenantClaim",
        "scopesClaim",
        "clientIdClaim",
      ]) {
        if (e[key] !== undefined && typeof e[key] !== "string") {
          throw new Error(`API_OIDC_ISSUERS[${i}]: "${key}" must be a string when present`);
        }
      }
      return {
        issuer: (e["issuer"] as string).trim(),
        ...(e["audience"] !== undefined ? { audience: e["audience"] as string } : {}),
        ...(e["userClaim"] !== undefined ? { userClaim: e["userClaim"] as string } : {}),
        ...(e["groupsClaim"] !== undefined ? { groupsClaim: e["groupsClaim"] as string } : {}),
        ...(e["tenantClaim"] !== undefined ? { tenantClaim: e["tenantClaim"] as string } : {}),
        ...(e["scopesClaim"] !== undefined ? { scopesClaim: e["scopesClaim"] as string } : {}),
        ...(e["clientIdClaim"] !== undefined
          ? { clientIdClaim: e["clientIdClaim"] as string }
          : {}),
      };
    });
  }

  /** Search is opt-in; without SEARCH_URL the /v1/ingest route is not mounted. */
  function parseSearchTarget(): SearchTargetConfig | null {
    const url = optionalString("SEARCH_URL");
    if (!url) return null;
    return {
      url: url.replace(/\/+$/, ""),
      token: optionalString("SEARCH_TOKEN"),
      collection: optionalString("SEARCH_COLLECTION") ?? "documents",
      timeoutMs: parseNonNegIntEnv("SEARCH_TIMEOUT_MS", 120_000),
      uploadAssets: parseBoolEnv("SEARCH_UPLOAD_ASSETS", true),
    };
  }

  // ── Required fields ─────────────────────────────────────────────────────────
  const visionUrl = requireString("VISION_URL").replace(/\/+$/, "");
  const visionModel = requireString("VISION_MODEL");

  // ── Server ──────────────────────────────────────────────────────────────────
  const port = parseIntEnv("PORT", 3004, { min: 1, max: 65_535 });
  const nodeEnv = process.env["NODE_ENV"] || "development";
  const logLevel = process.env["LOG_LEVEL"] || "info";
  const publicUrl = optionalString("PUBLIC_URL");

  // ── Vision model ────────────────────────────────────────────────────────────
  const visionApiKey = optionalString("VISION_API_KEY");
  const visionTimeoutMs = parseNonNegIntEnv("VISION_TIMEOUT_MS", 600_000);
  const visionTemperature = parseFloatEnv("VISION_TEMPERATURE", 0.1, { min: 0, max: 2 });
  const visionTopP = parseFloatEnv("VISION_TOP_P", 1, { min: 0, max: 1 });
  const visionMaxTokenVariants = parseIntListEnv("VISION_MAX_TOKEN_VARIANTS", [
    8192, 16_384, 32_768,
  ]);
  const visionMaxRetries = parseNonNegIntEnv("VISION_MAX_RETRIES", 3);
  const visionReasoningEffort = optionalString("VISION_REASONING_EFFORT");
  const visionInputTokenCost = parseFloatEnv("VISION_INPUT_TOKEN_COST", 0.15, {
    min: 0,
    max: 1_000,
  });
  const visionOutputTokenCost = parseFloatEnv("VISION_OUTPUT_TOKEN_COST", 0.6, {
    min: 0,
    max: 1_000,
  });

  // ── Rendering ───────────────────────────────────────────────────────────────
  const renderDpi = parseIntEnv("RENDER_DPI", 200, { min: 36, max: 1_200 });
  const figureDpi = parseIntEnv("FIGURE_DPI", 300, { min: 36, max: 1_200 });
  const maxPages = parseNonNegIntEnv("MAX_PAGES", 0);
  const tempDir = optionalString("TEMP_DIR") ?? "/tmp/atf-extract";
  const pageLabelRaw = optionalString("PAGE_LABEL") ?? "Seite";
  const pageLabel = PAGE_LABELS.find(
    (label) => label.toLowerCase() === pageLabelRaw.toLowerCase(),
  );
  if (pageLabel === undefined) {
    throw new Error(`PAGE_LABEL must be one of: ${PAGE_LABELS.join(", ")}`);
  }
  const libreofficeBin = optionalString("LIBREOFFICE_BIN") ?? "libreoffice";
  const popplerBinDir = optionalString("POPPLER_BIN_DIR");

  // ── Limits ──────────────────────────────────────────────────────────────────
  const maxUploadBytes = parseIntEnv("MAX_UPLOAD_BYTES", 52_428_800, { min: 1024 });
  const bodyLimit = process.env["BODY_LIMIT"] || "1mb";
  const convertConcurrency = parseIntEnv("CONVERT_CONCURRENCY", 2, { min: 1, max: 64 });
  const pageConcurrency = parseIntEnv("PAGE_CONCURRENCY", 4, { min: 1, max: 64 });
  const queueMaxDepth = parseIntEnv("QUEUE_MAX_DEPTH", 32, { min: 1 });
  const rateLimit = parseNonNegIntEnv("RATE_LIMIT", 120);
  const callbackMaxRetries = parseNonNegIntEnv("CALLBACK_MAX_RETRIES", 3);
  const callbackTimeoutMs = parseNonNegIntEnv("CALLBACK_TIMEOUT_MS", 30_000);
  const callbackAllowedHosts = parseCsvEnv("CALLBACK_ALLOWED_HOSTS").map((host) =>
    host.toLowerCase(),
  );

  // ── Search integration ──────────────────────────────────────────────────────
  const search = parseSearchTarget();

  // ── Access ──────────────────────────────────────────────────────────────────
  const apiToken = optionalString("API_TOKEN");
  const monitorToken = optionalString("MONITOR_TOKEN");
  const apiOidcIssuers = parseApiOidcIssuers();
  const authzEnabled = parseBoolEnv("AUTHZ_ENABLED", true);
  const tenantIsolationEnabled = parseBoolEnv("TENANT_ISOLATION_ENABLED", true);
  const defaultTenantId = optionalString("DEFAULT_TENANT_ID") ?? "default";
  const apiServiceScopes = [
    ...new Set(
      parseCsvEnv("API_SERVICE_SCOPES").flatMap((scope) => scope.split(/[\s,]+/)).filter(Boolean),
    ),
  ];
  const apiServiceTenantId = optionalString("API_SERVICE_TENANT_ID") ?? undefined;
  const trustProxy = parseBoolEnv("TRUST_PROXY", false);
  const exposeErrorDetail = parseBoolEnv("EXPOSE_ERROR_DETAIL", false);
  const oidc = parseOidcConfig();

  const uiBff: UiBffConfig = {
    tenantId: optionalString("UI_TENANT_ID") ?? defaultTenantId,
    scopes: [
      ...new Set(
        parseCsvEnv("UI_SCOPES")
          .flatMap((scope) => scope.split(/[\s,]+/))
          .map((scope) => scope.trim())
          .filter(Boolean),
      ),
    ],
    allowedGroups: [...new Set(parseCsvEnv("UI_ALLOWED_GROUPS"))],
    operatorGroup: optionalString("UI_OPERATOR_GROUP"),
  };

  // The mode is inferred from the credentials that are actually configured, then
  // may be narrowed explicitly. Cross-validation catches the dangerous case: a
  // deployment that sets AUTHN_MODE=oidc but forgets API_OIDC_ISSUERS would
  // otherwise start with an auth middleware that can never succeed — or worse,
  // with a mode that silently falls through.
  const inferredAuthnMode: AuthnMode =
    apiToken !== null && apiOidcIssuers.length > 0
      ? "token_or_oidc"
      : apiOidcIssuers.length > 0
        ? "oidc"
        : apiToken !== null
          ? "token"
          : "disabled";
  const authnMode = parseEnumEnv(
    "AUTHN_MODE",
    ["disabled", "token", "oidc", "token_or_oidc"] as const,
    inferredAuthnMode,
  );
  if ((authnMode === "token" || authnMode === "token_or_oidc") && apiToken === null) {
    throw new Error(`API_TOKEN is required when AUTHN_MODE=${authnMode}`);
  }
  if ((authnMode === "oidc" || authnMode === "token_or_oidc") && apiOidcIssuers.length === 0) {
    throw new Error(`API_OIDC_ISSUERS is required when AUTHN_MODE=${authnMode}`);
  }
  if (tenantIsolationEnabled && authnMode === "disabled") {
    throw new Error(
      "AUTHN_MODE=disabled cannot be used with TENANT_ISOLATION_ENABLED=true because no authenticated principal can select a tenant",
    );
  }
  if (
    tenantIsolationEnabled &&
    (authnMode === "token" || authnMode === "token_or_oidc") &&
    apiServiceTenantId === undefined
  ) {
    throw new Error(
      `API_SERVICE_TENANT_ID is required when AUTHN_MODE=${authnMode} and TENANT_ISOLATION_ENABLED=true`,
    );
  }

  // A figure crop rendered above Search's asset ceiling cannot be stored, and
  // discovering that per figure at upload time wastes a whole conversion.
  if (figureDpi < renderDpi) {
    throw new Error(
      `FIGURE_DPI (${figureDpi}) must be >= RENDER_DPI (${renderDpi}); crops are shown to humans and must not be coarser than the model's input`,
    );
  }

  return {
    port,
    nodeEnv,
    logLevel,
    publicUrl,
    visionUrl,
    visionModel,
    visionApiKey,
    visionTimeoutMs,
    visionTemperature,
    visionTopP,
    visionMaxTokenVariants,
    visionMaxRetries,
    visionReasoningEffort,
    visionInputTokenCost,
    visionOutputTokenCost,
    renderDpi,
    figureDpi,
    maxPages,
    tempDir,
    pageLabel,
    libreofficeBin,
    popplerBinDir,
    maxUploadBytes,
    bodyLimit,
    convertConcurrency,
    pageConcurrency,
    queueMaxDepth,
    rateLimit,
    callbackMaxRetries,
    callbackTimeoutMs,
    callbackAllowedHosts,
    search,
    authnMode,
    apiToken,
    monitorToken,
    apiOidcIssuers,
    authzEnabled,
    tenantIsolationEnabled,
    defaultTenantId,
    apiServiceScopes,
    apiServiceTenantId,
    trustProxy,
    exposeErrorDetail,
    oidc,
    uiBff,
  };
}
