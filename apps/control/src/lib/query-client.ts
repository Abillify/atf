"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { QueryClient } from "@tanstack/react-query";

/**
 * Central QueryClient instance with sensible defaults.
 *
 * - retry: 3 attempts with exponential backoff (default)
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
      retry: 1,
    },
  },
});
