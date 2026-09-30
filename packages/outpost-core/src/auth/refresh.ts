// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Refresh-Token-Grant and Client_Credentials_Flow against the Extract IdP
 * (requirements 2.4, 2.5, 4.2, 4.5).
 */

import {
  discover,
  tokenRequest,
  type FetchLike,
  type TokenResponse,
} from "./idp.js";

export interface TokenFlowDeps {
  fetchImpl: FetchLike;
}

/**
 * Exchange the stored refresh token for a fresh access token. A rotated
 * refresh token (if the IdP issues one) replaces the stored value.
 */
export async function refreshAccessToken(
  issuer: string,
  clientId: string,
  refreshToken: string,
  audience: string | undefined,
  deps: TokenFlowDeps,
): Promise<TokenResponse> {
  const doc = await discover(issuer, deps.fetchImpl);
  const params: Record<string, string> = {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  };
  if (audience !== undefined) {
    params["audience"] = audience;
    params["resource"] = audience;
  }
  return tokenRequest(doc.token_endpoint, params, deps.fetchImpl);
}

/**
 * Exchange an authorization code obtained via PKCE for tokens
 * (requirements 3.2, 15.2). Public client: no secret.
 */
export async function exchangeCode(
  issuer: string,
  clientId: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  deps: TokenFlowDeps,
): Promise<TokenResponse> {
  const doc = await discover(issuer, deps.fetchImpl);
  return tokenRequest(
    doc.token_endpoint,
    {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    },
    deps.fetchImpl,
  );
}
