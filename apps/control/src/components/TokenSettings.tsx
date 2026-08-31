"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React, { useState, useRef, useEffect } from "react";
import { beginLogin, logout } from "../lib/oidc";
import { Button } from "../lib/ui";

export interface TokenSettingsProps {
  token: string;
  onChange: (value: string) => void;
  /** True when backend-driven SSO is available (shows sign-in/out controls). */
  ssoEnabled?: boolean;
}

/**
 * Header control to set the monitoring token used for `/monitoring/*` (and the
 * control plane) when `MONITORING_AUTH=true`. Persisted via the parent's
 * `useToken` hook (localStorage), so no env rebuild is needed in production.
 */
export function TokenSettings({
  token,
  onChange,
  ssoEnabled = false,
}: TokenSettingsProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(token);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDraft(token);
  }, [token]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const hasToken = token !== "";
  const oidcEnabled = ssoEnabled;

  const save = (): void => {
    onChange(draft);
    setOpen(false);
  };

  const handleSsoSignIn = (): void => {
    beginLogin();
  };

  const handleSignOut = (): void => {
    // Clear the local token first so the dashboard drops to unauthenticated
    // even if the IdP has no end-session endpoint (logout resolves false).
    onChange("");
    setDraft("");
    setOpen(false);
    void logout();
  };

  return (
    <div className="relative" ref={popoverRef}>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        title={hasToken ? "Monitoring token set" : "Set monitoring token"}
        aria-label="Monitoring token settings"
        className="text-muted-foreground"
      >
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            hasToken ? "bg-green-500" : "bg-muted-foreground/30"
          }`}
        />
        Token
      </Button>

      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 rounded-lg border border-border bg-card p-3 shadow-lg">
          {oidcEnabled && (
            <div className="mb-3 border-b border-border pb-3">
              <label className="block text-xs font-medium text-muted-foreground">
                Single sign-on
              </label>
              <p className="mb-2 mt-0.5 text-[11px] leading-snug text-muted-foreground">
                Authenticate with your identity provider (OIDC). The issued
                token is verified against the provider&apos;s JWKS.
              </p>
              {hasToken ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSignOut}
                  className="w-full"
                >
                  Sign out
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSsoSignIn}
                  className="w-full"
                >
                  Sign in with SSO
                </Button>
              )}
            </div>
          )}
          <label className="block text-xs font-medium text-muted-foreground">
            {oidcEnabled ? "Or paste a token" : "Monitoring token"}
          </label>
          <p className="mb-2 mt-0.5 text-[11px] leading-snug text-muted-foreground">
            Sent as <span className="font-mono">?token=</span> to{" "}
            <span className="font-mono">/monitoring/*</span>. Required when{" "}
            <span className="font-mono">MONITORING_AUTH=true</span>. Stored in
            this browser only.
          </p>
          <input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            placeholder="eyJhbGc…"
            className="w-full rounded border border-border px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            autoFocus
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onChange("");
                setDraft("");
                setOpen(false);
              }}
            >
              Clear
            </Button>
            <Button variant="primary" size="sm" onClick={save}>
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
