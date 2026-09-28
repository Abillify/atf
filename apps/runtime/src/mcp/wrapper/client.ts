// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * MCP Wrapper — Connection & Session Handling
 *
 * Manages MCP client connections (http, sse, stdio transports), reconnection
 * on session expiry, per-caller token sessions for forwardAuthToken servers,
 * and error detection helpers.
 *
 * Requirements: 7.1, 7.6
 */

import crypto from "node:crypto";
import {
  diffToolSchemas,
  type SchemaCompatibilityDiff,
  type ToolSchemas,
} from "@atf/schema-compatibility";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
export { StreamableHTTPError };
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "../../config/index.js";
import type { AgentExecutionContext } from "../../types/monitoring.js";
import type {
  CapabilityDocument,
  EnforcementMode,
  TransactionMeta,
} from "../../transaction/types.js";
import {
  bindEvidenceActionContract,
  EVIDENCE_ACTION_CONTRACT_HASH_META_KEY,
  EVIDENCE_ACTION_CONTRACT_META_KEY,
  EVIDENCE_CONTRACT_HASH_META_KEY,
  EVIDENCE_PACK_HASH_META_KEY,
  type EvidenceActionContractMeta,
} from "../../transaction/evidence-contract.js";

import { SchemaCache, DEFAULT_PROTECTED_PARAMS, listAllTools } from "./schema.js";
import type { FilteredToolSchema, ToolAnnotations } from "./schema.js";
import { computeSchemaChecksum } from "./schema.js";
import { withRetry, resolveInjectedParams, stripProtectedParams } from "./tool-proxy.js";
import type { McpApprovalInputRequest, McpApprovalResolution, ToolResult } from "./tool-proxy.js";
import { MCP_2026_PROTOCOL_VERSION, Stateless2026Client } from "./stateless-2026-client.js";
import type { Logger } from "../../observability/logger.js";
import {
  EXCHANGE_EXPIRY_MARGIN_MS,
  TokenExchanger,
  createTokenEndpointResolver,
  type TokenExchangeConfig as ResolvedTokenExchangeConfig,
} from "../../auth/token-exchange.js";
import type {
  McpCacheMetadata,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpResourceTemplateDescriptor,
  McpTaskHandle,
  McpTaskStatus,
} from "./stateless-2026-client.js";

// ---------------------------------------------------------------------------
// Transaction metadata propagation
// ---------------------------------------------------------------------------

/**
 * Hashes a caller bearer so it can key a cache entry without keeping the
 * credential itself in a long-lived map key.
 */
function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalContractHash(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/iu.test(value)) {
    throw new Error(`${label} must be a SHA-256 hex digest`);
  }
  return value.toLowerCase();
}

