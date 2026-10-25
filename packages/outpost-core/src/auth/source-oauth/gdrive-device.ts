// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Optional Google Drive device flow.
 *
 * Only used when `deviceFlow: true` is configured. Google currently rejects
 * the `drive.readonly` scope on the device endpoint (`invalid_scope`); the
 * outpost does NOT assume that statically — it asks, and on `invalid_scope`
 * logs the fact and falls back to code-paste (6.14). Otherwise the
 * verification URL and user code are printed for the user.
 */

import type { FetchLike } from "../idp.js";
import { PROVIDERS, GDRIVE_SCOPE } from "./providers.js";

export interface GdriveDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSec: number;
  intervalSec: number;
}

export type GdriveDeviceResult =
  | { kind: "device-code"; device: GdriveDeviceCode }
  | { kind: "invalid-scope" };

/**
 * Send the device authorization request with `drive.readonly`. A provider
 * answer of `invalid_scope` becomes `{kind:"invalid-scope"}` — the caller
 * logs it and falls back to code-paste (feature check, 6.15). Network/5xx
 * failures throw so the caller reports a transient source error.
 */
export async function requestGdriveDeviceCode(
  clientId: string,
  fetchImpl: FetchLike,
): Promise<GdriveDeviceResult> {
  const endpoint = PROVIDERS.gdrive.deviceEndpoint;
  if (endpoint === undefined) {
    throw new Error("GDrive device endpoint not configured");
  }
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({ client_id: clientId, scope: GDRIVE_SCOPE }).toString(),
    });
  } catch (cause) {
    throw new Error("Google-Device-Endpunkt nicht erreichbar", { cause });
  }
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    // non-JSON → status classification below
  }
  if (!response.ok) {
    const error = typeof parsed["error"] === "string" ? (parsed["error"] as string) : "";
    if (error === "invalid_scope") {
      return { kind: "invalid-scope" };
    }
    if (response.status >= 500) {
      throw new Error(`Google-Device-Endpunkt antwortete mit ${response.status}`);
    }
    // Other 4xx (invalid_client, …): configuration problem, not a scope
    // problem — surface it without echoing the body.
    throw new Error(`Google-Device-Endpunkt lehnte die Anfrage ab (${response.status})`);
  }
  const deviceCode = parsed["device_code"];
  const userCode = parsed["user_code"];
  const verificationUri = parsed["verification_uri"];
  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string"
  ) {
    throw new Error("Device-Antwort unvollständig");
  }
  return {
    kind: "device-code",
    device: {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete:
        typeof parsed["verification_uri_complete"] === "string"
          ? (parsed["verification_uri_complete"] as string)
          : undefined,
      expiresInSec: typeof parsed["expires_in"] === "number" ? (parsed["expires_in"] as number) : 1800,
      intervalSec: typeof parsed["interval"] === "number" ? (parsed["interval"] as number) : 5,
    },
  };
}

export type GdriveAuthPlan =
  | { kind: "device-flow"; device: GdriveDeviceCode }
  | { kind: "code-paste"; reason?: "invalid-scope" };

/**
 * Decide how to authorize a GDrive source (6.15). Without `deviceFlow` the
 * code-paste flow is used directly. With it, the device endpoint is probed:
 * a usable device code wins; `invalid_scope` is logged and falls back to
 * code-paste — the fallback is a runtime feature check, not a static switch.
 */
export async function startGdriveAuthorization(args: {
  clientId: string;
  deviceFlow: boolean;
  fetchImpl: FetchLike;
  log: (message: string, fields?: Record<string, unknown>) => void;
}): Promise<GdriveAuthPlan> {
  if (!args.deviceFlow) {
    return { kind: "code-paste" };
  }
  const result = await requestGdriveDeviceCode(args.clientId, args.fetchImpl);
  if (result.kind === "device-code") {
    return { kind: "device-flow", device: result.device };
  }
  args.log("source.gdrive.device_flow_unavailable", {
    reason: "invalid_scope",
    fallback: "code-paste",
  });
  return { kind: "code-paste", reason: "invalid-scope" };
}
