// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Named provider instances (`src/config/providers.ts`)
 *
 * A single `PROVIDERS` environment variable declares every inference endpoint
 * the deployment can reach, each under an operator-chosen NAME:
 *
 *   PROVIDERS=[
 *     {"name":"local-studio","protocol":"openai","url":"http://192.0.2.10:1234/v1"},
 *     {"name":"gpu-cluster","protocol":"openai","url":"http://192.0.2.20:8000/v1"},
 *     {"name":"local-ollama","protocol":"ollama","url":"http://192.0.2.10:11434"},
 *     {"name":"cloud-bedrock","protocol":"bedrock","region":"eu-central-1", ...}
 *   ]
 *
 * Flows, `DEFAULT_LLM`, `FALLBACK_LLM`, `EMBEDDING_MODEL` and every other
 * LlmConfig then reference the NAME (`{"provider":"gpu-cluster","model":"..."}`).
 *
 * Why a name/protocol split rather than a fixed provider enum: the enum made
 * "which wire protocol do I speak" and "which server do I talk to" the same
 * value, so a second instance of the same protocol (two vLLM servers, vLLM
 * alongside LM Studio) was not expressible — every `openai` config had to share
 * one global base URL. Here the PROTOCOL selects the SDK client and the
 * capability/telemetry rules, while the NAMED INSTANCE carries the endpoint and
 * credentials. Adding a third vLLM box is one array entry.
 *
 * `PROVIDERS` is the SINGLE source for endpoints and credentials: the former
 * per-protocol variables (`OPENAI_BASE_URL`, `GOOGLE_API_KEY`, `BEDROCK_*`,
 * `AZURE_*`, `ANTHROPIC_API_KEY`, `OLLAMA_BASE_URL`) are gone, because keeping a
 * second, protocol-scoped configuration layer is exactly what made a second
 * instance of a protocol inexpressible.
 *
 * A bare protocol name still RESOLVES (so capability and telemetry lookups work
 * for any reference, and a minimal dev setup needs no configuration), but it
 * carries no endpoint or credentials — the underlying SDK then applies its own
 * documented environment defaults, e.g. the AWS credential chain for bedrock.
 * Production deployments should always reference a named instance.
 *
 * Secrets live in the environment only; nothing here is persisted or logged.
 *
 * No `any` at module boundaries.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Protocols
// ---------------------------------------------------------------------------

/**
 * Wire protocols the engine can speak. This is the CLOSED set (each one maps to
 * a concrete SDK client in `createLlmProvider`); the open-ended part is the
 * provider NAME, of which there may be many per protocol.
 */
export const PROVIDER_PROTOCOLS = [
  "openai",
  "google",
  "ollama",
  "azure",
  "bedrock",
  "anthropic",
] as const;

export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];

