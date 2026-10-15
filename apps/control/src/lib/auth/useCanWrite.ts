"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Role gate for a single control (Req. 21.1).
 *
 * Mirrors the Runtime's operator RBAC (`apps/runtime/src/middleware/
 * operator-rbac.ts`), where every write permission maps to a minimum role:
 *
 *   - `operator` — `monitoring:write` (memory, limits, eval cases and runs,
 *     provider tests, assistants admin), `approvals:write`, `replay:write`
 *   - `admin`    — `flows:write` (Studio save/publish/test-run/rollback,
 *     copilots, optimizer, autopilot trigger, compliance, tenants, MCP)
 *
 * Use it where wrapping the control in `<RequireRole>` would disturb layout:
 * spread `disabled` and `title` onto the button. The Runtime still enforces
 * the permission; this only stops the UI from offering an action that would
 * answer 401.
 */

import { hasMinimumRole } from "./RequireRole";
import type { AuthRole } from "./types";
import { useAuth } from "./useAuth";

export interface WriteGate {
  /** True when the signed-in role may perform the action. */
  allowed: boolean;
  /** Tooltip explaining why the control is disabled, when it is. */
  title: string | undefined;
}

export function useCanWrite(minRole: AuthRole): WriteGate {
  const { role } = useAuth();
  const allowed = hasMinimumRole(role, minRole);
  return {
    allowed,
    title: allowed ? undefined : `Requires the ${minRole} role`,
  };
}
