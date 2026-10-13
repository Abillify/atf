"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /auth — Login page (Req. 9.4).
 *
 * Shown when the dashboard's AuthGuard redirects an unauthenticated visitor.
 * Offers backend-driven SSO (when configured) and a manual-token fallback for
 * deployments using static OPERATOR_TOKENS. Once a token is set, redirects
 * back to the originally requested page (or /graph).
 */

import type React from "react";
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "../../lib/auth/useAuth";
import { beginLogin } from "../../lib/oidc";
import { safeReturnTo } from "../../lib/safe-navigation";
import { Button } from "../../lib/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../lib/ui/Card";

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  forbidden: "Your identity provider account has no operator role assigned.",
  state_expired: "The sign-in attempt expired. Please try again.",
  state_mismatch: "The sign-in attempt could not be verified. Please try again.",
  missing_code: "The identity provider did not return an authorization code.",
  token_exchange_failed: "Could not exchange the authorization code for a session.",
  no_id_token: "The identity provider did not return an ID token.",
  callback_failed: "Sign-in failed unexpectedly. Please try again.",
};

function describeAuthError(code: string): string {
  return AUTH_ERROR_MESSAGES[code] ?? `Sign-in failed (${code}).`;
}

export default function AuthPage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <AuthPageContent />
    </Suspense>
  );
}

function AuthPageContent(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const {
    isAuthenticated,
    ready,
    ssoEnabled,
    authError,
    setToken,
    clearAuthError,
  } = useAuth();
  const [draft, setDraft] = useState("");
  const tokenInputRef = useRef<HTMLInputElement>(null);

  const returnTo = safeReturnTo(searchParams.get("returnTo"));

  // Focus the token field on mount when SSO is unavailable (replaces the
  // autoFocus attribute; WCAG 3.2.2 — focus moves tied to user intent).
  useEffect(() => {
    if (!ssoEnabled) tokenInputRef.current?.focus();
  }, [ssoEnabled]);

  // Once authenticated (SSO handoff or manual token), leave the login page.
  useEffect(() => {
    if (ready && isAuthenticated) {
      router.replace(returnTo);
    }
  }, [ready, isAuthenticated, returnTo, router]);

  const handleSsoSignIn = (): void => {
    clearAuthError();
    beginLogin();
  };

  const handleManualSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (trimmed === "") return;
    setToken(trimmed);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to Aiperator</CardTitle>
          <p className="text-sm text-muted-foreground">
            Authenticate to access the operator dashboard.
          </p>
        </CardHeader>
        <CardContent>
          {authError && (
            <div
              role="alert"
              className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
            >
              {describeAuthError(authError)}
            </div>
          )}

          {ssoEnabled && (
            <div className="mb-4">
              <Button
                type="button"
                variant="primary"
                className="w-full"
                onClick={handleSsoSignIn}
              >
                Sign in with SSO
              </Button>
            </div>
          )}

          {ssoEnabled && (
            <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
              <div className="h-px flex-1 bg-border" />
              <span>or</span>
              <div className="h-px flex-1 bg-border" />
            </div>
          )}

          <form onSubmit={handleManualSubmit} className="flex flex-col gap-2">
            <label
              htmlFor="operator-token"
              className="text-xs font-medium text-muted-foreground"
            >
              Operator token
            </label>
            <input
              id="operator-token"
              ref={tokenInputRef}
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="eyJhbGc…"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button type="submit" variant="secondary" disabled={draft.trim() === ""}>
              Continue with token
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
