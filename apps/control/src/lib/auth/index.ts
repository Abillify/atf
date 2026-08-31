// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Auth module barrel export (Req. 10.2).
 */

export { AuthProvider, AuthContext, TOKEN_STORAGE_KEY } from "./AuthProvider";
export { useAuth } from "./useAuth";
export { RequireRole, hasMinimumRole } from "./RequireRole";
export type { AuthRole, AuthContextValue } from "./types";
export type { RequireRoleProps } from "./RequireRole";
