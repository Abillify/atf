// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for the Extract client endpoints (tasks 11.1–11.3):
 * whoami, ingest (sync/async), delete (200/404 = Erfolg, 403 =
 * DeleteForbiddenError) and the pure connection evaluation (5.1, 5.2, 9.10).
 */

import { createHash } from "node:crypto";
import type { WhoamiResponse } from "@atf/extract-contract/v2";
import { describe, expect, it } from "vitest";
import {
  classifyWhoamiError,
  DeleteForbiddenError,
  deleteByReference,
  evaluateConnection,
  ExtractApiError,
  ExtractHttpClient,
  ingest,
  ReauthRequiredError,
  TlsFailureError,
  verifyConnection,
  whoami,
  type WhoamiOutcome,
} from "../../src/index.js";
import { FakeExtract } from "../fakes/fake-extract.js";
import { testLogger } from "../fakes/test-logger.js";
import { FakeTokenProvider } from "../fakes/fake-token-provider.js";

void testLogger; // keep the import surface stable for future log assertions

function clientWith(fake: FakeExtract): ExtractHttpClient {
  return new ExtractHttpClient({
    extractUrl: "https://extract.example.com",
    tokenProvider: new FakeTokenProvider("tok"),
    version: "0.1.0",
    runtime: "docker",
    fetchImpl: fake.fetchImpl as unknown as typeof globalThis.fetch,
  });
}

const sha = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

function whoamiWith(overrides: Partial<WhoamiResponse>): WhoamiResponse {
  return {
    source: "service",
    scopes: ["extract.ingest", "extract.delete"],
    service: { name: "atf-extract", version: "0.11.0" },
    features: {
      ingest: true,
      resumableUploads: true,
      deleteByReference: true,
      ownJobRead: true,
    },
    limits: { maxUploadBytes: 52_428_800 },
    ...overrides,
  };
}

describe("whoami (11.1)", () => {
  it("liefert die validierte Antwort", async () => {
    const fake = new FakeExtract();
    const response = await whoami(clientWith(fake));
    expect(response.service.name).toBe("atf-extract");
    expect(response.features.ingest).toBe(true);
  });

  it("wirft bei 401 (Client: ReauthRequiredError nach einmaligem Refresh)", async () => {
    const fake = new FakeExtract({ requireToken: "other" });
    const error = await whoami(clientWith(fake)).catch((e: unknown) => e);
    // Der Client wiederholt nach forceRefresh genau einmal; der zweite 401
    // wird zu ReauthRequiredError (4.4) — beides bedeutet abgelehnt.
    expect(
      error instanceof ReauthRequiredError ||
        (error instanceof ExtractApiError && error.status === 401),
    ).toBe(true);
    const outcome = classifyWhoamiError(error);
    expect(outcome.kind).toBe("unauthorized");
  });
});

describe("ingest (11.1)", () => {
  it("sendet multipart im Feld document und liefert ok", async () => {
    const fake = new FakeExtract();
    const bytes = new Uint8Array([1, 2, 3]);
    const result = await ingest(
      clientWith(fake),
      { "x-reference": "outpost:a:b", "x-collection": "docs" },
      bytes,
      "a.txt",
    );
    expect(result).toEqual({ kind: "ingested", status: "ok", reference: "outpost:a:b", collection: "docs" });
    expect(fake.documents.get("docs")?.get("outpost:a:b")).toBe(sha(bytes));
  });

  it("liefert accepted mit job_id bei 202", async () => {
    const fake = new FakeExtract({ ingestMode: "async" });
    const result = await ingest(
      clientWith(fake),
      { "x-reference": "r1" },
      new Uint8Array([4, 5]),
      "b.txt",
    );
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") expect(result.jobId).toBe("job-1");
  });

  it("markiert Duplicate als skipped", async () => {
    const fake = new FakeExtract();
    const client = clientWith(fake);
    const bytes = new Uint8Array([7]);
    await ingest(client, { "x-reference": "r", "x-collection": "c" }, bytes, "c.txt");
    const again = await ingest(client, { "x-reference": "r", "x-collection": "c" }, bytes, "c.txt");
    expect(again.kind === "ingested" && again.status).toBe("skipped");
  });
});

describe("deleteByReference (11.1)", () => {
  it("200 = deleted", async () => {
    const fake = new FakeExtract();
    const client = clientWith(fake);
    await ingest(client, { "x-reference": "r", "x-collection": "c" }, new Uint8Array([1]), "f");
    const result = await deleteByReference(client, "c", "r");
    expect(result.kind).toBe("deleted");
  });

  it("404 = not-found gilt als Erfolg", async () => {
    const fake = new FakeExtract();
    const result = await deleteByReference(clientWith(fake), "c", "fehlt");
    expect(result).toEqual({ kind: "not-found" });
  });

  it("403 = DeleteForbiddenError (9.8)", async () => {
    const fake = new FakeExtract({ deleteForbidden: true });
    const error = await deleteByReference(clientWith(fake), "c", "r").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeleteForbiddenError);
  });
});

