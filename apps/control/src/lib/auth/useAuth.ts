"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * useAuth — custom hook for accessing the auth context (Req. 10.2).
 *
 * Throws when called outside of `<AuthProvider>` to catch integration errors
 * early instead of propagating `undefined` values.
 */

import { useContext } from "react";
import { AuthContext } from "./AuthProvider";
import type { AuthContextValue } from "./types";

/**
 * Returns the current auth context (token, role, helpers).
 * Must be used within an `<AuthProvider>`.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error(
      "useAuth must be used within an <AuthProvider>. " +
        "Wrap your component tree with <AuthProvider> in the root layout.",
    );
  }
  return ctx;
}
