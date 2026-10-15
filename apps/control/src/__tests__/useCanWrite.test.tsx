// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { useCanWrite } from "../lib/auth/useCanWrite";

const auth = vi.hoisted(() => ({ current: { role: undefined as string | undefined } }));
vi.mock("../lib/auth/useAuth", () => ({ useAuth: () => auth.current }));

describe("useCanWrite", () => {
  test.each([
    ["viewer", "operator", false],
    ["viewer", "admin", false],
    ["operator", "operator", true],
    ["operator", "admin", false],
    ["admin", "admin", true],
    [undefined, "operator", false],
  ] as const)("%s needs %s → allowed=%s", (role, minRole, allowed) => {
    auth.current = { role };
    const { result } = renderHook(() => useCanWrite(minRole));
    expect(result.current.allowed).toBe(allowed);
    expect(result.current.title).toBe(allowed ? undefined : `Requires the ${minRole} role`);
  });
});
