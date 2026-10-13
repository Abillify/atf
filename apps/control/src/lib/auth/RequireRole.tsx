"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * RequireRole — declarative role-gating component (Req. 21.1, 21.2).
 *
 * Hides or disables children based on the current user's role.
 * Uses the auth context to determine if the user meets the minimum required role.
 */

import type React from "react";
import { useAuth } from "./useAuth";
import type { AuthRole } from "./types";

// ---------------------------------------------------------------------------
// Role hierarchy (higher number = more privileges)
// ---------------------------------------------------------------------------

const ROLE_LEVEL: Record<AuthRole, number> = {
  viewer: 0,
  operator: 1,
  admin: 2,
};

/**
 * Returns true when `userRole` meets or exceeds the `requiredRole`.
 */
export function hasMinimumRole(
  userRole: AuthRole | undefined,
  requiredRole: AuthRole,
): boolean {
  if (!userRole) return false;
  return ROLE_LEVEL[userRole] >= ROLE_LEVEL[requiredRole];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface RequireRoleProps {
  /** Minimum required role to render children normally. */
  minRole: AuthRole;
  children: React.ReactNode;
  /** Shown when role is insufficient (default: nothing). */
  fallback?: React.ReactNode;
  /** "hide" (default): unmount children; "disable": render but inactive. */
  mode?: "hide" | "disable";
}

/**
 * `<RequireRole>` gates UI based on the user's role level.
 *
 * - `mode="hide"` (default): renders nothing (or `fallback`) when unauthorized.
 * - `mode="disable"`: renders children in a disabled container when
 *   unauthorized. The container is marked `inert` (Req 8.8), which removes
 *   every descendant from the tab order and blocks pointer, click, and
 *   focus events — plain `aria-disabled` or `pointer-events: none` alone
 *   would still leave buttons and inputs reachable via the keyboard.
 *
 * @example
 * ```tsx
 * <RequireRole minRole="operator">
 *   <DeleteButton />
 * </RequireRole>
 * ```
 */
export function RequireRole({
  minRole,
  children,
  fallback = null,
  mode = "hide",
}: RequireRoleProps) {
  const { role: userRole } = useAuth();

  const authorized = hasMinimumRole(userRole, minRole);

  if (authorized) {
    return <>{children}</>;
  }

  // Unauthorized path
  if (mode === "disable") {
    return (
      // `inert` (Req 8.8) excludes all descendants from keyboard focus and
      // hit-testing; `pointerEvents`/`opacity` keep the visual affordance.
      <div
        inert
        aria-disabled="true"
        style={{ pointerEvents: "none", opacity: 0.5 }}
        data-testid="require-role-disabled"
      >
        {children}
      </div>
    );
  }

  // mode === "hide" (default)
  return <>{fallback}</>;
}
