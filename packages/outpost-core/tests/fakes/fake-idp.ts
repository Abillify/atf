// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Scriptable in-memory OIDC provider for auth tests. No network: every
 * request is answered from the script and recorded for assertions.
 */

import type { FetchLike } from "../../src/index.js";

export interface RecordedRequest {
  url: string;
  method: string;
  body: Record<string, string>;
}

export type TokenResponder = (
  params: Record<string, string>,
  callIndex: number,
) => { status: number; body: Record<string, unknown> };

export interface FakeIdpOptions {
  /** Responses for the device_authorization_endpoint, consumed in order. */
  deviceResponses?: Array<Record<string, unknown>>;
  /** Token endpoint behaviour. Defaults to a single success. */
  tokenResponder?: TokenResponder;
  /** Discovery document override. */
  discovery?: Record<string, unknown> | null;
}

const ISSUER = "https://idp.example.com";

export class FakeIdP {
  readonly requests: RecordedRequest[] = [];
  private deviceCalls = 0;
  private tokenCalls = 0;
  private readonly opts: FakeIdpOptions;

  constructor(opts: FakeIdpOptions = {}) {
    this.opts = opts;
  }

  get tokenEndpoint(): string {
    return `${ISSUER}/token`;
  }

  get deviceEndpoint(): string {
    return `${ISSUER}/device`;
  }

  readonly fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    const body = parseForm(init?.body);
    this.requests.push({ url, method, body });

    if (url.endsWith("/.well-known/openid-configuration")) {
      if (this.opts.discovery === null) return jsonResponse(500, { error: "boom" });
      return jsonResponse(200, {
        issuer: ISSUER,
        token_endpoint: this.tokenEndpoint,
        device_authorization_endpoint: this.deviceEndpoint,
        authorization_endpoint: `${ISSUER}/authorize`,
        ...this.opts.discovery,
      });
    }

    if (url === this.deviceEndpoint) {
      const responses = this.opts.deviceResponses ?? [defaultDeviceCode(this.deviceCalls)];
      const index = Math.min(this.deviceCalls, responses.length - 1);
      const bodyForCall = responses[index] ?? defaultDeviceCode(this.deviceCalls);
      this.deviceCalls++;
      return jsonResponse(200, bodyForCall);
    }

    if (url === this.tokenEndpoint) {
      const responder =
        this.opts.tokenResponder ??
        (() => ({
          status: 200,
          body: {
            access_token: `access-${this.tokenCalls}`,
            token_type: "Bearer",
            expires_in: 300,
            refresh_token: `refresh-${this.tokenCalls}`,
          },
        }));
      const result = responder(body, this.tokenCalls);
      this.tokenCalls++;
      return jsonResponse(result.status, result.body);
    }

    return jsonResponse(404, { error: "not_found" });
  };

  /** Requests sent to the token endpoint. */
  tokenRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.url === this.tokenEndpoint);
  }

  /** Requests sent to the device authorization endpoint. */
  deviceRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.url === this.deviceEndpoint);
  }
}

function parseForm(body: string | undefined): Record<string, string> {
  if (body === undefined || body.length === 0) return {};
  return Object.fromEntries(new URLSearchParams(body).entries());
}

function jsonResponse(status: number, body: Record<string, unknown>) {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body as unknown,
    text: async () => text,
  };
}

export function defaultDeviceCode(round: number): Record<string, unknown> {
  return {
    device_code: `device-${round}`,
    user_code: `USER-${round}`,
    verification_uri: "https://idp.example.com/activate",
    verification_uri_complete: `https://idp.example.com/activate?user_code=USER-${round}`,
    expires_in: 60,
    interval: 1,
  };
}
