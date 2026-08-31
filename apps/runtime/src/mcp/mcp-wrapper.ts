// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * MCP Wrapper — Facade
 *
 * Re-exports all public types, interfaces, functions and the factory from the
 * internal `wrapper/` modules so that existing imports continue to work
 * unchanged.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
 */

// ---------------------------------------------------------------------------
// Client: connection, session, error detection, factory
// ---------------------------------------------------------------------------

export {
  StreamableHTTPError,
  isSessionExpiredError,
  isConnectionError,
  createMcpWrapper,
} from "./wrapper/client.js";

export type { McpWrapperService } from "./wrapper/client.js";
export type {
  McpCacheMetadata,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpResourceTemplateDescriptor,
  McpTaskHandle,
  McpTaskStatus,
} from "./wrapper/stateless-2026-client.js";

// ---------------------------------------------------------------------------
// Schema: filtering, checksum
// ---------------------------------------------------------------------------

export { filterSchema, computeSchemaChecksum } from "./wrapper/schema.js";

export type { FilteredToolSchema } from "./wrapper/schema.js";

// ---------------------------------------------------------------------------
// Tool-Proxy: retry, parameter injection, template resolution
// ---------------------------------------------------------------------------

export {
  withRetry,
  injectProtectedParams,
  stripProtectedParams,
  resolveInjectedParams,
} from "./wrapper/tool-proxy.js";

export type {
  McpApprovalInputRequest,
  McpApprovalResolution,
  ToolResult,
} from "./wrapper/tool-proxy.js";
