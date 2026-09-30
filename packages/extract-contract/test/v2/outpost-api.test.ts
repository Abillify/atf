// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * outpost-api.test.ts
 *
 * The wire shapes the Extract Outpost relies on from Extract: `GET /v1/whoami`
 * (E1, requirements 5.1, 5.2) and `DELETE /v2/documents/{reference}` (E2,
 * requirements 9.7, 9.9). The whoami feature flags are what a client validates
 * before its first upload; the delete response is what makes mirror-delete
 * idempotent (`200` with `deleted >= 0`, `404` handled client-side as "gone").
 */

import { describe, expect, test } from "bun:test";
import { deleteDocumentResponseSchema, whoamiResponseSchema } from "../../src/v2/index.js";

describe("whoamiResponseSchema", () => {
  const base = {
    source: "jwt" as const,
    scopes: ["extract.ingest"],
    service: { name: "atf-extract" as const, version: "0.11.0" },
    features: {
      ingest: true,
      resumableUploads: true,
      deleteByReference: true,
      ownJobRead: true,
    },
    limits: { maxUploadBytes: 52_428_800 },
  };

  test("accepts a full JWT principal", () => {
    const parsed = whoamiResponseSchema.parse({
      ...base,
      subject: "user-42",
      tenantId: "tenant-a",
      issuer: "https://idp.example/realms/atf",
      audience: ["atf-extract", "atf-search"],
    });
    expect(parsed.subject).toBe("user-42");
    expect(parsed.tenantId).toBe("tenant-a");
    expect(parsed.audience).toEqual(["atf-extract", "atf-search"]);
    expect(parsed.features.deleteByReference).toBe(true);
    expect(parsed.limits.maxUploadBytes).toBe(52_428_800);
  });

  test("accepts an anonymous caller with no identity fields", () => {
    const parsed = whoamiResponseSchema.parse({
      ...base,
      source: "anonymous",
      scopes: [],
      features: {
        ingest: false,
        resumableUploads: false,
        deleteByReference: false,
        ownJobRead: false,
      },
    });
    expect(parsed.subject).toBeUndefined();
    expect(parsed.tenantId).toBeUndefined();
    expect(parsed.issuer).toBeUndefined();
    expect(parsed.features.ingest).toBe(false);
  });

  test("accepts a string audience (single client binding)", () => {
    const parsed = whoamiResponseSchema.parse({ ...base, audience: "atf-extract" });
    expect(parsed.audience).toBe("atf-extract");
  });

  test("rejects an unknown identity source", () => {
    expect(() => whoamiResponseSchema.parse({ ...base, source: "api-key" })).toThrow();
  });

  test("rejects a foreign service name", () => {
    expect(() =>
      whoamiResponseSchema.parse({ ...base, service: { name: "atf-search", version: "1" } }),
    ).toThrow();
  });

  test("rejects a missing feature flag (a client must not guess)", () => {
    const { deleteByReference: _drop, ...features } = base.features;
    expect(() => whoamiResponseSchema.parse({ ...base, features })).toThrow();
  });

  test("rejects a non-integer maxUploadBytes", () => {
    expect(() =>
      whoamiResponseSchema.parse({ ...base, limits: { maxUploadBytes: 1.5 } }),
    ).toThrow();
    expect(() =>
      whoamiResponseSchema.parse({ ...base, limits: { maxUploadBytes: "52428800" } }),
    ).toThrow();
  });

  test("round-trips parse → serialize → parse", () => {
    const original = whoamiResponseSchema.parse({
      ...base,
      subject: "user-1",
      tenantId: "t",
      issuer: "https://idp",
      audience: "atf",
    });
    const again = whoamiResponseSchema.parse(JSON.parse(JSON.stringify(original)));
    expect(again).toEqual(original);
  });
});

describe("deleteDocumentResponseSchema", () => {
  test("accepts a successful delete", () => {
    const parsed = deleteDocumentResponseSchema.parse({
      status: "deleted",
      reference: "outpost:src1:abcdefghijklmnopqrstuvwxyz012345",
      collection: "vertrag_abillify",
      deleted: 3,
    });
    expect(parsed.status).toBe("deleted");
    expect(parsed.deleted).toBe(3);
  });

  test("accepts deleted = 0 (the schema does not encode the 404 rule)", () => {
    const parsed = deleteDocumentResponseSchema.parse({
      status: "deleted",
      reference: "r",
      collection: "c",
      deleted: 0,
    });
    expect(parsed.deleted).toBe(0);
  });

  test("rejects a negative delete count", () => {
    expect(() =>
      deleteDocumentResponseSchema.parse({
        status: "deleted",
        reference: "r",
        collection: "c",
        deleted: -1,
      }),
    ).toThrow();
  });

  test("rejects a status other than \"deleted\"", () => {
    expect(() =>
      deleteDocumentResponseSchema.parse({
        status: "ok",
        reference: "r",
        collection: "c",
        deleted: 1,
      }),
    ).toThrow();
  });

  test("round-trips parse → serialize → parse", () => {
    const original = deleteDocumentResponseSchema.parse({
      status: "deleted",
      reference: "outpost:src1:0123456789abcdef0123456789abcdef",
      collection: "acc",
      deleted: 1,
    });
    const again = deleteDocumentResponseSchema.parse(JSON.parse(JSON.stringify(original)));
    expect(again).toEqual(original);
  });
});
