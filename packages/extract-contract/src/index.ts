// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * @atf/extract-contract
 *
 * The document-extraction output contract: one normative definition of what a
 * converted document looks like, shared by the producer (`@atf/extract`) and
 * every consumer (`@atf/search`, runtime flows).
 *
 * The package default export is **v2** (`atf-extract/2.0.0`): the NDJSON record
 * stream with a typed block model, structured figure transcriptions, asset
 * references and the ingest/job API types. See `./v2/index.ts` for the record
 * model and `README.md` for the format.
 *
 * The legacy **v1** marker grammar (`## Seite N` markers, `<figure>` entries,
 * Markdown transport) remains available under the subpath
 * `@atf/extract-contract/v1` so existing corpora stay readable. It is not
 * re-exported from the root to keep the two majors from colliding on names like
 * `EXTRACT_CONTRACT_ID`.
 */

// Shared version machinery — the current (v2) constants and the generic gate.
export {
  EXTRACT_CONTRACT_HEADER,
  EXTRACT_CONTRACT_ID,
  EXTRACT_CONTRACT_MAJOR,
  EXTRACT_CONTRACT_NAME,
  EXTRACT_CONTRACT_VERSION,
  isCompatibleContract,
  parseContractId,
  type ContractId,
} from "./version.js";

// Shared asset identity — v1-compatible for figures, prefixed for v2 kinds.
export {
  buildAssetId,
  buildDocumentAssetId,
  figureLocalId,
  isAssetId,
  nativeLocalId,
  pageLocalId,
  sha256Hex,
  tileLocalId,
  type AssetKind,
} from "./asset-id.js";

// The v2 record model, codec, validator and Markdown view.
export * from "./v2/index.js";
