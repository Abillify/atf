// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * OAuth 2.0 Token Exchange (RFC 8693) — re-export from `@atf/security-kit`.
 *
 * The implementation lives in the shared security kit so the
 * gateway's `mcp-proxy-tool` and the runtime's MCP wrapper exchange against the
 * same IdP contract instead of maintaining two copies. This module keeps the
 * historical import path (`../auth/token-exchange.js`) stable for the wrapper,
 * bootstrap, and tests; new code may import `@atf/security-kit` directly.
 *
 * See the kit module for the full design rationale (confused-deputy
 * containment, delegation via `act`, caching, fail-closed semantics).
 */

export {
  TokenExchanger,
  ActorTokenProvider,
  createTokenEndpointResolver,
  EXCHANGE_EXPIRY_MARGIN_MS,
  TOKEN_TYPE_ACCESS_TOKEN,
  TOKEN_TYPE_JWT,
  type ActorClientCredentialsConfig,
  type ClientAuthMethod,
  type ExchangeLogger,
  type ExchangeResult,
  type ExchangedToken,
  type FetchLike,
  type TokenEndpointResolver,
  type TokenExchangeConfig,
} from "@atf/security-kit";
