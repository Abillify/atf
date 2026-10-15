"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * PiiVaultPanel — Dashboard panel for the reversible PII tokenization vault.
 *
 * Read-only status: whether the vault is enabled, whether it's backed by a
 * durable (encrypted Postgres) store or an in-memory (per-replica) one, and
 * which PII types it tokenizes. No usage metrics — vault entries are
 * deliberately short-lived (released as soon as a run finishes streaming),
 * so there's nothing meaningful to count beyond "in progress right now".
 */

import type React from "react";
import { useEffect, useState, useCallback } from "react";
import { useAuth } from "../lib/auth/useAuth";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";
import { Badge, Button } from "../lib/ui";
import { translate } from "../lib/i18n";

interface PiiVaultStatus {
  enabled: boolean;
  durable: boolean;
  piiTypes: string[] | "all";
  /** Active detector backends (ADR-0015), e.g. ["regex","ner"]. */
  detectors?: string[];
}

export function PiiVaultPanel(): React.JSX.Element {
  const { token, ready, isAuthenticated } = useAuth();
  const [status, setStatus] = useState<PiiVaultStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!ready || !isAuthenticated) return;
    setLoading(true);
    try {
      const resp = await authFetch(backendUrl("/admin/pii-vault/status"), token);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setStatus((await resp.json()) as PiiVaultStatus);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [token, ready, isAuthenticated]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          {translate("piiVaultPanel.pIITokenizationVault")}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void fetchStatus()}
          aria-label={translate("piiVaultPanel.refreshPIIVaultStatus")}
        >
          ↻
        </Button>
      </div>

      {loading ? (
        <div className="text-xs text-muted-foreground">{translate("piiVaultPanel.loading")}</div>
      ) : error ? (
        <div className="text-xs text-danger">{error}</div>
      ) : status === null ? null : !status.enabled ? (
        <div className="rounded border border-dashed border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          {translate("piiVaultPanel.disabledSet")} <code className="font-mono">PII_VAULT_ENABLED=true</code>{" "}
          (+ <code className="font-mono">PII_VAULT_ENCRYPTION_KEY</code>{translate("piiVaultPanel.toTokenizePIIInOutbound")}
        </div>
      ) : (
        <div className="rounded border border-success-border bg-success-soft px-3 py-2 text-xs space-y-2">
          <div className="flex items-center gap-2 font-medium text-success">
            <span>{translate("piiVaultPanel.active")}</span>
            <Badge variant={status.durable ? "default" : "warning"}>
              {status.durable ? translate("piiVaultPanel.durableEncrypted") : translate("piiVaultPanel.inMemoryPerReplica")}
            </Badge>
          </div>
          <p className="text-success">
            {translate("piiVaultPanel.detectedPIIIsReplacedWith")}
          </p>
          <div className="flex flex-wrap gap-1">
            {(status.piiTypes === "all" ? ["all types"] : status.piiTypes).map(
              (t) => (
                <span
                  key={t}
                  className="rounded bg-card border border-success-border px-1.5 py-0.5 text-[10px] font-mono text-success"
                >
                  {t}
                </span>
              ),
            )}
          </div>
          {status.detectors !== undefined && status.detectors.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-success">detectors:</span>
              {status.detectors.map((d) => (
                <span
                  key={d}
                  className="rounded bg-card border border-success-border px-1.5 py-0.5 text-[10px] font-mono text-success"
                >
                  {d}
                </span>
              ))}
            </div>
          )}
          {!status.durable && (
            <p className="text-warning">
              {translate("piiVaultPanel.noDatabaseConfiguredVaultMappings")} <code className="font-mono">DATABASE_URL</code>{" "}
              {translate("piiVaultPanel.forDurableEncryptedStorage")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
