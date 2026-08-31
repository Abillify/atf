"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /auth/callback — legacy/compat landing spot for the OIDC redirect.
 *
 * The actual OIDC exchange happens entirely on the backend
 * (`/monitoring/auth/callback`, see `src/routes/auth-oidc.ts`), which redirects
 * the browser straight back to the page it started from (with the minted
 * session in the URL fragment). This route exists only as a safety net for a
 * deployment whose `OIDC_DASHBOARD_URL` points here instead of `/auth` — it
 * simply forwards the fragment on to `/auth`, where `AuthProvider` picks it up.
 */

import { useEffect } from "react";

export default function AuthCallbackPage(): null {
  useEffect(() => {
    window.location.replace(`/auth${window.location.hash}`);
  }, []);
  return null;
}
