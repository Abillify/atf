// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Keychain bridge (requirements 6.9, 13.2, 13.5, 15.3, 15.4).
 *
 * The sidecar has no direct access to the operating-system keychain; the
 * Rust host owns it. The bridge is a line-based JSON-RPC over the sidecar's
 * stdio pipes: every request is one line
 * `{"id":N,"op":…}`, every response one line `{"id":N,…}`. Operations:
 *
 * - `get`/`set`/`delete`: keychain access (service `me.abillify.atf-outpost`)
 * - `loopback.open`: the host binds `127.0.0.1:0` and reports the port
 * - `browser.open`: the host opens the authorization URL
 * - `loopback.result`: the host returns the captured redirect
 *
 * Secrets never go to disk; a bridge error is passed on as an error, there
 * is no fallback (15.4).
 */

import { type CredentialStore, CredentialStoreError } from "@atf/outpost-core";

export interface BridgeRequest {
  id: number;
  op: "get" | "set" | "delete" | "loopback.open" | "browser.open" | "loopback.result";
  key?: string;
  value?: string;
  url?: string;
}

export interface BridgeResponse {
  id: number;
  ok: boolean;
  /** get: the value or null. */
  value?: string | null;
  /** loopback.open: the bound port. */
  port?: number;
  /** loopback.result: query parameters of the redirect. */
  query?: Record<string, string>;
  /** Error code without secret content. */
  error?: string;
}

/** Transport: send a request, expect the matching response. */
export type BridgeTransport = (request: BridgeRequest) => Promise<BridgeResponse>;

/**
 * Line-based JSON codec half: splits a text stream into lines and
 * serializes requests. Separate from the transport so tests can check the
 * protocols without real pipes.
 */
export class LineJsonCodec {
  private buffer = "";

  /** Feed the codec a chunk; returns complete objects. */
  push(chunk: string): BridgeResponse[] {
    this.buffer += chunk;
    const out: BridgeResponse[] = [];
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line === "") continue;
      try {
        out.push(JSON.parse(line) as BridgeResponse);
      } catch {
        // A line without valid JSON is discarded; the host answers again.
      }
    }
    return out;
  }

  /** Serialize a request as a protocol line. */
  static encode(request: BridgeRequest): string {
    return `${JSON.stringify(request)}\n`;
  }
}

/**
 * {@link CredentialStore} over the bridge. Errors become
 * {@link CredentialStoreError}, never a silent fallback (15.4).
 */
export class KeychainBridgeStore implements CredentialStore {
  constructor(private readonly transport: BridgeTransport) {}

  async get(key: string): Promise<string | null> {
    const response = await this.send({ id: 0, op: "get", key });
    if (!response.ok) {
      throw new CredentialStoreError(`keychain get fehlgeschlagen: ${response.error ?? "unbekannt"}`);
    }
    return response.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    const response = await this.send({ id: 0, op: "set", key, value });
    if (!response.ok) {
      throw new CredentialStoreError(`keychain set fehlgeschlagen: ${response.error ?? "unbekannt"}`);
    }
  }

  async delete(key: string): Promise<void> {
    const response = await this.send({ id: 0, op: "delete", key });
    if (!response.ok) {
      throw new CredentialStoreError(`keychain delete fehlgeschlagen: ${response.error ?? "unbekannt"}`);
    }
  }

  /** The host binds a loopback port for the PKCE redirect (6.9). */
  async openLoopback(): Promise<number> {
    const response = await this.send({ id: 0, op: "loopback.open" });
    if (!response.ok || response.port === undefined) {
      throw new CredentialStoreError("loopback.open fehlgeschlagen");
    }
    return response.port;
  }

  /** The host opens the authorization URL in the default browser. */
  async openBrowser(url: string): Promise<void> {
    const response = await this.send({ id: 0, op: "browser.open", url });
    if (!response.ok) {
      throw new CredentialStoreError("browser.open fehlgeschlagen");
    }
  }

  /** The host returns the captured redirect (query parameters). */
  async loopbackResult(): Promise<Record<string, string>> {
    const response = await this.send({ id: 0, op: "loopback.result" });
    if (!response.ok || response.query === undefined) {
      throw new CredentialStoreError("loopback.result fehlgeschlagen");
    }
    return response.query;
  }

  private async send(request: BridgeRequest): Promise<BridgeResponse> {
    try {
      return await this.transport(request);
    } catch (error) {
      throw new CredentialStoreError("keychain bridge nicht erreichbar", { cause: error });
    }
  }
}

/**
 * Bridge over real stdio pipes: requests as lines to the host's stdout
 * (our stdin reader reads the host's answers from our stdout; from the
 * sidecar's point of view: requests → process.stdout, answers ← process.stdin).
 */
export function createStdioBridge(
  writeLine: (line: string) => void,
  onLine: (handler: (line: string) => void) => () => void,
  timeoutMs = 30_000,
): BridgeTransport {
  let nextId = 1;
  const pending = new Map<number, { resolve: (r: BridgeResponse) => void; reject: (e: unknown) => void }>();
  const codec = new LineJsonCodec();
  onLine((line) => {
    for (const response of codec.push(`${line}\n`)) {
      const waiter = pending.get(response.id);
      if (waiter !== undefined) {
        pending.delete(response.id);
        waiter.resolve(response);
      }
    }
  });
  return (request) =>
    new Promise<BridgeResponse>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("bridge timeout"));
      }, timeoutMs);
      pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      writeLine(LineJsonCodec.encode({ ...request, id }));
    });
}
