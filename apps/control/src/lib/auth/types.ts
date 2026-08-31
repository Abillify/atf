// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Shared auth types (Req. 10.2).
 */

/** Role levels supported by the platform. */
export type AuthRole = "viewer" | "operator" | "admin";

/** Value exposed by the AuthContext. */
export interface AuthContextValue {
  /** Current session token, or undefined when not authenticated. */
  token: string | undefined;
  /** Role derived from the JWT, or admin when the operator plane is open. */
  role: AuthRole | undefined;
  /** True with a token, or when the backend reports that operator auth is open. */
  isAuthenticated: boolean;
  /** True once token hydration and backend auth-mode discovery are complete. */
  ready: boolean;
  /** True when the backend has a confidential OIDC client configured (SSO available). */
  ssoEnabled: boolean;
  /** Error code from a failed OIDC callback (e.g. "forbidden"), or undefined. */
  authError: string | undefined;
  /** Persist a new token (e.g. from manual input or OIDC handoff). */
  setToken: (value: string | undefined) => void;
  /** Clear the stored token (logout). */
  clearToken: () => void;
  /** Clears a surfaced `authError` (e.g. once shown to the user). */
  clearAuthError: () => void;
  /** Trigger an immediate silent renewal. Returns the new token or null. */
  renewNow: () => Promise<string | null>;
}
