"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * QueryProvider — wraps children with the shared TanStack QueryClientProvider.
 *
 * The `queryClient` singleton is defined in `../query-client` with project-wide
 * defaults (staleTime, gcTime, retry). This thin wrapper is a Client Component
 * so it can live in a Server Component root layout without breaking the RSC
 * boundary requirement.
 */

import type React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../query-client";

export interface QueryProviderProps {
  children: React.ReactNode;
}

export function QueryProvider({ children }: QueryProviderProps) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
