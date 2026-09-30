// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Authentication-method selection (requirements 2.1, 2.5, 2.6, 2.7).
 *
 * Priority is fixed: API-Token, then Client_Credentials_Flow, then the
 * interactive flow for the runtime (Device_Code_Flow in Docker, PKCE_Flow on
 * desktop). The selection is final — once a method is chosen, failures never
 * fall back to another method (2.9).
 */

export type AuthMethod = "api-token" | "client-credentials" | "device-code" | "pkce";

export interface AvailableAuthMethods {
  apiToken: boolean;
  clientCredentials: boolean;
  /** Which interactive flow the runtime can offer. */
  interactive: "device" | "pkce";
}

export function selectAuthMethod(available: AvailableAuthMethods): AuthMethod {
  if (available.apiToken) return "api-token";
  if (available.clientCredentials) return "client-credentials";
  return available.interactive === "device" ? "device-code" : "pkce";
}