/** True when `value` is one of the built-in wire protocols. */
export function isProviderProtocol(value: string): value is ProviderProtocol {
  return (PROVIDER_PROTOCOLS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Instance shape
// ---------------------------------------------------------------------------

/**
 * One named, fully-configured endpoint. Which fields are meaningful depends on
 * `protocol`; unused ones are simply ignored (e.g. `region` on an `openai`
 * instance), so a single flat shape covers every protocol.
 */
export interface ProviderInstance {
  /** Operator-chosen name that LlmConfig / EmbeddingConfig reference. */
  name: string;
  /** Wire protocol used to talk to this endpoint. */
  protocol: ProviderProtocol;
  /** Base URL for the HTTP protocols (openai-compatible, ollama, azure, anthropic). */
  url?: string;
  apiKey?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** Azure only: resource name (alternative to a full base URL). */
  resourceName?: string;
  /** Azure only: API version. */
  apiVersion?: string;
  /**
   * Operator assertion that this endpoint runs on their own infrastructure, so
   * request payloads (including raw images) never reach a third party.
   *
   * Deliberately explicit rather than inferred: an `openai`-protocol instance
   * may be a LAN vLLM box OR api.openai.com, and a URL alone cannot prove which
   * (split-horizon DNS, a proxy in front, a tunnelled private range). Consumers
   * that must not leak data to third parties (PII image describe) require this
   * flag. `ollama` is treated as local without it, matching its prior behaviour.
   */
  local?: boolean;
  /**
   * HTTP keep-alive (socket reuse) for this provider's requests; overrides
   * `LLM_HTTP_KEEP_ALIVE`. Only effective for the `openai`/`ollama` protocols,
   * which run through the runtime egress transport.
   */
  keepAlive?: boolean;
}

/**
 * Accepts both camelCase and snake_case keys so the env array can be written in
 * whichever style the surrounding deployment tooling already uses.
 */
const ProviderInstanceSchema = z
  .object({
    name: z.string().min(1).max(64),
    protocol: z.enum(PROVIDER_PROTOCOLS),
    url: z.string().url().optional(),
    apiKey: z.string().min(1).optional(),
    api_key: z.string().min(1).optional(),
    region: z.string().min(1).optional(),
    accessKeyId: z.string().min(1).optional(),
    access_key_id: z.string().min(1).optional(),
    secretAccessKey: z.string().min(1).optional(),
    secret_access_key: z.string().min(1).optional(),
    sessionToken: z.string().min(1).optional(),
    session_token: z.string().min(1).optional(),
    resourceName: z.string().min(1).optional(),
    resource_name: z.string().min(1).optional(),
    apiVersion: z.string().min(1).optional(),
    api_version: z.string().min(1).optional(),
    local: z.boolean().optional(),
    keepAlive: z.boolean().optional(),
    keep_alive: z.boolean().optional(),
  })
  .transform((raw): ProviderInstance => {
    const pick = (
      camel: string | undefined,
      snake: string | undefined,
    ): string | undefined => camel ?? snake;
    const url = raw.url;
    const apiKey = pick(raw.apiKey, raw.api_key);
    const region = pick(raw.region, undefined);
    const accessKeyId = pick(raw.accessKeyId, raw.access_key_id);
    const secretAccessKey = pick(raw.secretAccessKey, raw.secret_access_key);
    const sessionToken = pick(raw.sessionToken, raw.session_token);
    const resourceName = pick(raw.resourceName, raw.resource_name);
    const apiVersion = pick(raw.apiVersion, raw.api_version);
    const keepAlive = raw.keepAlive ?? raw.keep_alive;
    return {
      name: raw.name,
      protocol: raw.protocol,
      ...(url !== undefined ? { url } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(region !== undefined ? { region } : {}),
      ...(accessKeyId !== undefined ? { accessKeyId } : {}),
      ...(secretAccessKey !== undefined ? { secretAccessKey } : {}),
      ...(sessionToken !== undefined ? { sessionToken } : {}),
      ...(resourceName !== undefined ? { resourceName } : {}),
      ...(apiVersion !== undefined ? { apiVersion } : {}),
      ...(raw.local !== undefined ? { local: raw.local } : {}),
      ...(keepAlive !== undefined ? { keepAlive } : {}),
    };
  });

/** Schema for the whole `PROVIDERS` array, rejecting duplicate names. */
export const ProviderInstancesSchema = z
  .array(ProviderInstanceSchema)
  .max(64)
  .superRefine((instances, ctx) => {
    const seen = new Set<string>();
    for (const instance of instances) {
      if (seen.has(instance.name)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate provider name "${instance.name}"`,
        });
      }
      seen.add(instance.name);
    }
  });

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Process-wide view of the configured instances.
 *
 * A module-level registry (populated once by `loadConfig`) rather than a
 * parameter, because provider NAME → PROTOCOL resolution is needed by
 * pure-lookup helpers that deliberately take no AppConfig: the capability
 * registry and the telemetry mapper. Threading config through every one of
 * their call sites would spread configuration plumbing across the engine for a
 * value that cannot change after startup. Empty by default, so anything that
 * never calls `setProviderRegistry` (all existing unit tests) keeps the legacy
 * protocol-only behaviour.
 */
let registry: ReadonlyMap<string, ProviderInstance> = new Map();

/** Replaces the registry contents. Called by `loadConfig`; usable from tests. */
export function setProviderRegistry(
  instances: readonly ProviderInstance[] | undefined,
): void {
  registry = new Map((instances ?? []).map((i) => [i.name, i]));
}

/** The named instance for `name`, or `undefined` when it is not configured. */
export function getProviderInstance(name: string): ProviderInstance | undefined {
  return registry.get(name);
}

/**
 * Resolves a provider reference to the wire protocol it speaks: a configured
 * instance's protocol, or the reference itself when it already IS a protocol
 * (legacy configs). `undefined` for an unknown name — callers must treat that
 * as a configuration error rather than guessing a protocol.
 */
export function resolveProviderProtocol(
  name: string,
): ProviderProtocol | undefined {
  const instance = registry.get(name);
  if (instance !== undefined) return instance.protocol;
  return isProviderProtocol(name) ? name : undefined;
}

/** True when a provider reference can be resolved (named instance or protocol). */
export function isKnownProviderName(name: string): boolean {
  return resolveProviderProtocol(name) !== undefined;
}

/**
 * True when the provider's inference is guaranteed to stay on the operator's own
 * infrastructure: an instance that declares `local: true`, or the always-local
 * `ollama` protocol.
 */
export function isLocalProviderName(name: string | undefined): boolean {
  if (name === undefined) return false;
  const instance = registry.get(name);
  if (instance !== undefined) {
    return instance.local === true || instance.protocol === "ollama";
  }
  return name === "ollama";
}

/** All configured instance names (diagnostics / error messages). */
export function configuredProviderNames(): string[] {
  return [...registry.keys()];
}
