// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Client_Credentials_Flow for machine identities (requirement 2.5). Used
 * when a client id and client secret are configured via environment or
 * Docker secret; no refresh token is expected for this grant.
 */

import { discover, tokenRequest, type FetchLike, type TokenResponse } from "./idp.js";

export async function clientCredentialsToken(
  issuer: string,
  clientId: string,
  clientSecret: string,
  scopes: readonly string[],
  audience: string | undefined,
  deps: { fetchImpl: FetchLike },
): Promise<TokenResponse> {
  const doc = await discover(issuer, deps.fetchImpl);
  const params: Record<string, string> = {
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  };
  if (scopes.length > 0) params["scope"] = scopes.join(" ");
  if (audience !== undefined) {
    params["audience"] = audience;
    params["resource"] = audience;
  }
  return tokenRequest(doc.token_endpoint, params, deps.fetchImpl);
}