describe("evaluateConnection (11.3, 5.1, 5.2, 9.10)", () => {
  const MIRROR_ON = { mirrorDelete: true };
  const MIRROR_OFF = { mirrorDelete: false };

  it("ok bei vollständigem Token und Features", () => {
    const result = evaluateConnection(
      { kind: "ok", response: whoamiWith({}) },
      MIRROR_ON,
    );
    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(result.maxUploadBytes).toBe(52_428_800);
  });

  it("TLS-Fehler wird mit Code und URL gemeldet (5.3)", () => {
    const result = evaluateConnection(
      { kind: "tls", code: "CERT_HAS_EXPIRED", checkedUrl: "https://e.example/x" },
      MIRROR_OFF,
    );
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.code).toBe("tls");
    expect(result.findings[0]?.message).toContain("CERT_HAS_EXPIRED");
    expect(result.findings[0]?.message).toContain("https://e.example/x");
  });

  it("401 → unauthorized (5.2)", () => {
    const result = evaluateConnection({ kind: "unauthorized" }, MIRROR_OFF);
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.code).toBe("unauthorized");
  });

  it("fehlender Scope extract.ingest → Fehler (5.2)", () => {
    const result = evaluateConnection(
      { kind: "ok", response: whoamiWith({ scopes: [] }) },
      MIRROR_OFF,
    );
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === "missing_ingest_scope")).toBe(true);
  });

  it("Instanz ohne Authentifizierung (anonymous): Scope-Fehler wird Warnung", () => {
    const result = evaluateConnection(
      { kind: "ok", response: whoamiWith({ source: "anonymous", scopes: [] }) },
      MIRROR_ON,
    );
    expect(result.ok).toBe(true);
    expect(
      result.findings.every(
        (f) =>
          f.severity === "warning" &&
          (f.code === "missing_ingest_scope" || f.code === "missing_delete_scope"),
      ),
    ).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it("Mirror_Delete ohne extract.delete → Fehler (9.10)", () => {
    const result = evaluateConnection(
      { kind: "ok", response: whoamiWith({ scopes: ["extract.ingest"] }) },
      MIRROR_ON,
    );
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === "missing_delete_scope")).toBe(true);
  });

  it("Mirror_Delete ohne deleteByReference-Feature → Fehler (9.10)", () => {
    const response = whoamiWith({});
    response.features.deleteByReference = false;
    const result = evaluateConnection({ kind: "ok", response }, MIRROR_ON);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === "delete_not_available")).toBe(true);
  });

  it("Mirror_Delete aus → fehlender delete-Scope ist kein Fehler", () => {
    const result = evaluateConnection(
      { kind: "ok", response: whoamiWith({ scopes: ["extract.ingest"] }) },
      MIRROR_OFF,
    );
    expect(result.ok).toBe(true);
  });

  it("ownJobRead=false ohne extract.admin → Warnung, ok bleibt true", () => {
    const response = whoamiWith({});
    response.features.ownJobRead = false;
    const result = evaluateConnection({ kind: "ok", response }, MIRROR_OFF);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([
      expect.objectContaining({ severity: "warning", code: "own_job_read" }),
    ]);
  });

  it("ownJobRead=false MIT extract.admin → keine Warnung", () => {
    const response = whoamiWith({ scopes: ["extract.ingest", "extract.admin"] });
    response.features.ownJobRead = false;
    const result = evaluateConnection({ kind: "ok", response }, MIRROR_OFF);
    expect(result.findings).toHaveLength(0);
  });

  it("ingest nicht montiert → Fehler", () => {
    const response = whoamiWith({});
    response.features.ingest = false;
    const result = evaluateConnection({ kind: "ok", response }, MIRROR_OFF);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === "ingest_not_mounted")).toBe(true);
  });

  it("classifyWhoamiError ordnet Fehlerquellen", () => {
    const tls: WhoamiOutcome = classifyWhoamiError(
      new TlsFailureError("DEPTH_ZERO_SELF_SIGNED_CERT", "https://x/"),
    );
    expect(tls.kind).toBe("tls");
    const api: WhoamiOutcome = classifyWhoamiError(new ExtractApiError(503, undefined, "down"));
    expect(api).toEqual({ kind: "http", status: 503 });
    const net: WhoamiOutcome = classifyWhoamiError(new TypeError("fetch failed"));
    expect(net.kind).toBe("network");
  });

  it("verifyConnection ruft whoami auf und wertet aus", async () => {
    const fake = new FakeExtract();
    const result = await verifyConnection(clientWith(fake), MIRROR_ON);
    expect(result.ok).toBe(true);
    expect(fake.requests.some((r) => r.method === "GET" && r.url.endsWith("/v1/whoami"))).toBe(true);
  });

  it("verifyConnection meldet Netzwerkfehler als Befund", async () => {
    const fake = new FakeExtract();
    fake.inject({ kind: "network-error", pathIncludes: "/v1/whoami" });
    const result = await verifyConnection(clientWith(fake), MIRROR_ON);
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.code).toBe("network");
  });
});
