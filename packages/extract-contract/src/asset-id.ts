// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * asset-id.ts
 *
 * Asset identity, shared by v1 and v2.
 *
 * An asset is stored by Search under an identifier derived from the document
 * reference and a *local id*, never from the image bytes. That choice is what
 * makes the upload idempotent and independent of ordering: the producer can
 * `PUT` the asset before or after the page that references it, and a re-render
 * of the same region at a different DPI overwrites the same row instead of
 * orphaning the old one.
 *
 *     assetId = sha256(NFC(reference) + "\n" + NFC(localId))
 *
 * ## v1 / v2 continuity
 *
 * In v1 the local id was always a figure id (`p12-f3`). v2 keeps that exact
 * derivation for figures — {@link figureLocalId} is the identity function — so
 * a re-extraction of an existing corpus produces byte-identical asset ids and
 * previously uploaded crops stay valid. v2 additionally addresses page images,
 * tiles and native source files with prefixed local ids:
 *
 *     figure   p12-f3            (unchanged from v1)
 *     page     page:p37
 *     tile     tile:p37-f1-r2c3
 *     native   native:source, native:diagram.bpmn
 *
 * The derivation is duplicated in `apps/search/src/document-structure.ts`
 * (`buildDocumentAssetId`) because Search must recompute it from the parsed
 * payload to validate an upload. The two implementations must stay
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
 * Compute an asset id from a document reference and an already-formed local id.
 *
 * This is the single primitive; the typed helpers below build the local id for
 * each asset kind and delegate here. `buildDocumentAssetId(ref, figureId)` is
 * the v1-compatible spelling and is exactly `buildAssetId(ref, figureId)`.
 */
export function buildAssetId(reference: string, localId: string): string {
  return createHash("sha256")
    .update(`${reference.normalize("NFC")}\n${localId.normalize("NFC")}`)
    .digest("hex");
}

/**
 * Stable, tenant-independent identifier for a figure crop.
 *
 * Must match `buildDocumentAssetId` in `apps/search/src/document-structure.ts`.
 * Kept as a named export for v1 continuity; identical to
 * `buildAssetId(reference, figureId)`.
 */
export function buildDocumentAssetId(reference: string, figureId: string): string {
  return buildAssetId(reference, figureId);
}

/** The four asset kinds v2 addresses. */
export type AssetKind = "figure" | "page" | "tile" | "native";

/** Local-id prefix per asset kind. `figure` has none, for v1 continuity. */
const LOCAL_ID_PREFIX: Record<Exclude<AssetKind, "figure">, string> = {
  page: "page:",
  tile: "tile:",
  native: "native:",
};

/** Figure local id — the figure id verbatim, identical to v1. */
export function figureLocalId(figureId: string): string {
  return figureId;
}

/** Page-image local id, e.g. `page:p37`. */
export function pageLocalId(page: number): string {
  return `${LOCAL_ID_PREFIX.page}p${page}`;
}

/** Tile local id, e.g. `tile:p37-f1-r2c3`. */
export function tileLocalId(tileId: string): string {
  return tileId.startsWith(LOCAL_ID_PREFIX.tile)
    ? tileId
    : `${LOCAL_ID_PREFIX.tile}${tileId}`;
}

/** Native-source local id, e.g. `native:source` or `native:diagram.bpmn`. */
export function nativeLocalId(name: string): string {
  return name.startsWith(LOCAL_ID_PREFIX.native)
    ? name
    : `${LOCAL_ID_PREFIX.native}${name}`;
}

/** True when `value` has the shape of an asset id. */
export function isAssetId(value: string): boolean {
  return SHA256_HEX.test(value);
}

/** SHA-256 of raw bytes, used for source-document and image checksums. */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}
