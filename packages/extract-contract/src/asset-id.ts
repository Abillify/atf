// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * asset-id.ts
 *
 * Figure asset identity.
 *
 * A figure crop is stored by Search under an identifier derived from the
 * document reference and the figure id, never from the image bytes. That choice
 * is what makes the upload idempotent and independent of ordering: the producer
 * can `PUT /document-assets/:assetId` before or after `POST /ingest`, and a
 * re-render of the same figure at a different DPI overwrites the same row
 * instead of orphaning the old one.
 *
 * The derivation is duplicated in `apps/search/src/document-structure.ts`
 * (`buildDocumentAssetId`) because Search must recompute it from the parsed
 * Markdown to validate an upload. The two implementations must stay
 * byte-identical; `test/asset-id.test.ts` pins the expected digests so a change
 * on either side fails loudly.
 *
 * NFC normalisation matters: a reference containing a composed vs. decomposed
 * umlaut would otherwise hash differently depending on which filesystem or
 * browser produced the filename.
 */

import { createHash } from "node:crypto";

/** Lower-case hex SHA-256, the shape Search stores and routes on. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Stable, tenant-independent identifier shared by ingest, asset upload and
 * search results.
 *
 * Must match `buildDocumentAssetId` in `apps/search/src/document-structure.ts`.
 */
export function buildDocumentAssetId(
  documentReference: string,
  figureId: string,
): string {
  return createHash("sha256")
    .update(`${documentReference.normalize("NFC")}\n${figureId.normalize("NFC")}`)
    .digest("hex");
}

/** True when `value` has the shape of an asset id. */
export function isAssetId(value: string): boolean {
  return SHA256_HEX.test(value);
}

/** SHA-256 of raw bytes, used for source-document and image checksums. */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}
