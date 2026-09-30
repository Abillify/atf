// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Device_Code_Flow for the Docker runtime (requirements 2.1–2.5, 2.8, 4.5).
 *
 * Discovery provides the `device_authorization_endpoint`; the verification
 * URL and user code are logged as `auth.device_code`; polling follows the
 * reported `interval`, honours `slow_down` (+5 s) and restarts the whole flow
 * when the device code expires (`expired_token` or `expires_in` elapsed).
 * The issued refresh token is persisted under `auth:extract:refresh-token`.
 */

import type { Logger } from "pino";
import {
  AuthError,
  discover,
  interactiveScopes,
  tokenRequest,
  type FetchLike,
} from "./idp.js";
import { EXTRACT_REFRESH_TOKEN_KEY } from "../credentials/keys.js";
import type { CredentialStore } from "../credentials/store.js";

/** Extra delay applied on `slow_down` (RFC 8628 §3.5). */
export const SLOW_DOWN_INCREMENT_SEC = 5;

/** Abort check that stays type-safe regardless of the AbortSignal typing. */
const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal !== undefined && Boolean(signal.aborted);

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export interface DeviceFlowDeps {
  fetchImpl: FetchLike;
  store: CredentialStore;
  logger: Logger;
  /** Injectable sleep so tests run without real delays. */
  sleep: (ms: number) => Promise<void>;
  /** Injectable clock, epoch ms. */
  now: () => number;
  /** Abort signal — cancelling abandons the flow without persisting. */
  signal?: AbortSignal;
}

export interface DeviceFlowResult {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
}

/** Request a device authorization for `clientId`. */
export async function requestDeviceCode(
  issuer: string,
  clientId: string,
  scopes: readonly string[],
  audience: string | undefined,
  fetchImpl: FetchLike,
): Promise<{ endpoint: string; device: DeviceCodeResponse }> {
  const doc = await discover(issuer, fetchImpl);
  if (doc.device_authorization_endpoint === undefined) {
    throw new AuthError(
      "IdP does not advertise a device_authorization_endpoint",
      "device_flow_unsupported",
    );
  }
  const params: Record<string, string> = {
    client_id: clientId,
    scope: interactiveScopes(scopes).join(" "),
  };
  if (audience !== undefined) {
    params["audience"] = audience;
    params["resource"] = audience;
  }
  const response = await fetchImpl(doc.device_authorization_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) {
    throw new AuthError(
      `device authorization returned ${response.status}`,
      "device_authorization_failed",
    );
  }
  const body = (await response.json()) as Partial<DeviceCodeResponse>;
  if (
    typeof body.device_code !== "string" ||
    typeof body.user_code !== "string" ||
    typeof body.verification_uri !== "string" ||
    typeof body.expires_in !== "number" ||
    typeof body.interval !== "number"
  ) {
    throw new AuthError("device authorization response incomplete", "invalid_response");
  }
  return {
    endpoint: doc.token_endpoint,
    device: body as DeviceCodeResponse,
  };
}

/**
 * Run the Device_Code_Flow to completion. Persists the refresh token under
 * `auth:extract:refresh-token` (2.3) and returns the token set.
 */
export async function runDeviceCodeFlow(
  issuer: string,
  clientId: string,
  scopes: readonly string[],
  audience: string | undefined,
  deps: DeviceFlowDeps,
): Promise<DeviceFlowResult> {
  for (;;) {
    if (isAborted(deps.signal)) {
      throw new AuthError("device flow aborted", "aborted");
    }
    const { endpoint, device } = await requestDeviceCode(
      issuer,
      clientId,
      scopes,
      audience,
      deps.fetchImpl,
    );
    // 2.2: verification URL and user code go to the container log. The
    // values are not secrets in the RFC 8628 sense; the user needs them.
    deps.logger.info(
      {
        event: "auth.device_code",
        verification_uri: device.verification_uri,
        verification_uri_complete: device.verification_uri_complete ?? null,
        user_code: device.user_code,
      },
      "open the verification URL and enter the user code to sign in",
    );

    const deadline = deps.now() + device.expires_in * 1000;
    let intervalSec = device.interval;

    // Poll until approved, expired, or aborted.
    for (;;) {
      if (isAborted(deps.signal)) {
        throw new AuthError("device flow aborted", "aborted");
      }
      await deps.sleep(intervalSec * 1000);
      if (isAborted(deps.signal)) {
        throw new AuthError("device flow aborted", "aborted");
      }
      if (deps.now() >= deadline) break; // 2.8: expired → restart below.

      let tokens: Awaited<ReturnType<typeof tokenRequest>>;
      try {
        tokens = await tokenRequest(
          endpoint,
          {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: device.device_code,
            client_id: clientId,
          },
          deps.fetchImpl,
        );
      } catch (error) {
        const code = error instanceof AuthError ? error.code : "unknown";
        if (code === "authorization_pending") continue;
        if (code === "slow_down") {
          intervalSec += SLOW_DOWN_INCREMENT_SEC;
          continue;
        }
        if (code === "expired_token") break; // 2.8: restart the flow.
        throw error;
      }

      // Approved. A device grant without refresh_token would break the
      // daemon's long-lived operation; treat it as an error.
      const refreshToken = tokens.refresh_token;
      if (refreshToken === undefined) {
        throw new AuthError("device flow did not return a refresh token", "no_refresh_token");
      }
      await deps.store.set(EXTRACT_REFRESH_TOKEN_KEY, refreshToken);
      return {
        accessToken: tokens.access_token,
        refreshToken,
        expiresInSec: tokens.expires_in ?? 300,
      };
    }
    // Device code expired: loop restarts the flow and logs a fresh URL (2.8).
    deps.logger.warn({ event: "auth.device_code_expired" }, "device code expired, restarting");
  }
}
