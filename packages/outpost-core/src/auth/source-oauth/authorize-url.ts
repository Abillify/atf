// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Pure builder for the cloud authorization URL (requirements 6.9, 6.13, 6.14,
 * 6.20, 15.2). Both clients are public: PKCE with `S256` is always sent, the
 * scopes are exactly the read-only ones from `providers.ts`, and the offline
 * parameter is provider-specific. Dropbox in Docker mode omits `redirect_uri`
 * entirely (no-redirect flow, 6.13); Google always uses a loopback URI (the
 * OOB flow is retired, 6.14).
 */

import { PROVIDERS, type ProviderId } from "./providers.js";

export interface AuthorizeUrlArgs {
  clientId: string;
  /** base64url S256 challenge (no padding). */
  codeChallenge: string;
  state: string;
  /**
   * Loopback redirect (`http://127.0.0.1:<port>…`). Undefined only for the
   * Dropbox no-redirect flow; required for GDrive.
   */
  redirectUri?: string;
}

/** Build the provider authorization URL. Pure — no I/O. */
export function buildAuthorizeUrl(provider: ProviderId, args: AuthorizeUrlArgs): URL {
  const info = PROVIDERS[provider];
  const url = new URL(info.authorizeEndpoint);
  const params = url.searchParams;
  params.set("response_type", "code");
  params.set("client_id", args.clientId);
  params.set("scope", info.scope);
  params.set("state", args.state);
  params.set("code_challenge", args.codeChallenge);
  params.set("code_challenge_method", "S256");
  for (const [key, value] of Object.entries(info.offlineParams)) {
    params.set(key, value);
  }
  if (args.redirectUri !== undefined) {
    params.set("redirect_uri", args.redirectUri);
  }
  return url;
}
