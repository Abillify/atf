// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Keychain-Bridge (requirements 6.9, 13.2, 13.5, 15.3, 15.4).
 *
 * Das Sidecar hat keinen direkten Zugriff auf den Betriebssystem-Keychain —
 * der Rust-Host besitzt ihn. Die Bridge ist ein zeilenbasiertes JSON-RPC über
 * die stdio-Pipes des Sidecars: jede Anfrage ist eine Zeile
 * `{"id":N,"op":…}`, jede Antwort eine Zeile `{"id":N,…}`. Operationen:
 *
 * - `get`/`set`/`delete` — Keychain-Zugriff (Service `me.abillify.atf-outpost`)
 * - `loopback.open` — Host bindet `127.0.0.1:0` und meldet den Port
 * - `browser.open` — Host öffnet die Autorisierungs-URL
 * - `loopback.result` — Host liefert den gefangenen Redirect zurück
 *
 * Secrets gehen niemals auf Platte; ein Bridge-Fehler wird als Fehler
 * weitergereicht, es gibt keinen Fallback (15.4).
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
  /** get: der Wert oder null. */
  value?: string | null;
  /** loopback.open: der gebundene Port. */
  port?: number;
  /** loopback.result: query-Parameter des Redirects. */
  query?: Record<string, string>;
  /** Fehlercode ohne Geheimnis-Inhalte. */
  error?: string;
}

/** Transport: eine Anfrage senden, die zugehörige Antwort erwarten. */
export type BridgeTransport = (request: BridgeRequest) => Promise<BridgeResponse>;

/**
 * Zeilenbasierte JSON-Codec-Haelfte: zerlegt einen Textstrom in Zeilen und
 * serialisiert Anfragen. Getrennt vom Transport, damit Tests die Protokolle
 * ohne echte Pipes prüfen können.
 */
export class LineJsonCodec {
  private buffer = "";

  /** Füttere den Codec mit einem Chunk; liefert vollständige Objekte. */
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
        // Zeile ohne gültiges JSON wird verworfen — der Host antwortet erneut.
      }
    }
    return out;
  }

  /** Serialisiere eine Anfrage als Protokollzeile. */
  static encode(request: BridgeRequest): string {
    return `${JSON.stringify(request)}\n`;
  }
}

/**
 * {@link CredentialStore} über die Bridge. Fehler werden zu
 * {@link CredentialStoreError} — niemals zu einem stillen Fallback (15.4).
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

  /** Host bindet einen Loopback-Port für den PKCE-Redirect (6.9). */
  async openLoopback(): Promise<number> {
    const response = await this.send({ id: 0, op: "loopback.open" });
    if (!response.ok || response.port === undefined) {
      throw new CredentialStoreError("loopback.open fehlgeschlagen");
    }
    return response.port;
  }

  /** Host öffnet die Autorisierungs-URL im Standardbrowser. */
  async openBrowser(url: string): Promise<void> {
    const response = await this.send({ id: 0, op: "browser.open", url });
    if (!response.ok) {
      throw new CredentialStoreError("browser.open fehlgeschlagen");
    }
  }

  /** Host liefert den gefangenen Redirect (query-Parameter). */
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
 * Bridge über echte stdio-Pipes: Anfragen als Zeilen nach stdout des Hosts
 * (unser stdin-Reader liest die Antworten des Hosts von unserem stdout —
 * aus Sidecar-Sicht: Anfragen → process.stdout, Antworten ← process.stdin).
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
