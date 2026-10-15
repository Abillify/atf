"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { QueryClient } from "@tanstack/react-query";

/**
 * Central QueryClient instance with sensible defaults.
 *
 * - retry: queries 3 attempts with exponential backoff; mutations never
 * - staleTime: 30 seconds — avoids unnecessary refetches for frequently
 *   accessed data while still keeping the UI reasonably fresh
 * - gcTime: 5 minutes — keeps unused cache entries around so navigating
 *   back to a previous view feels instant
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 3,
      refetchOnWindowFocus: false,
    },
    mutations: {
      // Never retry a mutation by default: a POST whose response was lost may
      // already have taken effect, and a retry repeats it (a second API key,
      // a second tenant, a second erasure). A mutation that is idempotent can
      // opt in with its own `retry`.
      retry: 0,
    },
  },
});
