// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Connection check (requirements 5.1, 5.2, 5.3, 9.10).
 *
 * `evaluateConnection` is pure: it takes the outcome of a `whoami` call (or
 * the error class that prevented one) plus the relevant configuration and
 * returns the findings. Every finding with severity `error` prevents the
 * first sync run (5.2); the `ownJobRead` finding is a warning only. The thin
 * wrapper `verifyConnection` performs the call and classifies transport
 * errors (TLS, network, HTTP) into the same outcome union.
 */

import type { WhoamiResponse } from "@atf/extract-contract/v2";
import type { ExtractHttpClient } from "../http/client.js";
import { ReauthRequiredError, TlsFailureError } from "../http/client.js";
import { whoami } from "./whoami.js";
import { ExtractApiError } from "./api-error.js";

/** The classification of a single `whoami` attempt. */
export type WhoamiOutcome =
  | { kind: "ok"; response: WhoamiResponse }
  /** `401` — the credential itself is rejected. */
  | { kind: "unauthorized" }
  /** TLS handshake failed; carries the concrete code and checked URL (5.3). */
  | { kind: "tls"; code: string; checkedUrl: string }
  /** No HTTP response at all (DNS, refused, timeout). */
  | { kind: "network"; message: string }
  /** Any other HTTP status. */
  | { kind: "http"; status: number };

export type FindingCode =
  | "tls"
  | "network"
  | "unauthorized"
  | "http"
  | "ingest_not_mounted"
  | "missing_ingest_scope"
  | "missing_delete_scope"
  | "delete_not_available"
  | "own_job_read";

export interface ConnectionFinding {
  severity: "error" | "warning";
  code: FindingCode;
  message: string;
}

export interface ConnectionResult {
  /** True when no finding with severity `error` exists (5.2). */
  ok: boolean;
  findings: ConnectionFinding[];
  /** From `whoami.limits` — lets the planner reject oversized files (5.1). */
  maxUploadBytes: number | undefined;
}

/** The configuration slice the check depends on. */
export interface ConnectionConfig {
  mirrorDelete: boolean;
}

function hasScope(response: WhoamiResponse, scope: string): boolean {
  return response.scopes.includes(scope);
}

/**
 * Pure evaluation of a whoami outcome against the configuration.
 * Never performs I/O — trivially testable with any outcome.
 */
export function evaluateConnection(
  outcome: WhoamiOutcome,
  cfg: ConnectionConfig,
): ConnectionResult {
  switch (outcome.kind) {
    case "tls":
      return {
        ok: false,
        maxUploadBytes: undefined,
        findings: [
          {
            severity: "error",
            code: "tls",
            message: `TLS-Fehler ${outcome.code} bei ${outcome.checkedUrl}`,
          },
        ],
      };
    case "network":
      return {
        ok: false,
        maxUploadBytes: undefined,
        findings: [
          {
            severity: "error",
            code: "network",
            message: `Verbindung fehlgeschlagen: ${outcome.message}`,
          },
        ],
      };
    case "unauthorized":
      return {
        ok: false,
        maxUploadBytes: undefined,
        findings: [
          {
            severity: "error",
            code: "unauthorized",
            message: "Zugriff abgelehnt (401): Token ungültig oder abgelaufen",
          },
        ],
      };
    case "http":
      return {
        ok: false,
        maxUploadBytes: undefined,
        findings: [
          {
            severity: "error",
            code: "http",
            message: `whoami antwortete mit HTTP ${outcome.status}`,
          },
        ],
      };
    case "ok": {
      const response = outcome.response;
      const findings: ConnectionFinding[] = [];
      // Eine Instanz ohne Authentifizierung (`AUTHN_MODE=disabled`,
      // Entwicklung/Test) meldet `source: "anonymous"` und strukturell leere
      // Scopes, gewährt aber alles — eine Scope-Prüfung wäre hier ein
      // Fehlalarm und würde die Entwicklung gegen eine lokale Instanz
      // unmachen. Feature-Prüfungen (montierte Routen) bleiben Fehler.
      const authDisabled = response.source === "anonymous";
      const scopeSeverity: "error" | "warning" = authDisabled ? "warning" : "error";
      if (!response.features.ingest) {
        findings.push({
          severity: "error",
          code: "ingest_not_mounted",
          message: "Der Extract_Service hat keinen Ingest-Endpunkt montiert",
        });
      }
      if (!hasScope(response, "extract.ingest")) {
        findings.push({
          severity: scopeSeverity,
          code: "missing_ingest_scope",
          message: authDisabled
            ? "Die Instanz läuft ohne Authentifizierung; der Scope extract.ingest wird nicht geprüft"
            : "Dem Token fehlt der Scope extract.ingest",
        });
      }
      if (cfg.mirrorDelete) {
        // 9.10: mirror-delete must be rejected up front, not mid-run.
        if (!hasScope(response, "extract.delete")) {
          findings.push({
            severity: scopeSeverity,
            code: "missing_delete_scope",
            message: authDisabled
              ? "Die Instanz läuft ohne Authentifizierung; der Scope extract.delete wird nicht geprüft"
              : "Mirror_Delete ist aktiv, aber dem Token fehlt der Scope extract.delete",
          });
        }
        if (!response.features.deleteByReference) {
          findings.push({
            severity: "error",
            code: "delete_not_available",
            message:
              "Mirror_Delete ist aktiv, aber der Extract_Service bietet kein Löschen per Reference an",
          });
        }
      }
      if (!response.features.ownJobRead && !hasScope(response, "extract.admin")) {
        // Without E3 and without extract.admin, 202-jobs cannot be polled.
        findings.push({
          severity: "warning",
          code: "own_job_read",
          message:
            "Der Extract_Service unterstützt keine eigentümergelesene Job-Abfrage; ohne Scope extract.admin bleiben angenommene Jobs im nächsten Lauf offen",
        });
      }
      return {
        ok: !findings.some((f) => f.severity === "error"),
        findings,
        maxUploadBytes: response.limits.maxUploadBytes,
      };
    }
  }
}

/** Classify an exception thrown by `whoami()` into the outcome union. */
export function classifyWhoamiError(error: unknown): WhoamiOutcome {
  if (error instanceof TlsFailureError) {
    return { kind: "tls", code: error.code, checkedUrl: error.checkedUrl };
  }
  // The client turns a repeated 401 into ReauthRequiredError (4.4); a bare
  // 401 surfaces as ExtractApiError. Both mean the credential is rejected.
  if (error instanceof ReauthRequiredError) {
    return { kind: "unauthorized" };
  }
  if (error instanceof ExtractApiError) {
    if (error.status === 401) return { kind: "unauthorized" };
    return { kind: "http", status: error.status };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { kind: "network", message };
}

/**
 * Thin wrapper: call `whoami()` and evaluate the result (5.1). Performs no
 * configuration decisions itself — all logic lives in `evaluateConnection`.
 */
export async function verifyConnection(
  client: ExtractHttpClient,
  cfg: ConnectionConfig,
  signal?: AbortSignal,
): Promise<ConnectionResult> {
  let outcome: WhoamiOutcome;
  try {
    outcome = { kind: "ok", response: await whoami(client, signal) };
  } catch (error) {
    outcome = classifyWhoamiError(error);
  }
  return evaluateConnection(outcome, cfg);
}
