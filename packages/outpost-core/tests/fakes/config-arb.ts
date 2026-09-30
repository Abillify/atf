// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Shared arbitraries for the configuration tests.
 *
 * `configInputArb` generates *schema-shaped* inputs (not yet validated): the
 * properties compare "validate → serialize → parse → validate", so the input
 * may omit optional fields and defaults fill them in identically on both
 * sides. `envValueArb` produces a valid string for one `ENV_MAP` entry so the
 * precedence property can set any subset of `OUTPOST_*` variables.
 */

import fc from "fast-check";
import type { EnvMapEntry } from "../../src/config/merge.js";

const identifierChar = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_".split(""),
);

/** Strings matching `^[a-zA-Z][a-zA-Z0-9_]*$` — the collection pattern. */
export const collectionArb = fc
  .tuple(
    fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
    ),
    fc.array(identifierChar, { minLength: 0, maxLength: 12 }),
  )
  .map(([first, rest]) => first + rest.join(""));

/** Source ids: `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. */
export const sourceIdArb = fc
  .tuple(
    fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split(""),
    ),
    fc.array(
      fc.constantFrom(
        ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-".split(""),
      ),
      { minLength: 0, maxLength: 10 },
    ),
  )
  .map(([first, rest]) => first + rest.join(""));

const httpsUrlArb = fc
  .tuple(
    fc.constantFrom("example.com", "extract.internal", "docs.example.co.uk"),
    fc.integer({ min: 1, max: 65535 }),
    fc.constantFrom("", "/extract", "/api/v1"),
  )
  .map(([host, port, path]) => `https://${host}:${port}${path}`);

const metadataArb = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 8 }),
  fc.string({ minLength: 0, maxLength: 12 }),
  { maxKeys: 3 },
);

// The common fields are inlined into each source record: fast-check 4 has no
// `chain`, and a single `record` keeps the generated object's key order stable.
const commonFields = {
  collection: fc.option(collectionArb, { nil: undefined }),
  include: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 3 }), {
    nil: undefined,
  }),
  exclude: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 3 }), {
    nil: undefined,
  }),
  tags: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 3 }), {
    nil: undefined,
  }),
  metadata: fc.option(metadataArb, { nil: undefined }),
  allowedUsers: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 2 }), {
    nil: undefined,
  }),
  allowedGroups: fc.option(
    fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 2 }),
    { nil: undefined },
  ),
};

const localSourceArb = fc.record({
  type: fc.constant("local" as const),
  id: sourceIdArb,
  path: fc.string({ minLength: 1, maxLength: 16 }).map((s) => `/srv/${s || "docs"}`),
  watch: fc.boolean(),
  ...commonFields,
});

const s3SourceArb = fc.record({
  type: fc.constant("s3" as const),
  id: sourceIdArb,
  bucket: fc.string({ minLength: 1, maxLength: 12 }).map((s) => `b-${s || "x"}`),
  prefix: fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: undefined }),
  region: fc.option(fc.constantFrom("eu-central-1", "us-east-1"), { nil: undefined }),
  endpoint: fc.option(httpsUrlArb, { nil: undefined }),
  forcePathStyle: fc.option(fc.boolean(), { nil: undefined }),
  credentials: fc.constantFrom("store" as const, "default-chain" as const),
  ...commonFields,
});

const gdriveSourceArb = fc.record({
  type: fc.constant("gdrive" as const),
  id: sourceIdArb,
  folderId: fc.string({ minLength: 1, maxLength: 16 }).map((s) => `fid-${s || "x"}`),
  exportFormat: fc.constantFrom("pdf" as const, "docx" as const, "xlsx" as const, "pptx" as const),
  auth: fc.constantFrom("oauth" as const, "service-account" as const),
  deviceFlow: fc.option(fc.boolean(), { nil: undefined }),
  ...commonFields,
});

const dropboxSourceArb = fc.record({
  type: fc.constant("dropbox" as const),
  id: sourceIdArb,
  path: fc.string({ minLength: 1, maxLength: 12 }).map((s) => `/${s || "team"}`),
  ...commonFields,
});

const sourceArb = fc.oneof(
  localSourceArb,
  s3SourceArb,
  gdriveSourceArb,
  dropboxSourceArb,
);

/** A schema-shaped configuration input; run it through `validateConfig`. */
export const configInputArb = fc.record({
  extractUrl: httpsUrlArb,
  allowInsecureLocalhost: fc.boolean(),
  caCertPath: fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: undefined }),
  oidc: fc.option(
    fc.record({
      issuer: httpsUrlArb,
      clientId: fc.string({ minLength: 1, maxLength: 10 }).map((s) => `client-${s || "x"}`),
      audience: fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: undefined }),
      scopes: fc.array(fc.string({ minLength: 1, maxLength: 10 }), { maxLength: 3 }),
    }),
    { nil: undefined },
  ),
  collection: collectionArb,
  syncIntervalSec: fc.integer({ min: 1, max: 100_000 }),
  mirrorDelete: fc.boolean(),
  deleteThresholdPercent: fc.integer({ min: 0, max: 100 }),
  resumableThresholdBytes: fc.integer({ min: 1, max: 1_000_000_000 }),
  maxConcurrentUploads: fc.integer({ min: 1, max: 16 }),
  health: fc.record({
    bind: fc.constantFrom("127.0.0.1", "localhost", "0.0.0.0"),
    port: fc.integer({ min: 1, max: 65535 }),
  }),
  cloudOAuth: fc.record({
    gdrive: fc.option(fc.record({ clientId: fc.string({ minLength: 1, maxLength: 10 }) }), {
      nil: undefined,
    }),
    dropbox: fc.option(fc.record({ appKey: fc.string({ minLength: 1, maxLength: 10 }) }), {
      nil: undefined,
    }),
  }),
  sources: fc.array(sourceArb, { maxLength: 4 }).map((sources) => {
    // Source ids must be unique and must not collide after `sourceEnvId`
    // mapping, or validateConfig rightly rejects the input.
    const seen = new Set<string>();
    const out: typeof sources = [];
    for (const src of sources) {
      const key = src.id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(src);
    }
    return out;
  }),
});

/** A valid string value for one `ENV_MAP` entry. */
export function envValueArb(entry: EnvMapEntry): fc.Arbitrary<string> {
  switch (entry.kind) {
    case "bool":
      return fc.constantFrom("true", "false", "1", "0", "yes", "no", "on", "off");
    case "int":
      return fc.integer({ min: 1, max: 60000 }).map(String);
    case "number":
      return fc.integer({ min: 0, max: 100 }).map(String);
    case "list":
      return fc
        .array(fc.string({ minLength: 1, maxLength: 6 }).filter((s) => !s.includes(",")), {
          minLength: 1,
          maxLength: 3,
        })
        .map((parts) => parts.join(","));
    case "json":
      return fc.constant("[]");
    case "collection":
      return collectionArb;
    case "url":
      return httpsUrlArb;
    case "string":
      return fc
        .string({ minLength: 1, maxLength: 12 })
        .filter((s) => !s.includes("\n") && s.trim() === s);
  }
}
