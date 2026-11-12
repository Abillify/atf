// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * The `McpWrapperService` contract and its schema-compatibility types. Split out of
 * `client.ts` unchanged; that module re-exports them.
 */

import type {
  SchemaCompatibilityDiff,
} from "@atf/schema-compatibility";
import {
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
export { StreamableHTTPError };
import type { McpServerConfig } from "../../config/index.js";
import type { AgentExecutionContext } from "../../types/monitoring.js";
import type {
  CapabilityDocument,
  TransactionMeta,
} from "../../transaction/types.js";
import type {
  EvidenceActionContractMeta,
} from "../../transaction/evidence-contract.js";

import type { FilteredToolSchema } from "./schema.js";
import type { ToolResult } from "./tool-proxy.js";
import type {
  McpCacheMetadata,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpResourceTemplateDescriptor,
  McpTaskStatus,
} from "./stateless-2026-client.js";

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
  /**
   * Subject (`sub`) of the bearer this server receives for the given caller
   * token, or undefined when the server receives the caller token unchanged.
   * For `tokenExchange` servers this is the exchanged token's subject, which
   * follows the target provider's subject mode and can differ from the
   * caller's own `sub`. A transaction envelope must bind THIS subject.
   * Throws when the exchange fails (fail-closed, like the call itself).
   */
  targetSubject?(serverName: string, subjectToken: string | undefined): Promise<string | undefined>;
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