/** Builds additive MCP metadata understood by v1 peers and ignored by legacy peers. */
export function buildTransactionMeta(
  invocationId: string,
  transaction?: TransactionMeta,
  evidenceContract?: EvidenceActionContractMeta,
): Record<string, string | number> {
  const preferredActionHash =
    transaction?.actionContractHash === undefined
      ? undefined
      : canonicalContractHash(transaction.actionContractHash, "Action-contract hash");
  const compatibilityActionHash =
    transaction?.evidenceContractHash === undefined
      ? undefined
      : canonicalContractHash(transaction.evidenceContractHash, "Evidence-contract hash");
  if (
    preferredActionHash !== undefined &&
    compatibilityActionHash !== undefined &&
    preferredActionHash !== compatibilityActionHash
  ) {
    throw new Error("Action-contract hash aliases must be identical");
  }
  const suppliedActionHash = preferredActionHash ?? compatibilityActionHash;
  const evidenceActionHash =
    evidenceContract === undefined
      ? undefined
      : canonicalContractHash(evidenceContract.actionContractHash, "Evidence action-contract hash");
  const evidenceCompatibilityHash =
    evidenceContract === undefined
      ? undefined
      : canonicalContractHash(evidenceContract.evidenceContractHash, "Evidence contract hash");
  if (
    evidenceActionHash !== undefined &&
    evidenceCompatibilityHash !== undefined &&
    evidenceActionHash !== evidenceCompatibilityHash
  ) {
    throw new Error("Evidence action-contract hash aliases must be identical");
  }
  if (
    suppliedActionHash !== undefined &&
    evidenceActionHash !== undefined &&
    suppliedActionHash !== evidenceActionHash
  ) {
    throw new Error("Evidence action contract does not match the transaction token");
  }
  const evidencePackHash =
    evidenceContract === undefined
      ? undefined
      : canonicalContractHash(evidenceContract.evidencePackHash, "Evidence pack hash");
  const trace = transaction?.trace;
  return {
    "transaction/invocationId": invocationId,
    "transaction/idempotencyKey": invocationId,
    // Compatibility aliases retained for existing peers during rolling upgrades.
    "aiperator/invocationId": invocationId,
    "aiperator/idempotencyKey": invocationId,
    ...(transaction?.token !== undefined
      ? {
          "transaction/token": transaction.token,
          // Compatibility during rolling upgrades of downstream peers.
          "aiperator/transactionToken": transaction.token,
        }
      : {}),
    ...(evidenceContract !== undefined
      ? {
          [EVIDENCE_ACTION_CONTRACT_META_KEY]: evidenceContract.serialized,
          [EVIDENCE_ACTION_CONTRACT_HASH_META_KEY]: evidenceActionHash,
          [EVIDENCE_CONTRACT_HASH_META_KEY]: evidenceActionHash,
          [EVIDENCE_PACK_HASH_META_KEY]: evidencePackHash,
        }
      : {}),
    ...(trace?.traceId !== undefined ? { "transaction/traceId": trace.traceId } : {}),
    ...(trace?.spanId !== undefined ? { "transaction/spanId": trace.spanId } : {}),
    ...(trace?.traceparent !== undefined ? { traceparent: trace.traceparent } : {}),
    ...(trace?.deadlineAt !== undefined ? { "transaction/deadlineAt": trace.deadlineAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export type SchemaCompatibilityMode = "report" | "strict";

export interface SchemaCompatibilityReport {
  serverName: string;
  toolName: string;
  mode: SchemaCompatibilityMode;
  diff: SchemaCompatibilityDiff;
}

/**
 * Public contract for the MCP Wrapper service.
 */
export interface McpWrapperService {
  connect(config: McpServerConfig): Promise<void>;
  /**
   * Tears down the existing client for the server and establishes a fresh
   * connection using the stored config. Called automatically on session expiry
   * (HTTP 404) but may also be called explicitly.
   */
  reconnect(serverName: string): Promise<void>;
  listTools(serverName: string, opts?: { authToken?: string }): Promise<string[]>;
  listResources?(
    serverName: string,
    opts?: { authToken?: string },
  ): Promise<{ resources: McpResourceDescriptor[] } & McpCacheMetadata>;
  listResourceTemplates?(
    serverName: string,
    opts?: { authToken?: string },
  ): Promise<{ resourceTemplates: McpResourceTemplateDescriptor[] } & McpCacheMetadata>;
  readResource?(
    serverName: string,
    uri: string,
    opts?: { authToken?: string; signal?: AbortSignal },
  ): Promise<{ contents: unknown[] } & McpCacheMetadata>;
  listPrompts?(
    serverName: string,
    opts?: { authToken?: string },
  ): Promise<{ prompts: McpPromptDescriptor[] } & McpCacheMetadata>;
  getPrompt?(
    serverName: string,
    name: string,
    args?: Record<string, unknown>,
    opts?: { authToken?: string; signal?: AbortSignal },
  ): Promise<{ description?: string; messages: unknown[] }>;
  getTask?(
    serverName: string,
    taskId: string,
    opts?: { authToken?: string; signal?: AbortSignal },
  ): Promise<McpTaskStatus>;
  updateTask?(
    serverName: string,
    taskId: string,
    input: Record<string, unknown>,
    opts?: { authToken?: string; signal?: AbortSignal },
  ): Promise<McpTaskStatus>;
  cancelTask?(
    serverName: string,
    taskId: string,
    opts?: { authToken?: string; signal?: AbortSignal },
  ): Promise<McpTaskStatus>;
  /**
   * Discovers v1 support without allocating a normal transaction invocation.
   *
   * `authToken` must be the caller bearer that the subsequent `callTool` will
   * use. For a `forwardAuthToken` server the bootstrap session and the
   * per-caller session are different MCP sessions with different identities, so
   * discovering on the bootstrap session can report "no v1" for a peer that
   * advertises it to the actual caller.
   */
  getTransactionCapabilities?(
    serverName: string,
    opts?: { authToken?: string },
  ): Promise<CapabilityDocument | undefined>;
  /**
   * Returns the server-level MCP `instructions` captured at connect/reconnect
   * (the `initialize` response's `instructions` field), or undefined when the
   * server advertises none. Used to inject per-server guidance into an LLM
   * node's prompt when that server's tools are selected.
   */
  getInstructions(serverName: string): string | undefined;
  /**
   * True when the bearer the server receives carries the caller's own IdP
   * session (plain `forwardAuthToken`). False for `tokenExchange` servers:
   * the exchanged token is minted by the IdP for another audience and does
   * not carry the caller's `sid`, so a transaction envelope must not bind it.
   */
  forwardsCallerSession?(serverName: string): boolean;
  getFilteredToolSchema(
    serverName: string,
    toolName: string,
    opts?: { authToken?: string },
  ): Promise<FilteredToolSchema>;
  refreshSchemaIfChanged(
    serverName: string,
    toolName: string,
    opts?: { authToken?: string },
  ): Promise<boolean>;
  /**
   * Rebinds an evidence contract to the exact argument representation that
   * will be sent after protected-parameter injection and NFC normalization.
   */
  prepareEvidenceActionContract?(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    ctx: AgentExecutionContext,
    contract: EvidenceActionContractMeta,
  ): Promise<{
    preparedCallId: string;
    args: Record<string, unknown>;
    evidenceContract: EvidenceActionContractMeta;
  }>;
  /**
   * Calls a tool on the given MCP server, injecting Protected Parameters from ctx.
   * Requirements: 7.4, 7.5, 7.6
   */
  callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    ctx: AgentExecutionContext,
    /**
     * `signal` carries the flow's execution deadline so a tool call — and the
     * retry loop around it — is cancelled with the run instead of outliving it.
     */
    opts?: {
      signal?: AbortSignal;
      invocationId?: string;
      transaction?: TransactionMeta;
      evidenceContract?: EvidenceActionContractMeta;
      /** Internal, one-time handle for exact normalized/injected arguments. */
      preparedEvidenceCallId?: string;
    },
  ): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Session-expired detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the error signals that an MCP HTTP session has expired
 * (server responded with 404 — session not found / timed out).
 *
 * The MCP spec mandates that servers return 404 for requests that carry an
 * unknown or expired `mcp-session-id` header.
 */
export function isSessionExpiredError(err: unknown): boolean {
  if (err instanceof StreamableHTTPError && err.code === 404) {
    return true;
  }
  // Some SDK versions wrap the error as a plain Error whose message contains the status.
  if (err instanceof Error) {
    return /\b404\b/.test(err.message) && /session/i.test(err.message);
  }
  return false;
}

/**
 * Returns true when the server rejected the request's bearer (HTTP 401). For a
 * token-exchange server this means the exchanged token was revoked or lapsed
 * early (e.g. clock skew); the session is rebuilt with a freshly exchanged
 * token. For other servers a 401 is not recoverable by reconnecting.
 */
export function isAuthRejectedError(err: unknown): boolean {
  if (err instanceof StreamableHTTPError && err.code === 401) return true;
  // The native 2026 client reports failures as "... failed (HTTP 401): ...".
  return err instanceof Error && /\(HTTP 401\)/.test(err.message);
}

/**
 * Returns true when the error signals a transport-level connection failure —
 * i.e. the MCP server process restarted or its network endpoint became
 * temporarily unreachable.
 *
 * Unlike session expiry (HTTP 404), these errors are thrown at the OS /
 * transport layer and are not specific to a session ID. They appear on all
 * three transports:
 *  - http/sse: ECONNREFUSED / ECONNRESET / ETIMEDOUT / socket hang-up when the
 *              remote process restarts or the network path drops.
 *  - stdio:    EPIPE / "write after end" / "process exited" when the child
 *              process terminates.
 *
 * On detecting any of these we tear down the dead client and open a fresh
 * connection — exactly the same recovery path as for session expiry.
 */
export function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    // Node.js / OS-level network codes (case-insensitive match on the code name)
    /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH/i.test(msg) ||
    // Human-readable variants produced by the MCP SDK and the Node http stack
    /connection (closed|refused|reset|terminated|dropped|lost)/i.test(msg) ||
    /transport (closed|error|disconnected|ended)/i.test(msg) ||
    /socket (hang.?up|closed|error|end)/i.test(msg) ||
    /write after end/i.test(msg) ||
    // stdio transport: child process died
    /process (exited|terminated|died|crashed)/i.test(msg) ||
    /spawn.*ENOENT/i.test(msg)
  );
}

/**
 * Factory that builds the underlying MCP SDK {@link Client}. Injectable so the
 * wrapper's connection/session logic can be exercised in tests without a real
 * MCP server. Defaults to constructing a real SDK `Client`.
 */
export type McpClientFactory = (info: { name: string; version: string }) => Client;

const defaultClientFactory: McpClientFactory = (info) => new Client(info);

/** Shared, process-wide token-endpoint discovery cache for all exchangers. */
const sharedTokenEndpointResolver = createTokenEndpointResolver();

/**
 * Builds a {@link TokenExchanger} for a server config that declares
 * `tokenExchange`, or returns undefined. The loader has already resolved
 * `clientSecretEnv` → `clientSecret`, so the concrete secret is present here.
 */
const defaultTokenExchangerFactory = (
  config: McpServerConfig,
  logger?: Logger,
): TokenExchanger | undefined => {
  const tx = config.tokenExchange;
  if (tx === undefined) return undefined;
  if (tx.clientSecret === undefined || tx.clientSecret === "") {
    throw new Error(
      `MCP server ${config.name} tokenExchange.clientSecret was not resolved before wrapper construction`,
    );
  }
  const resolved: ResolvedTokenExchangeConfig = {
    ...(tx.tokenEndpoint !== undefined ? { tokenEndpoint: tx.tokenEndpoint } : {}),
    ...(tx.issuer !== undefined ? { issuer: tx.issuer } : {}),
    clientId: tx.clientId,
    clientSecret: tx.clientSecret,
    ...(tx.clientAuth !== undefined ? { clientAuth: tx.clientAuth } : {}),
    audience: tx.audience,
    ...(tx.scope !== undefined ? { scope: tx.scope } : {}),
    ...(tx.requestedTokenType !== undefined ? { requestedTokenType: tx.requestedTokenType } : {}),
    ...(tx.timeoutMs !== undefined ? { timeoutMs: tx.timeoutMs } : {}),
    ...(tx.actor !== undefined
      ? {
          actor: {
            grant: tx.actor.grant,
            ...(tx.actor.tokenEndpoint !== undefined
              ? { tokenEndpoint: tx.actor.tokenEndpoint }
              : {}),
            clientId: tx.actor.clientId,
            clientSecret: tx.actor.clientSecret ?? "",
            ...(tx.actor.clientAuth !== undefined ? { clientAuth: tx.actor.clientAuth } : {}),
            ...(tx.actor.scope !== undefined ? { scope: tx.actor.scope } : {}),
            ...(tx.actor.audience !== undefined ? { audience: tx.actor.audience } : {}),
          },
        }
      : {}),
  };
  // The logger makes a rejected exchange visible (audience, IdP error code;
  // never token material) instead of surfacing only as an unavailable tool.
  return new TokenExchanger(resolved, {
    endpointResolver: sharedTokenEndpointResolver,
    ...(logger !== undefined ? { logger } : {}),
  });
};

const DEFAULT_PREPARED_EVIDENCE_CALL_TTL_MS = 300_000;
const MAX_PREPARED_EVIDENCE_CALL_TTL_MS = 2_147_483_647;
const DEFAULT_MAX_PREPARED_EVIDENCE_CALLS = 1_000;
const DEFAULT_MAX_PREPARED_EVIDENCE_CALLS_PER_CALLER = 32;

/**
 * Recursively Unicode-normalizes every string in a tool-argument value to NFC
 * (canonical composition), the W3C-recommended interchange form.
 *
 * Why: a model copies path-like arguments (`reference`, `path_prefix`, …) from
 * text we injected — filenames that, on macOS-ingested stores, are keyed in NFD
 * (decomposed, e.g. "a" + U+0308 for "ä"). The model reliably emits the
 * visually identical *precomposed* NFC form (U+00E4), so a byte-exact server
 * lookup misses and returns "0 results / not found" (observed in trace
 * 7c8b7dc5: every `list_documents`/`get_document` into `…/Qualitätsmanagement/…`
 * failed while ASCII paths worked). Normalizing outgoing args to the canonical
 * NFC form here — the single chokepoint through which ALL MCP tool calls pass —
 * makes the wire form deterministic regardless of which normalization the model
 * happened to copy, so it matches an NFC-normalizing store (see the sibling
 * vectorsearch server fix). NFC is idempotent and meaning-preserving for text,
 * so this is a no-op for ASCII args and safe for every server.
 */
function nfcNormalizeDeep(value: unknown): unknown {
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map(nfcNormalizeDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = nfcNormalizeDeep(v);
    }
    return out;
  }
  return value;
}

function parseCapabilityDocument(
  serverName: string,
  result: unknown,
): CapabilityDocument | undefined {
  const content =
    result !== null && typeof result === "object" && "content" in result
      ? (result as { content?: unknown }).content
      : undefined;
  const text = Array.isArray(content)
    ? content.find(
        (part): part is { text: string } =>
          part !== null &&
          typeof part === "object" &&
          "text" in part &&
          typeof part.text === "string",
      )?.text
    : undefined;
  if (text === undefined) return undefined;

  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (raw.protocol !== "v1" && raw.version !== "v1" && raw.schemaVersion !== "v1") {
    return undefined;
  }
  const token =
    raw.token !== null && typeof raw.token === "object"
      ? (raw.token as Record<string, unknown>)
      : {};
  const algorithms = Array.isArray(raw.signingAlgorithms)
    ? raw.signingAlgorithms.filter((value): value is string => typeof value === "string")
    : typeof token.algorithm === "string"
      ? [token.algorithm]
      : [];
  if (!algorithms.includes("HS256")) return undefined;
  const enforcement: EnforcementMode =
    raw.enforcement === "off" || raw.enforcement === "optional" || raw.enforcement === "required"
      ? raw.enforcement
      : "optional";
  const audiences = Array.isArray(raw.audiences)
    ? raw.audiences.filter((value): value is string => typeof value === "string")
    : typeof raw.audience === "string"
      ? [raw.audience]
      : [serverName];
  const features =
    raw.features !== null && typeof raw.features === "object"
      ? (raw.features as Record<string, unknown>)
      : {};
  return {
    protocol: "v1",
    issuer: typeof raw.issuer === "string" ? raw.issuer : serverName,
    audiences: audiences.length > 0 ? audiences : [serverName],
    enforcement,
    signingAlgorithms: ["HS256"],
    features: {
      idempotency:
        features.idempotency === true ||
        (raw.idempotency !== null && typeof raw.idempotency === "object"),
      budgets: features.budgets === true || Array.isArray(raw.budgets),
      compensation: features.compensation === true,
      evidenceLineage: features.evidenceLineage === true,
    },
    maxTokenTtlSeconds:
      typeof raw.maxTokenTtlSeconds === "number" && raw.maxTokenTtlSeconds > 0
        ? raw.maxTokenTtlSeconds
        : 300,
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface TokenClientEntry {
  client: Client;
  lastUsed: number;
  leases: number;
  retireWhenIdle: boolean;
}

interface ClientLease {
  client: Client;
  release: () => void;
}

export class McpWrapper implements McpWrapperService {
  /** Connected MCP clients, keyed by server name */
  private readonly clients = new Map<string, Client>();

  /** Server configs, keyed by server name */
  private readonly configs = new Map<string, McpServerConfig>();

  /**
   * Server-level MCP `instructions` captured from each server's `initialize`
   * response, keyed by server name. Refreshed on every connect/reconnect.
   */
  private readonly instructions = new Map<string, string>();

  /** Short-lived discovery cache, including negative legacy results. */
  private readonly capabilityCache = new Map<
    string,
    { value: CapabilityDocument | undefined; expiresAt: number }
  >();

  private readonly capabilityTtlMs: number;

  /** Per-attempt MCP request timeout; injectable only to keep recovery tests fast. */
  private readonly retryTimeoutMs: number;

  /**
   * Bound for the initial MCP handshake. It must stay below Bun's default
   * per-test timeout so an unreachable startup server cannot hold bootstrap
   * open indefinitely.
   */
  private readonly connectTimeoutMs: number;

  /**
   * Per-caller MCP clients for `forwardAuthToken` servers. Each distinct caller
   * bearer token gets its own MCP session (authenticated with that token via
   * the `Authorization` header) so every tool call runs under the caller's
   * identity. Structure: serverName → SHA-256(token) → entry. Raw bearer tokens
   * are never retained as pool keys. Idle entries are bounded by
   * {@link maxTokenClientsPerServer}; active leases may temporarily exceed it.
   */
  private readonly tokenClients = new Map<string, Map<string, TokenClientEntry>>();

  /** In-flight lazy client creation, deduplicated per server/token hash. */
  private readonly tokenClientCreations = new Map<
    string,
    Map<string, Promise<TokenClientEntry>>
  >();

  /** In-flight transport recovery, deduplicated per server/caller session. */
  private readonly reconnects = new Map<string, Promise<void>>();

  /** One-time handles for evidence-bound calls; never accepts caller-supplied final args. */
  private readonly preparedEvidenceCalls = new Map<
    string,
    {
      serverName: string;
      toolName: string;
      callerHash: string;
      args: Record<string, unknown>;
      expiresAt: number;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /** Maximum lifetime of a prepared Evidence-Bound Action Contract call. */
  private readonly preparedEvidenceCallTtlMs: number;

  /** Hard process-wide cap for unused prepared calls. */
  private readonly maxPreparedEvidenceCalls: number;

  /** Per-server/caller quota that prevents one caller from exhausting the cap. */
  private readonly maxPreparedEvidenceCallsPerCaller: number;

  /** Max concurrent per-caller sessions retained per forwardAuthToken server. */
  private readonly maxTokenClientsPerServer: number;

  /** Schema cache, checksum store, and last accepted contracts. */
  private readonly schemaCache: SchemaCache;

  private readonly schemaCompatibilityMode: SchemaCompatibilityMode;

  private readonly onSchemaCompatibility?: (report: SchemaCompatibilityReport) => void;

  /** Builds the underlying MCP SDK client (injectable for tests). */
  private readonly clientFactory: McpClientFactory;

  /**
   * Per-server RFC 8693 exchangers, keyed by server name. Present only for
   * servers configured with `tokenExchange`. When present, the bearer forwarded
   * to that server is the exchanged (right-audience) token; the per-caller pool,
   * reconnect and schema-cache keys stay bound to the caller's SUBJECT token.
   * A session's bearer is fixed, so a session whose exchanged token lapsed (see
   * {@link bearerExpiries}) or was rejected with 401 is rebuilt in place.
   */
  private readonly tokenExchangers = new Map<string, TokenExchanger>();

  /** Builds a {@link TokenExchanger} for a server config (injectable for tests). */
  private readonly tokenExchangerFactory: (config: McpServerConfig) => TokenExchanger | undefined;

  /**
   * Expiry (epoch ms) of the exchanged bearer each token-exchange session was
   * created with. A session's bearer never changes, so a session past this
   * point (minus the refresh margin) is rebuilt with a freshly exchanged token.
   */
  private readonly bearerExpiries = new WeakMap<Client, number>();

  constructor(
    options: {
      schemaTtlMs?: number;
      schemaCompatibilityMode?: SchemaCompatibilityMode;
      onSchemaCompatibility?: (report: SchemaCompatibilityReport) => void;
      capabilityTtlMs?: number;
      retryTimeoutMs?: number;
      connectTimeoutMs?: number;
      preparedEvidenceCallTtlMs?: number;
      maxPreparedEvidenceCalls?: number;
      maxPreparedEvidenceCallsPerCaller?: number;
      maxTokenClientsPerServer?: number;
      clientFactory?: McpClientFactory;
      tokenExchangerFactory?: (config: McpServerConfig) => TokenExchanger | undefined;
      /** Receives token-exchange outcomes from the default exchanger factory. */
      logger?: Logger;
    } = {},
  ) {
    this.schemaCache = new SchemaCache(options.schemaTtlMs ?? 60_000);
    this.schemaCompatibilityMode = options.schemaCompatibilityMode ?? "report";
    this.onSchemaCompatibility = options.onSchemaCompatibility;
    this.capabilityTtlMs = options.capabilityTtlMs ?? 30_000;
    this.retryTimeoutMs = options.retryTimeoutMs ?? 5_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 4_000;
    this.preparedEvidenceCallTtlMs =
      options.preparedEvidenceCallTtlMs ?? DEFAULT_PREPARED_EVIDENCE_CALL_TTL_MS;
    this.maxPreparedEvidenceCalls =
      options.maxPreparedEvidenceCalls ?? DEFAULT_MAX_PREPARED_EVIDENCE_CALLS;
    this.maxPreparedEvidenceCallsPerCaller =
      options.maxPreparedEvidenceCallsPerCaller ?? DEFAULT_MAX_PREPARED_EVIDENCE_CALLS_PER_CALLER;
    this.maxTokenClientsPerServer = options.maxTokenClientsPerServer ?? 500;
    if (
      !Number.isSafeInteger(this.preparedEvidenceCallTtlMs) ||
      this.preparedEvidenceCallTtlMs <= 0 ||
      this.preparedEvidenceCallTtlMs > MAX_PREPARED_EVIDENCE_CALL_TTL_MS
    ) {
      throw new Error(
        `preparedEvidenceCallTtlMs must be a positive safe integer up to ${MAX_PREPARED_EVIDENCE_CALL_TTL_MS}`,
      );
    }
    if (
      !Number.isSafeInteger(this.maxPreparedEvidenceCalls) ||
      this.maxPreparedEvidenceCalls <= 0
    ) {
      throw new Error("maxPreparedEvidenceCalls must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(this.maxPreparedEvidenceCallsPerCaller) ||
      this.maxPreparedEvidenceCallsPerCaller <= 0 ||
      this.maxPreparedEvidenceCallsPerCaller > this.maxPreparedEvidenceCalls
    ) {
      throw new Error(
        "maxPreparedEvidenceCallsPerCaller must be a positive safe integer no greater than maxPreparedEvidenceCalls",
      );
    }
    if (
      !Number.isSafeInteger(this.maxTokenClientsPerServer) ||
      this.maxTokenClientsPerServer <= 0
    ) {
      throw new Error("maxTokenClientsPerServer must be a positive safe integer");
    }
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
    const logger = options.logger;
    this.tokenExchangerFactory =
      options.tokenExchangerFactory ??
      ((config) => defaultTokenExchangerFactory(config, logger));
  }

  // -------------------------------------------------------------------------
  // connect
  // -------------------------------------------------------------------------

  /**
   * Register an MCP server and, when possible, establish its shared bootstrap
   * connection. A caller-authenticated server without a static Authorization
   * header deliberately has no shared session: its first connection is created
   * per caller with that caller's bearer token.
   * Requirements: 7.1
   */
  async connect(config: McpServerConfig): Promise<void> {
    // Build (or drop) the per-server token exchanger before anything else, so a
    // reconnect that changed the auth config takes effect immediately.
    const exchanger = this.tokenExchangerFactory(config);
    if (exchanger !== undefined) this.tokenExchangers.set(config.name, exchanger);
    else this.tokenExchangers.delete(config.name);

    if (config.allowAnonymous === true && config.forwardAuthToken === true) {
      throw new Error(
        `MCP server ${config.name} cannot combine allowAnonymous=true with forwardAuthToken=true`,
      );
    }

    // Keep the config even when the first handshake fails so the periodic
    // reconnect or a caller-scoped session can recover the server.
    this.configs.set(config.name, config);

    const hasBootstrapAuthorization = Object.entries(config.headers ?? {}).some(
      ([name, value]) =>
        name.toLowerCase() === "authorization" && value.trim().length > 0,
    );
    if (config.forwardAuthToken === true && !hasBootstrapAuthorization) {
      // Startup has no caller identity. Connecting here would issue an
      // unauthenticated initialize/server-discover request, produce a misleading
      // 401, and prevent otherwise valid caller-scoped flows from compiling.
      // _getTokenClient() establishes the authenticated session on first use.
      this.clients.delete(config.name);
      this.instructions.delete(config.name);
      this._invalidateCapabilities(config.name);
      return;
    }

    const pending = this._createClient(config);
    let client: Client;
    try {
      client = await this._bounded(
        pending,
        `MCP connect ${config.name}`,
        undefined,
        this.connectTimeoutMs,
      );
    } catch (error) {
      // A late SDK connection must not become an unhandled rejection or leak
      // a live transport after bootstrap has already moved on.
      void pending.then((lateClient) => lateClient.close()).catch(() => {});
      throw error;
    }

    this.clients.set(config.name, client);
    this._invalidateCapabilities(config.name);

    // Capture the server-level instructions advertised at initialize, so an LLM
    // node can inject this server's guidance when its tools are selected.
    const instr = client.getInstructions();
    if (instr !== undefined && instr.trim().length > 0) {
      this.instructions.set(config.name, instr);
    } else {
      this.instructions.delete(config.name);
    }
  }

  getInstructions(serverName: string): string | undefined {
    // Initialize instructions may be identity-dependent. A bootstrap session
    // must never contribute guidance to a caller-authenticated LLM request.
    if (this.configs.get(serverName)?.forwardAuthToken === true) return undefined;
    return this.instructions.get(serverName);
  }

  forwardsCallerSession(serverName: string): boolean {
    const config = this.configs.get(serverName);
    return config !== undefined && config.tokenExchange === undefined;
  }

  /**
   * Drops every cached capability document for a server — the bootstrap entry
   * and all per-caller entries alike. Called whenever a session for that
   * server is (re)established, since a fresh session may advertise a different
   * tool set than the one that produced the cached answer.
   */
  private _invalidateCapabilities(serverName: string): void {
    const prefix = `${serverName}\u0000`;
    for (const key of this.capabilityCache.keys()) {
      if (key === serverName || key.startsWith(prefix)) {
        this.capabilityCache.delete(key);
      }
    }
  }

  /**
   * Resolves the bearer actually forwarded to a server from the caller's
   * subject token. For a token-exchange server this performs the RFC 8693
   * exchange (cached); for every other server the subject token is returned
   * unchanged. A failed exchange throws — fail-closed — so a session is never
   * created with the wrong-audience subject token as a silent fallback.
   */
  private async _resolveBearer(
    serverName: string,
    subjectToken: string | undefined,
  ): Promise<{ bearer: string | undefined; expiresAt?: number }> {
    const exchanger = this.tokenExchangers.get(serverName);
    if (exchanger === undefined || subjectToken === undefined || subjectToken === "") {
      return { bearer: subjectToken };
    }
    const result = await exchanger.exchange(subjectToken);
    if (!result.ok) {
      throw new Error(
        `Token exchange for MCP server ${serverName} failed: ${result.detail}`,
      );
    }
    return { bearer: result.token.token, expiresAt: result.token.expiresAt };
  }

  /**
   * Decides whether a failed request warrants rebuilding its session: session
   * expiry and connection loss always do; a 401 does only on a token-exchange
   * server with a caller token, where the cached exchanged token for that
   * caller is dropped first so the rebuilt session carries a fresh one.
   */
  private _shouldRecover(serverName: string, err: unknown, subjectToken?: string): boolean {
    if (isSessionExpiredError(err) || isConnectionError(err)) return true;
    const exchanger = this.tokenExchangers.get(serverName);
    if (
      exchanger !== undefined &&
      subjectToken !== undefined &&
      subjectToken !== "" &&
      isAuthRejectedError(err)
    ) {
      exchanger.invalidate(subjectToken);
      return true;
    }
    return false;
  }

  /**
   * Best-effort session rebuild after a token-exchange server rejected the
   * exchanged bearer with 401. Recovery errors are swallowed so the caller
   * sees the original failure; a later call retries the rebuild on its own.
   */
  private async _recoverAfterAuthRejection(
    serverName: string,
    client: Client | undefined,
    subjectToken: string | undefined,
    error: unknown,
  ): Promise<void> {
    const exchanger = this.tokenExchangers.get(serverName);
    if (
      exchanger === undefined ||
      client === undefined ||
      subjectToken === undefined ||
      subjectToken === "" ||
      !isAuthRejectedError(error)
    ) {
      return;
    }
    exchanger.invalidate(subjectToken);
    try {
      await this._recoverClient(serverName, client, subjectToken);
    } catch {
      // Intentionally ignored: the original 401 is the relevant failure.
    }
  }

  /**
   * True when `client` was created with an exchanged bearer that is expired or
   * inside the refresh margin. The bearer is fixed for the lifetime of a
   * session, so such a session must be rebuilt (re-exchanging) before use.
   */
  private _hasStaleBearer(client: Client): boolean {
    const expiresAt = this.bearerExpiries.get(client);
    return expiresAt !== undefined && expiresAt - EXCHANGE_EXPIRY_MARGIN_MS <= Date.now();
  }

  /**
   * Builds and connects a fresh MCP {@link Client} for the given config.
   *
   * When `authToken` is provided (forwardAuthToken servers, per-caller
   * session), it is sent as `Authorization: Bearer <authToken>`, overriding any
   * static `Authorization` from `config.headers`. Without it, the connection
   * uses the static `config.headers` as-is. For a token-exchange server the
   * subject token is first exchanged (see {@link _resolveBearer}).
   */
  private async _createClient(config: McpServerConfig, authToken?: string): Promise<Client> {
    const configuredProfile = config.profile ?? config.protocolVersion ?? "2025";
    if (
      config.profile !== undefined &&
      config.protocolVersion !== undefined &&
      config.profile !== config.protocolVersion
    ) {
      throw new Error(`Conflicting MCP profiles for ${config.name}`);
    }
    // Resolve the actual bearer once, here — the single chokepoint every session
    // creation (connect, per-caller cold start, recovery) passes through. For a
    // token-exchange server the subject token is swapped for a token minted for
    // THIS server's audience; for every other server it is forwarded unchanged.
    const { bearer, expiresAt: bearerExpiresAt } = await this._resolveBearer(
      config.name,
      authToken,
    );
    // Remember when an exchanged bearer lapses, so the session carrying it is
    // rebuilt before use instead of failing every call with 401.
    const trackBearer = (created: Client): Client => {
      if (bearerExpiresAt !== undefined) this.bearerExpiries.set(created, bearerExpiresAt);
      return created;
    };
    if (configuredProfile === MCP_2026_PROTOCOL_VERSION) {
      if (config.transport !== "http") {
        throw new Error("MCP 2026-07-28 is supported only with the http transport");
      }
      const native = new Stateless2026Client(config, bearer);
      await native.connect();
      return trackBearer(native as unknown as Client);
    }

    const client = this.clientFactory({ name: "aiperator", version: "1.0.0" });

    let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;

    // Shared for both HTTP transports: static config headers, with the
    // per-caller bearer overriding a static Authorization when present.
    const httpHeaders = (): Record<string, string> => {
      const headers: Record<string, string> = { ...(config.headers ?? {}) };
      if (bearer !== undefined) {
        headers.Authorization = `Bearer ${bearer}`;
      }
      return headers;
    };

    switch (config.transport) {
      case "http": {
        const headers = httpHeaders();
        transport = new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
        });
        break;
      }
      case "sse": {
        // The SSE transport needs the headers applied to BOTH legs: the
        // long-lived GET event stream (`eventSourceInit.fetch`) and the
        // POST-back channel (`requestInit`). Passing only `requestInit` would
        // leave the event stream unauthenticated, which is how this previously
        // silently dropped `config.headers` and `forwardAuthToken` entirely —
        // an SSE MCP server behind auth could not be reached at all.
        const headers = httpHeaders();
        transport = new SSEClientTransport(new URL(config.url), {
          ...(Object.keys(headers).length > 0
            ? {
                requestInit: { headers },
                eventSourceInit: {
                  fetch: (url: string | URL, init?: RequestInit) =>
                    fetch(url, {
                      ...init,
                      headers: { ...(init?.headers as Record<string, string>), ...headers },
                    }),
                },
              }
            : {}),
        });
        break;
      }
      case "stdio":
        transport = new StdioClientTransport({ command: config.url });
        break;
      default: {
        const _exhaustive: never = config.transport;
        throw new Error(`Unsupported transport: ${String(_exhaustive)}`);
      }
    }

    try {
      await client.connect(transport);
      return trackBearer(client);
    } catch (error) {
      try {
        await client.close();
      } catch {
        // Best effort: preserve the original handshake failure.
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // reconnect
  // -------------------------------------------------------------------------

  /**
   * Tears down the existing client for the named server and opens a fresh
   * connection using the original config. The tool-schema cache for that
   * server is also invalidated so the first call after reconnect always
   * fetches fresh schemas from the new session.
   */
  async reconnect(serverName: string): Promise<void> {
    const config = this._requireConfig(serverName);

    // Best-effort close of the old client — ignore errors, it may already be dead.
    const oldClient = this.clients.get(serverName);
    if (oldClient) {
      try {
        await oldClient.close();
      } catch {
        // intentionally ignored
      }
      this.clients.delete(serverName);
    }

    // Force fresh discovery without discarding the accepted compatibility baseline.
    this.schemaCache.invalidateDiscovery(serverName);

    // Re-use the existing connect() logic.
    await this.connect(config);
  }

  // -------------------------------------------------------------------------
  // listTools
  // -------------------------------------------------------------------------

  /**
   * Returns the list of tool names available on the given server.
   * If the server returns a 404 (session expired) or a transport-level
   * connection error (server restarted / process died), the session is
   * re-initialised and the request is retried once.
   * Requirements: 7.1
   */
  async listTools(serverName: string, opts?: { authToken?: string }): Promise<string[]> {
    const session = await this._getDiscoverySession(serverName, opts?.authToken);
    try {
      const tools = await listAllTools(session.client);
      return tools.map((tool) => tool.name);
    } catch (err) {
      if (this._shouldRecover(serverName, err, session.authToken)) {
        await this._recoverClient(serverName, session.client, session.authToken);
      } else {
        throw err;
      }
    } finally {
      session.release();
    }

    const recovered = await this._getDiscoverySession(serverName, opts?.authToken);
    try {
      return (await listAllTools(recovered.client)).map((tool) => tool.name);
    } finally {
      recovered.release();
    }
  }

  private async _native2026ClientLease(
    serverName: string,
    authToken?: string,
  ): Promise<{ client: Stateless2026Client; release: () => void }> {
    const config = this._requireConfig(serverName);
    if ((config.profile ?? config.protocolVersion ?? "2025") !== MCP_2026_PROTOCOL_VERSION) {
      throw new Error(`MCP server ${serverName} does not use the 2026-07-28 profile`);
    }
    const lease =
      config.forwardAuthToken === true && authToken !== undefined && authToken !== ""
        ? await this._acquireTokenClient(serverName, authToken)
        : { client: this._requireClient(serverName), release: () => {} };
    if (!((lease.client as unknown) instanceof Stateless2026Client)) {
      lease.release();
      throw new Error(`MCP server ${serverName} has no native 2026 client`);
    }
    return {
      client: lease.client as unknown as Stateless2026Client,
      release: lease.release,
    };
  }

  async listResources(
    serverName: string,
    opts?: { authToken?: string },
  ): Promise<{ resources: McpResourceDescriptor[] } & McpCacheMetadata> {
    const lease = await this._native2026ClientLease(serverName, opts?.authToken);
    const resources: McpResourceDescriptor[] = [];
    let cursor: string | undefined;
    let metadata: McpCacheMetadata = {};
    try {
      do {
        const page = await lease.client.listResources(cursor !== undefined ? { cursor } : {});
        resources.push(...page.resources);
        metadata = {
          ...metadata,
          ...(page.ttlMs !== undefined ? { ttlMs: page.ttlMs } : {}),
          ...(page.cacheScope !== undefined ? { cacheScope: page.cacheScope } : {}),
        };
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return { resources, ...metadata };
    } finally {
      lease.release();
    }
  }

  async listResourceTemplates(
    serverName: string,
    opts?: { authToken?: string },
  ): Promise<{ resourceTemplates: McpResourceTemplateDescriptor[] } & McpCacheMetadata> {
    const lease = await this._native2026ClientLease(serverName, opts?.authToken);
    const resourceTemplates: McpResourceTemplateDescriptor[] = [];
    let cursor: string | undefined;
    let metadata: McpCacheMetadata = {};
    try {
      do {
        const page = await lease.client.listResourceTemplates(
          cursor !== undefined ? { cursor } : {},
        );
        resourceTemplates.push(...page.resourceTemplates);
        metadata = {
          ...metadata,
          ...(page.ttlMs !== undefined ? { ttlMs: page.ttlMs } : {}),
          ...(page.cacheScope !== undefined ? { cacheScope: page.cacheScope } : {}),
        };
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return { resourceTemplates, ...metadata };
    } finally {
      lease.release();
    }
  }

  async readResource(
    serverName: string,
    uri: string,
    opts?: { authToken?: string; signal?: AbortSignal },
  ): Promise<{ contents: unknown[] } & McpCacheMetadata> {
    const lease = await this._native2026ClientLease(serverName, opts?.authToken);
    try {
      return await lease.client.readResource(uri, opts?.signal);
    } finally {
      lease.release();
    }
  }

  async listPrompts(
    serverName: string,
    opts?: { authToken?: string },
  ): Promise<{ prompts: McpPromptDescriptor[] } & McpCacheMetadata> {
    const lease = await this._native2026ClientLease(serverName, opts?.authToken);
    const prompts: McpPromptDescriptor[] = [];
    let cursor: string | undefined;
    let metadata: McpCacheMetadata = {};
    try {
      do {
        const page = await lease.client.listPrompts(cursor !== undefined ? { cursor } : {});
        prompts.push(...page.prompts);
        metadata = {
          ...metadata,
          ...(page.ttlMs !== undefined ? { ttlMs: page.ttlMs } : {}),
          ...(page.cacheScope !== undefined ? { cacheScope: page.cacheScope } : {}),
        };
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return { prompts, ...metadata };
    } finally {
      lease.release();
    }
  }

  async getPrompt(
    serverName: string,
    name: string,
    args: Record<string, unknown> = {},
    opts?: { authToken?: string; signal?: AbortSignal },
  ): Promise<{ description?: string; messages: unknown[] }> {
    const lease = await this._native2026ClientLease(serverName, opts?.authToken);
    try {
      return await lease.client.getPrompt(name, args, opts?.signal);
    } finally {
      lease.release();
    }
  }

  async getTask(
    serverName: string,
    taskId: string,
    opts?: { authToken?: string; signal?: AbortSignal },
  ): Promise<McpTaskStatus> {
    const lease = await this._native2026ClientLease(serverName, opts?.authToken);
    try {
      return await lease.client.getTask(taskId, opts?.signal);
    } finally {
      lease.release();
    }
  }

  async updateTask(
    serverName: string,
    taskId: string,
    input: Record<string, unknown>,
    opts?: { authToken?: string; signal?: AbortSignal },
  ): Promise<McpTaskStatus> {
    const lease = await this._native2026ClientLease(serverName, opts?.authToken);
    try {
      return await lease.client.updateTask(taskId, input, opts?.signal);
    } finally {
      lease.release();
    }
  }

  async cancelTask(
    serverName: string,
    taskId: string,
    opts?: { authToken?: string; signal?: AbortSignal },
  ): Promise<McpTaskStatus> {
    const lease = await this._native2026ClientLease(serverName, opts?.authToken);
    try {
      return await lease.client.cancelTask(taskId, opts?.signal);
    } finally {
      lease.release();
    }
  }

  /**
   * Discovers the transaction contract through an advertised MCP tool. The
   * discovery call intentionally has neither `_meta` nor an invocation ID, so
   * it cannot recurse into or poison the normal invocation ledger.
   */
  async getTransactionCapabilities(
    serverName: string,
    opts?: { authToken?: string },
  ): Promise<CapabilityDocument | undefined> {
    // Discovery must observe the same MCP session the tool call will use.
    // A forwardAuthToken peer authenticates the transport per caller, so the
    // unauthenticated/bootstrap session may legitimately expose a different
    // tool list (or reject the request outright) than the caller's session.
    const forwardAuth = this._requireConfig(serverName).forwardAuthToken === true;
    const authToken =
      forwardAuth && opts?.authToken !== undefined && opts.authToken !== ""
        ? opts.authToken
        : undefined;
    if (forwardAuth && authToken === undefined) {
      // Caller-scoped peers have no shared identity or bootstrap client. Do not
      // attempt unauthenticated capability discovery and do not cache this
      // absence across callers.
      return undefined;
    }
    // Keyed per session identity so one caller's negative result cannot mask
    // another caller's advertised v1 support.
    const cacheKey =
      authToken === undefined ? serverName : `${serverName}\u0000${sha256(authToken)}`;
    const cached = this.capabilityCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const lease =
      authToken !== undefined
        ? await this._acquireTokenClient(serverName, authToken)
        : { client: this._requireClient(serverName), release: () => {} };
    let value: CapabilityDocument | undefined;
    try {
      const tools = await listAllTools(lease.client);
      const names = new Set(tools.map((tool) => tool.name));
      const preferred = serverName.toLowerCase().includes("mcpgate")
        ? ["mcpgate_transaction_capabilities", "transaction_capabilities"]
        : ["transaction_capabilities", "mcpgate_transaction_capabilities"];
      const toolName = preferred.find((name) => names.has(name));
      if (toolName !== undefined) {
        const result = await lease.client.callTool(
          { name: toolName, arguments: {} },
          CallToolResultSchema,
        );
        value = parseCapabilityDocument(serverName, result);
      }
    } catch {
      // Discovery is additive. Callers decide whether legacy fallback is legal.
      value = undefined;
    } finally {
      lease.release();
    }
    this.capabilityCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + this.capabilityTtlMs,
    });
    return value;
  }

  // -------------------------------------------------------------------------
  // getFilteredToolSchema
  // -------------------------------------------------------------------------

  /**
   * Fetches the tool schema, removes Protected Parameters, computes and stores
   * a SHA-256 checksum of the *original* schema, and returns the filtered schema.
   * Requirements: 7.2, 7.3, 7.7
   */
  async getFilteredToolSchema(
    serverName: string,
    toolName: string,
    opts?: { authToken?: string },
  ): Promise<FilteredToolSchema> {
    const config = this._requireConfig(serverName);
    const fetch = async (): Promise<FilteredToolSchema> => {
      const session = await this._getDiscoverySession(serverName, opts?.authToken);
      try {
        const tool = await this.schemaCache.fetchRawTool(
          session.client,
          toolName,
          serverName,
          session.schemaScope,
        );
        const contract: ToolSchemas = {
          inputSchema: tool.inputSchema,
          ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
        };
        const checksum = computeSchemaChecksum({
          ...contract,
          annotations: tool.annotations,
        });
        const storedChecksum = this.schemaCache.getStoredChecksum(
          serverName,
          toolName,
          session.schemaScope,
        );
        const previousContract = this.schemaCache.getStoredSchemaContract(
          serverName,
          toolName,
          session.schemaScope,
        );
        if (storedChecksum !== undefined && checksum !== storedChecksum && previousContract !== undefined) {
          const diff = diffToolSchemas(previousContract, contract);
          if (diff.breaking.length > 0 || diff.unknown.length > 0) {
            try {
              this.onSchemaCompatibility?.({
                serverName,
                toolName,
                mode: this.schemaCompatibilityMode,
                diff,
              });
            } catch {
              // Compatibility observability must not alter schema acceptance.
            }
          }
          if (this.schemaCompatibilityMode === "strict" && diff.breaking.length > 0) {
            // fetchRawTool cached the live candidate; remove it before rejecting
            // so no later caller can observe a schema that policy did not accept.
            this.schemaCache.invalidateDiscovery(serverName, session.schemaScope);
            throw new Error(
              `Breaking MCP schema change rejected for ${serverName}/${toolName}: ` +
                diff.breaking.map((finding) => `${finding.path} ${finding.message}`).join("; "),
            );
          }
        }
        if (storedChecksum === undefined || checksum !== storedChecksum) {
          this.schemaCache.storeChecksum(serverName, toolName, checksum, session.schemaScope);
          this.schemaCache.storeSchemaContract(
            serverName,
            toolName,
            contract,
            session.schemaScope,
          );
        } else if (previousContract === undefined) {
          // Migration path for checksum-only cache entries.
          this.schemaCache.storeSchemaContract(
            serverName,
            toolName,
            contract,
            session.schemaScope,
          );
        }

        const protectedParams = [
          ...(config.protectedParams ?? [...DEFAULT_PROTECTED_PARAMS]),
          ...Object.keys(config.injectedParams ?? {}),
        ];
        const filteredProperties: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(tool.inputSchema.properties ?? {})) {
          if (!protectedParams.includes(key)) filteredProperties[key] = value;
        }
        const filteredRequired = tool.inputSchema.required?.filter(
          (required) => !protectedParams.includes(required),
        );
        return {
          name: tool.name,
          description: tool.description,
          ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
          inputSchema: {
            type: tool.inputSchema.type,
            properties: filteredProperties,
            ...(filteredRequired !== undefined && filteredRequired.length > 0
              ? { required: filteredRequired }
              : {}),
          },
        };
      } finally {
        session.release();
      }
    };

    try {
      return await fetch();
    } catch (err) {
      if (this._shouldRecover(serverName, err, opts?.authToken)) {
        const session = await this._getDiscoverySession(serverName, opts?.authToken);
        try {
          await this._recoverClient(serverName, session.client, session.authToken);
        } finally {
          session.release();
        }
        return await fetch();
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // refreshSchemaIfChanged
  // -------------------------------------------------------------------------

  /**
   * Re-fetches the tool schema and compares it with the last accepted contract.
   * Report mode accepts drift after emitting compatibility findings. Strict mode
   * rejects breaking drift before mutating any cache state. Unknown findings are
   * observable but never blocking. The boolean return contract is unchanged.
   */
  async refreshSchemaIfChanged(
    serverName: string,
    toolName: string,
    opts?: { authToken?: string },
  ): Promise<boolean> {
    const session = await this._getDiscoverySession(serverName, opts?.authToken);
    try {
      // Bypass cache to get the live schema from every tools/list page.
      const tools = await listAllTools(session.client);
      const rawTool = tools.find((tool) => tool.name === toolName);
      if (!rawTool) throw new Error(`Tool not found: ${toolName}`);
      const { type, properties, required, ...rest } = rawTool.inputSchema;
      const liveContract: ToolSchemas = {
        inputSchema: {
          type,
          properties: properties as Record<string, object> | undefined,
          required,
          ...rest,
        },
        ...("outputSchema" in rawTool && rawTool.outputSchema !== undefined
          ? { outputSchema: rawTool.outputSchema as Readonly<Record<string, unknown>> }
          : {}),
      };

      const newChecksum = computeSchemaChecksum({
        ...liveContract,
        annotations: "annotations" in rawTool ? rawTool.annotations : undefined,
      });
      const storedChecksum = this.schemaCache.getStoredChecksum(
        serverName,
        toolName,
        session.schemaScope,
      );
      const previousContract = this.schemaCache.getStoredSchemaContract(
        serverName,
        toolName,
        session.schemaScope,
      );

      if (newChecksum === storedChecksum) {
        // Backward-compatible migration path for a cache seeded before contract
        // snapshots existed: retain checksum semantics and seed lazily.
        if (previousContract === undefined) {
          this.schemaCache.storeSchemaContract(
            serverName,
            toolName,
            liveContract,
            session.schemaScope,
          );
        }
        return false;
      }

      if (previousContract !== undefined) {
        const diff = diffToolSchemas(previousContract, liveContract);
        if (diff.breaking.length > 0 || diff.unknown.length > 0) {
          try {
            this.onSchemaCompatibility?.({
              serverName,
              toolName,
              mode: this.schemaCompatibilityMode,
              diff,
            });
          } catch {
            // Compatibility observability must not alter schema acceptance.
          }
        }
        if (this.schemaCompatibilityMode === "strict" && diff.breaking.length > 0) {
          throw new Error(
            `Breaking MCP schema change rejected for ${serverName}/${toolName}: ` +
              diff.breaking.map((finding) => `${finding.path} ${finding.message}`).join("; "),
          );
        }
      }

      // invalidateTool deliberately clears all old state; install the accepted
      // checksum and contract only after compatibility policy succeeds.
      this.schemaCache.invalidateTool(serverName, toolName, session.schemaScope);
      this.schemaCache.storeChecksum(serverName, toolName, newChecksum, session.schemaScope);
      this.schemaCache.storeSchemaContract(
        serverName,
        toolName,
        liveContract,
        session.schemaScope,
      );
      return true;
    } finally {
      session.release();
    }
  }

  /**
   * Rebinds evidence provenance to the exact arguments sent on the wire. This
   * mirrors `callTool`'s normalization and protected-parameter injection so
   * the action digest stays valid at mcpgate and in the signed transaction.
   */
  async prepareEvidenceActionContract(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    ctx: AgentExecutionContext,
    contract: EvidenceActionContractMeta,
  ): Promise<{
    preparedCallId: string;
    args: Record<string, unknown>;
    evidenceContract: EvidenceActionContractMeta;
  }> {
    const config = this._requireConfig(serverName);
    const forwardAuth = config.forwardAuthToken === true;
    const allowAnonymous = config.allowAnonymous === true;
    if (!ctx.ssoToken && !allowAnonymous) {
      throw new Error(
        "Missing required protected parameter value: user_token (ssoToken) is empty in request context",
      );
    }
    const normalizedArgs = nfcNormalizeDeep(args) as Record<string, unknown>;
    const recovery = this.reconnects.get(
      this._reconnectKey(serverName, forwardAuth ? ctx.ssoToken : undefined),
    );
    if (recovery !== undefined) await recovery;
    const lease = forwardAuth
      ? await this._acquireTokenClient(serverName, ctx.ssoToken)
      : { client: this._requireClient(serverName), release: () => {} };
    let rawTool: Awaited<ReturnType<SchemaCache["fetchRawTool"]>> | undefined;
    try {
      rawTool = await this.schemaCache.fetchRawTool(
        lease.client,
        toolName,
        serverName,
        forwardAuth ? sha256(ctx.ssoToken) : undefined,
      );
    } catch {
      rawTool = undefined;
    } finally {
      lease.release();
    }
    const declaredParams =
      config.injectedParams !== undefined && rawTool !== undefined
        ? new Set(Object.keys(rawTool.inputSchema.properties ?? {}))
        : undefined;
    const protectedKeys = [
      ...(allowAnonymous
        ? [...DEFAULT_PROTECTED_PARAMS, ...(config.protectedParams ?? [])]
        : (config.protectedParams ?? DEFAULT_PROTECTED_PARAMS)),
      ...Object.keys(config.injectedParams ?? {}),
    ];
    const enhancedArgs: Record<string, unknown> = {
      ...stripProtectedParams(normalizedArgs, protectedKeys),
    };
    if (!forwardAuth && !allowAnonymous) {
      enhancedArgs.user_token = ctx.ssoToken;
      if (ctx.userEmail !== undefined) enhancedArgs.user_email = ctx.userEmail;
      if (ctx.clientId !== undefined) enhancedArgs.client_id = ctx.clientId;
    }
    if (config.injectedParams !== undefined) {
      for (const [key, value] of Object.entries(
        resolveInjectedParams(config.injectedParams, ctx),
      )) {
        if (declaredParams === undefined || declaredParams.has(key)) enhancedArgs[key] = value;
      }
    }
    const now = Date.now();
    const callerHash = sha256(ctx.ssoToken);
    this._sweepPreparedEvidenceCalls(now);
    this._assertPreparedEvidenceCallCapacity(serverName, callerHash);
    const preparedCallId = crypto.randomUUID();
    const preparedArgs = structuredClone(enhancedArgs);
    const expiresAt = now + this.preparedEvidenceCallTtlMs;
    const timer = setTimeout(() => {
      const prepared = this.preparedEvidenceCalls.get(preparedCallId);
      if (prepared?.expiresAt === expiresAt) {
        this.preparedEvidenceCalls.delete(preparedCallId);
      }
    }, this.preparedEvidenceCallTtlMs);
    timer.unref?.();
    this.preparedEvidenceCalls.set(preparedCallId, {
      serverName,
      toolName,
      callerHash,
      args: preparedArgs,
      expiresAt,
      timer,
    });
    return {
      preparedCallId,
      args: structuredClone(preparedArgs),
      evidenceContract: bindEvidenceActionContract(contract.contract, enhancedArgs),
    };
  }

  // -------------------------------------------------------------------------
  // callTool
  // -------------------------------------------------------------------------

  /**
   * Calls a tool on the named MCP server, injecting Protected Parameters from ctx.
   *
   * Protected param mapping:
   *   ssoToken   → user_token   (required unless allowAnonymous=true)
   *   userEmail  → user_email   (injected only if present in ctx)
   *   clientId  → client_id   (injected only if present in ctx)
   *
   * Any `injectedParams` configured for the server are resolved against ctx and
   * the current clock and merged last into the tools that declare them, so the
   * model can neither see (filtered from the schema) nor override them.
   *
   * Session reconnection and retries are permitted only for tools that advertise
   * `readOnlyHint` or `idempotentHint`. Missing metadata fails safe: one attempt.
   * One stable invocation/idempotency ID is sent in MCP `_meta` across retries.
   * Requirements: 7.4, 7.5, 7.6
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    ctx: AgentExecutionContext,
    opts?: {
      signal?: AbortSignal;
      invocationId?: string;
      transaction?: TransactionMeta;
      evidenceContract?: EvidenceActionContractMeta;
      /** Internal, one-time handle for exact normalized/injected arguments. */
      preparedEvidenceCallId?: string;
    },
  ): Promise<ToolResult> {
    const config = this._requireConfig(serverName);
    const forwardAuth = config.forwardAuthToken === true;
    const allowAnonymous = config.allowAnonymous === true;

    // Caller identity is required unless this server was explicitly admitted as
    // anonymous by startup configuration validation.
    if (!ctx.ssoToken && !allowAnonymous) {
      throw new Error(
        `Missing required protected parameter value: user_token (ssoToken) is empty in request context`,
      );
    }

    // Canonicalize caller-supplied string args to Unicode NFC before anything
    // else. This is the one chokepoint every MCP tool call passes through, so a
    // path/reference the model copied in the precomposed (NFC) form matches an
    // NFC-normalizing store even when the store's keys originate from
    // NFD-decomposed macOS filenames. See nfcNormalizeDeep for the full
    // rationale (trace 7c8b7dc5). No-op for ASCII args.
    const preparedCall =
      opts?.preparedEvidenceCallId === undefined
        ? undefined
        : this._takePreparedEvidenceCall(opts.preparedEvidenceCallId, serverName, toolName, ctx);
    args = preparedCall?.args ?? (nfcNormalizeDeep(args) as Record<string, unknown>);

    // Build enhanced args: strip protected params from caller-supplied args,
    // then inject system-determined values from RequestContext.
    // This ensures that even if the LLM injects protected parameter keys
    // (user_token, user_email, client_id, or server-specific injectedParams)
    // into args, they are removed before forwarding. Only system-injected
    // values are used. (Requirements: 4.3)
    const buildEnhancedArgs = (declaredParams?: ReadonlySet<string>): Record<string, unknown> => {
      // Determine all protected param keys (default + server-configured injectedParams keys)
      const protectedKeys = [
        ...(allowAnonymous
        ? [...DEFAULT_PROTECTED_PARAMS, ...(config.protectedParams ?? [])]
        : (config.protectedParams ?? DEFAULT_PROTECTED_PARAMS)),
        ...Object.keys(config.injectedParams ?? {}),
      ];

      // Strip protected params from caller-supplied args
      const sanitizedArgs = stripProtectedParams(args, protectedKeys);

      const enhancedArgs: Record<string, unknown> = { ...sanitizedArgs };
      // For forwardAuthToken servers the caller identity travels in the
      // `Authorization` header, so it must NOT also be injected as tool arguments.
      if (!forwardAuth && !allowAnonymous) {
        enhancedArgs.user_token = ctx.ssoToken;
        if (ctx.userEmail !== undefined) {
          enhancedArgs.user_email = ctx.userEmail;
        }
        if (ctx.clientId !== undefined) {
          enhancedArgs.client_id = ctx.clientId;
        }
      }
      // Fixed/templated parameters configured for this server.
      const injectedParams = config.injectedParams;
      if (injectedParams !== undefined) {
        const resolved = resolveInjectedParams(injectedParams, ctx);
        for (const [key, value] of Object.entries(resolved)) {
          if (declaredParams === undefined || declaredParams.has(key)) {
            enhancedArgs[key] = value;
          }
        }
      }
      return enhancedArgs;
    };

    // For forwardAuthToken servers, route through per-caller session. If that
    // exact session is currently being replaced, wait for the shared recovery
    // instead of observing the intentional temporary cache gap.
    const acquireClient = async (): Promise<ClientLease> => {
      const recovery = this.reconnects.get(
        this._reconnectKey(serverName, forwardAuth ? ctx.ssoToken : undefined),
      );
      if (recovery !== undefined) await recovery;
      return forwardAuth
        ? await this._acquireTokenClient(serverName, ctx.ssoToken)
        : { client: this._requireClient(serverName), release: () => {} };
    };

    // Generate this once for the entire logical call, not per transport
    // session. A reconnect must remain the same idempotent invocation.
    const invocationId = opts?.invocationId ?? crypto.randomUUID();
    // Resolve retry safety once, before spending the call budget. Annotation
    // lookup failures fail safe: unknown tools receive exactly one call.
    const metadataLease = await acquireClient();
    let rawTool: Awaited<ReturnType<SchemaCache["fetchRawTool"]>> | undefined;
    try {
      rawTool = await this.schemaCache.fetchRawTool(
        metadataLease.client,
        toolName,
        serverName,
        forwardAuth ? sha256(ctx.ssoToken) : undefined,
      );
    } catch {
      rawTool = undefined;
    } finally {
      metadataLease.release();
    }
    let declaredParams: Set<string> | undefined;
    if (config.injectedParams !== undefined && rawTool !== undefined) {
      declaredParams = new Set(Object.keys(rawTool.inputSchema.properties ?? {}));
    }
    const annotations: ToolAnnotations | undefined = rawTool?.annotations;
    const retryable = annotations?.readOnlyHint === true || annotations?.idempotentHint === true;
    const maxAttempts = retryable ? 3 : 1;
    const enhancedArgs = preparedCall?.args ?? buildEnhancedArgs(declaredParams);
    let attemptClient: Client | undefined;
    let attemptCount = 0;
    const attemptFailures: Array<{ attempt: number; message: string }> = [];

    const transactionMeta = buildTransactionMeta(
      invocationId,
      opts?.transaction,
      opts?.evidenceContract,
    );
    const callInput = {
      name: toolName,
      arguments: enhancedArgs,
      _meta: transactionMeta,
    };
    // withRetry wraps the final failure in a plain Error; keep the raw one so a
    // rejected exchanged bearer can still be recognised after the last attempt.
    let lastAttemptError: unknown;
    const result = await withRetry(
      async (attemptSignal) => {
        attemptCount += 1;
        const lease = await acquireClient();
        attemptClient = lease.client;
        try {
          return await lease.client.callTool(callInput, CallToolResultSchema, {
            signal: attemptSignal,
          });
        } catch (error) {
          lastAttemptError = error;
          throw error;
        } finally {
          lease.release();
        }
      },
      {
        serverName,
        maxAttempts,
        timeoutMs: this.retryTimeoutMs,
        onAttemptFailure: async (error, attempt, signal) => {
          attemptFailures.push({ attempt, message: error.message });
          const timedOut = /^Attempt \d+ timed out after \d+ms$/u.test(error.message);
          if (
            !timedOut &&
            !this._shouldRecover(serverName, error, forwardAuth ? ctx.ssoToken : undefined)
          ) {
            return;
          }
          // A timed-out request can leave the SDK transport half-closed even
          // when no socket error surfaced. Replace exactly the client used by
          // this attempt; concurrent failures share one bounded recovery.
          if (attemptClient !== undefined) {
            await this._recoverClient(
              serverName,
              attemptClient,
              forwardAuth ? ctx.ssoToken : undefined,
              signal,
            );
          }
        },
        ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
      },
    ).catch(async (error: unknown) => {
      // Retries (and their recovery hook) do not run for the final or only
      // attempt — non-idempotent tools get exactly one. If that attempt's
      // exchanged bearer was rejected, rebuild the session anyway so the
      // caller's next call carries a fresh token. The call itself still fails:
      // it is never replayed with a different credential.
      await this._recoverAfterAuthRejection(
        serverName,
        attemptClient,
        forwardAuth ? ctx.ssoToken : undefined,
        lastAttemptError,
      );
      throw error;
    });
    const approvalRequests = parseApprovalInputRequests(
      "inputRequests" in result ? result.inputRequests : undefined,
    );
    const native2026 =
      result.resultType === "input_required" &&
      (attemptClient as unknown) instanceof Stateless2026Client
        ? (attemptClient as unknown as Stateless2026Client)
        : undefined;
    const mapResult = (
      value: Awaited<ReturnType<Stateless2026Client["callTool"]>>,
    ): ToolResult => ({
      content: value.content,
      ...(typeof value.isError === "boolean" ? { isError: value.isError } : {}),
      ...(value.resultType !== undefined ? { resultType: value.resultType } : {}),
      ...(value.structuredContent !== undefined
        ? { structuredContent: value.structuredContent }
        : {}),
      ...(value.task !== undefined ? { task: value.task } : {}),
      ...(parseApprovalInputRequests(value.inputRequests).length > 0
        ? { inputRequests: parseApprovalInputRequests(value.inputRequests) }
        : {}),
    });
    return {
      content: result.content,
      isError: typeof result.isError === "boolean" ? result.isError : undefined,
      ...(attemptCount > 1 ? { retry: { attempts: attemptCount, failures: attemptFailures } } : {}),
      ...("resultType" in result &&
      (result.resultType === "complete" ||
        result.resultType === "input_required" ||
        result.resultType === "task")
        ? { resultType: result.resultType }
        : {}),
      ...("task" in result &&
      result.task !== null &&
      typeof result.task === "object" &&
      "taskId" in result.task &&
      typeof result.task.taskId === "string"
        ? { task: result.task as McpTaskHandle }
        : {}),
      ...("structuredContent" in result ? { structuredContent: result.structuredContent } : {}),
      ...(approvalRequests.length > 0 ? { inputRequests: approvalRequests } : {}),
      ...(native2026 !== undefined
        ? {
            resolveApproval: async (
              request: McpApprovalInputRequest,
              resolution: McpApprovalResolution,
            ): Promise<ToolResult | undefined> => {
              const resumed = await native2026.resolveApproval(
                callInput,
                request.requestState,
                resolution,
                opts?.signal !== undefined ? { signal: opts.signal } : undefined,
              );
              return resumed === undefined ? undefined : mapResult(resumed);
            },
          }
        : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _deletePreparedEvidenceCall(id: string): void {
    const prepared = this.preparedEvidenceCalls.get(id);
    if (prepared !== undefined) {
      clearTimeout(prepared.timer);
      this.preparedEvidenceCalls.delete(id);
    }
  }

  private _sweepPreparedEvidenceCalls(now = Date.now()): void {
    for (const [id, prepared] of this.preparedEvidenceCalls) {
      if (prepared.expiresAt <= now) this._deletePreparedEvidenceCall(id);
    }
  }

  private _assertPreparedEvidenceCallCapacity(serverName: string, callerHash: string): void {
    if (this.preparedEvidenceCalls.size >= this.maxPreparedEvidenceCalls) {
      throw new Error("Prepared Evidence-Bound Action Contract capacity exceeded");
    }
    let callerEntries = 0;
    for (const prepared of this.preparedEvidenceCalls.values()) {
      if (prepared.serverName === serverName && prepared.callerHash === callerHash) {
        callerEntries += 1;
      }
    }
    if (callerEntries >= this.maxPreparedEvidenceCallsPerCaller) {
      throw new Error("Prepared Evidence-Bound Action Contract caller capacity exceeded");
    }
  }

  private _takePreparedEvidenceCall(
    id: string,
    serverName: string,
    toolName: string,
    ctx: AgentExecutionContext,
  ): { args: Record<string, unknown> } {
    const prepared = this.preparedEvidenceCalls.get(id);
    const callerHash = ctx.ssoToken === undefined ? "" : sha256(ctx.ssoToken);
    if (prepared === undefined || prepared.expiresAt <= Date.now()) {
      if (prepared !== undefined) this._deletePreparedEvidenceCall(id);
      throw new Error("Invalid or expired prepared Evidence-Bound Action Contract call");
    }
    if (
      prepared.serverName !== serverName ||
      prepared.toolName !== toolName ||
      prepared.callerHash !== callerHash
    ) {
      throw new Error("Invalid or expired prepared Evidence-Bound Action Contract call");
    }
    this._deletePreparedEvidenceCall(id);
    return { args: prepared.args };
  }

  private async _bounded<T>(
    operation: Promise<T>,
    label: string,
    signal?: AbortSignal,
    timeoutMs: number = this.retryTimeoutMs,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const guard = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      if (signal !== undefined) {
        onAbort = () => reject(new Error(`${label} aborted`));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    try {
      return await Promise.race([operation, guard]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Selects the authenticated client and opaque schema-cache scope for discovery.
   * A forward-auth server must never fall back to bootstrap discovery: its tool
   * list and schemas can be caller-specific.
   */
  private async _getDiscoverySession(
    serverName: string,
    authToken?: string,
  ): Promise<{ client: Client; authToken?: string; schemaScope: string; release: () => void }> {
    const config = this._requireConfig(serverName);
    if (config.forwardAuthToken === true) {
      if (authToken === undefined || authToken === "") {
        throw new Error(`Missing required auth token for MCP discovery: ${serverName}`);
      }
      const recovery = this.reconnects.get(this._reconnectKey(serverName, authToken));
      if (recovery !== undefined) await recovery;
      const lease = await this._acquireTokenClient(serverName, authToken);
      return {
        client: lease.client,
        authToken,
        schemaScope: sha256(authToken),
        release: lease.release,
      };
    }
    const recovery = this.reconnects.get(this._reconnectKey(serverName));
    if (recovery !== undefined) await recovery;
    return { client: this._requireClient(serverName), schemaScope: "shared", release: () => {} };
  }

  private _reconnectKey(serverName: string, token?: string): string {
    const tokenKey =
      token === undefined ? "shared" : crypto.createHash("sha256").update(token).digest("hex");
    return `${serverName}:${tokenKey}`;
  }

  private async _recoverClient(
    serverName: string,
    failedClient: Client,
    token?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const key = this._reconnectKey(serverName, token);
    const inFlight = this.reconnects.get(key);
    if (inFlight !== undefined) {
      await this._bounded(inFlight, `MCP reconnect ${serverName}`, signal, this.retryTimeoutMs * 2);
      return;
    }

    const tokenKey = token === undefined ? undefined : sha256(token);
    const currentEntry =
      tokenKey === undefined ? undefined : this.tokenClients.get(serverName)?.get(tokenKey);
    const current = token === undefined ? this.clients.get(serverName) : currentEntry?.client;
    if (current !== failedClient) return;

    const recovery = (async (): Promise<void> => {
      // Remove the poisoned generation before close: no new caller may borrow it.
      if (token === undefined) {
        this.clients.delete(serverName);
        try {
          await this._bounded(Promise.resolve(failedClient.close()), `MCP close ${serverName}`);
        } catch {
          // Best effort. A stuck close must not prevent creating a replacement.
        }
      } else if (currentEntry !== undefined && tokenKey !== undefined) {
        this.tokenClients.get(serverName)?.delete(tokenKey);
        currentEntry.retireWhenIdle = true;
        if (currentEntry.leases === 0) {
          try {
            await this._bounded(Promise.resolve(failedClient.close()), `MCP close ${serverName}`);
          } catch {
            // Best effort. A stuck close must not prevent creating a replacement.
          }
        }
      }

      const config = this._requireConfig(serverName);
      const pending = this._createClient(config, token);
      let replacement: Client;
      try {
        replacement = await this._bounded(pending, `MCP connect ${serverName}`);
      } catch (error) {
        void pending.then((lateClient) => lateClient.close()).catch(() => {});
        throw error;
      }

      if (token === undefined) {
        if (!this.clients.has(serverName)) this.clients.set(serverName, replacement);
        else void replacement.close().catch(() => {});
      } else if (tokenKey !== undefined) {
        let perServer = this.tokenClients.get(serverName);
        if (perServer === undefined) {
          perServer = new Map();
          this.tokenClients.set(serverName, perServer);
        }
        if (!perServer.has(tokenKey)) {
          perServer.set(tokenKey, {
            client: replacement,
            lastUsed: Date.now(),
            leases: 0,
            retireWhenIdle: false,
          });
          this._evictTokenClients(perServer);
        } else {
          void replacement.close().catch(() => {});
        }
      }
      const schemaScope = token === undefined ? "shared" : sha256(token);
      this.schemaCache.invalidateDiscovery(serverName, schemaScope);
      this._invalidateCapabilities(serverName);
    })();
    this.reconnects.set(key, recovery);
    void recovery.then(
      () => {
        if (this.reconnects.get(key) === recovery) this.reconnects.delete(key);
      },
      () => {
        if (this.reconnects.get(key) === recovery) this.reconnects.delete(key);
      },
    );
    // The shared recovery is independent of this caller. Its signal only
    // bounds this caller's wait, so one disconnected request cannot cancel
    // recovery needed by other concurrent requests.
    await this._bounded(recovery, `MCP reconnect ${serverName}`, signal, this.retryTimeoutMs * 2);
  }

  private _requireClient(serverName: string): Client {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server not found: ${serverName}`);
    }
    return client;
  }

  private _requireConfig(serverName: string): McpServerConfig {
    const config = this.configs.get(serverName);
    if (!config) {
      throw new Error(`MCP server not found: ${serverName}`);
    }
    return config;
  }

  /**
   * Returns the per-caller MCP client for a forwardAuthToken server, creating
   * and connecting it (authenticated with `token` as the bearer) on first use.
   * Concurrent cold starts share one creation promise. Failed creation promises
   * are removed so a later call can retry.
   */
  private async _getTokenClient(serverName: string, token: string): Promise<Client> {
    const config = this._requireConfig(serverName);
    const tokenKey = sha256(token);

    let perServer = this.tokenClients.get(serverName);
    if (perServer === undefined) {
      perServer = new Map();
      this.tokenClients.set(serverName, perServer);
    }
    const existing = perServer.get(tokenKey);
    if (existing !== undefined && this._hasStaleBearer(existing.client)) {
      // The session's exchanged bearer has lapsed while the caller's subject
      // token is still valid: rebuild the session (the exchange cache misses
      // for a lapsed token, so this mints a fresh one). One attempt only — an
      // IdP issuing lifetimes below the margin must not cause a rebuild loop.
      await this._recoverClient(serverName, existing.client, token);
      const rebuilt = this.tokenClients.get(serverName)?.get(tokenKey);
      if (rebuilt !== undefined) {
        rebuilt.lastUsed = Date.now();
        return rebuilt.client;
      }
    } else if (existing !== undefined) {
      existing.lastUsed = Date.now();
      return existing.client;
    }

    let creations = this.tokenClientCreations.get(serverName);
    if (creations === undefined) {
      creations = new Map();
      this.tokenClientCreations.set(serverName, creations);
    }
    const inFlight = creations.get(tokenKey);
    if (inFlight !== undefined) return (await inFlight).client;

    const creation = (async (): Promise<TokenClientEntry> => {
      const client = await this._createClient(config, token);
      const raced = perServer.get(tokenKey);
      if (raced !== undefined) {
        void client.close().catch(() => {});
        return raced;
      }
      const entry: TokenClientEntry = {
        client,
        lastUsed: Date.now(),
        leases: 0,
        retireWhenIdle: false,
      };
      perServer.set(tokenKey, entry);
      this._evictTokenClients(perServer);
      return entry;
    })();
    creations.set(tokenKey, creation);
    try {
      return (await creation).client;
    } finally {
      if (creations.get(tokenKey) === creation) creations.delete(tokenKey);
      if (creations.size === 0) this.tokenClientCreations.delete(serverName);
    }
  }

  private async _acquireTokenClient(serverName: string, token: string): Promise<ClientLease> {
    const client = await this._getTokenClient(serverName, token);
    const perServer = this.tokenClients.get(serverName);
    const entry = perServer?.get(sha256(token));
    if (entry === undefined || entry.client !== client) {
      // Recovery may have replaced the just-created generation. Retry against
      // the current pool entry rather than leasing an untracked client.
      return await this._acquireTokenClient(serverName, token);
    }
    entry.leases += 1;
    entry.lastUsed = Date.now();
    let released = false;
    return {
      client,
      release: () => {
        if (released) return;
        released = true;
        entry.leases -= 1;
        entry.lastUsed = Date.now();
        if (entry.leases === 0 && entry.retireWhenIdle) {
          void entry.client.close().catch(() => {});
        }
        if (perServer !== undefined) this._evictTokenClients(perServer);
      },
    };
  }

  /**
   * Removes least-recently-used sessions from the pool at the configured cap.
   * A leased victim is marked for retirement and closed only by its final
   * release, so the victim choice cannot change while its call is active.
   */
  private _evictTokenClients(perServer: Map<string, TokenClientEntry>): void {
    if (perServer.size <= this.maxTokenClientsPerServer) return;
    const sorted = [...perServer.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const removeCount = perServer.size - this.maxTokenClientsPerServer;
    for (const [tokenKey, entry] of sorted.slice(0, removeCount)) {
      perServer.delete(tokenKey);
      entry.retireWhenIdle = true;
      if (entry.leases === 0) void entry.client.close().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a new, independent McpWrapperService instance.
 *
 * @param options.schemaTtlMs Tool-schema cache TTL in ms (default 60000).
 *                            Entries older than this are re-fetched on access
 *                            so runtime schema drift is detected without a
 *                            restart. 0 disables expiry.
 * @param options.clientFactory Builds the underlying MCP SDK client. Injectable
 *                            for tests; defaults to the real SDK `Client`.
 */
export function createMcpWrapper(options?: {
  schemaTtlMs?: number;
  schemaCompatibilityMode?: SchemaCompatibilityMode;
  onSchemaCompatibility?: (report: SchemaCompatibilityReport) => void;
  capabilityTtlMs?: number;
  retryTimeoutMs?: number;
  connectTimeoutMs?: number;
  preparedEvidenceCallTtlMs?: number;
  maxPreparedEvidenceCalls?: number;
  maxPreparedEvidenceCallsPerCaller?: number;
  maxTokenClientsPerServer?: number;
  clientFactory?: McpClientFactory;
  tokenExchangerFactory?: (config: McpServerConfig) => TokenExchanger | undefined;
  logger?: Logger;
}): McpWrapperService {
  return new McpWrapper(options);
}

/** Accepts only the MCP-2026 approval request shape; unknown input kinds stay opaque. */
function parseApprovalInputRequests(value: unknown): McpApprovalInputRequest[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): McpApprovalInputRequest[] => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const request = candidate as Record<string, unknown>;
    if (
      request.type !== "approval" ||
      typeof request.requestState !== "string" ||
      request.requestState === "" ||
      typeof request.title !== "string" ||
      typeof request.message !== "string"
    )
      return [];
    const fields = Array.isArray(request.fields)
      ? request.fields.flatMap((candidate): NonNullable<McpApprovalInputRequest["fields"]> => {
          if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate))
            return [];
          const field = candidate as Record<string, unknown>;
          return typeof field.name === "string" &&
            typeof field.label === "string" &&
            "value" in field
            ? [{ name: field.name, label: field.label, value: field.value }]
            : [];
        })
      : undefined;
    return [
      {
        type: "approval",
        requestState: request.requestState,
        title: request.title,
        message: request.message,
        ...(fields !== undefined ? { fields } : {}),
        ...(typeof request.expiresAt === "string" ? { expiresAt: request.expiresAt } : {}),
      },
    ];
  });
}
