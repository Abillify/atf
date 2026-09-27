// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * v1/version.ts
 *
 * v1-pinned contract constants for the legacy marker grammar.
 *
 * The package as a whole has advanced to major 2 (the NDJSON record stream),
 * but the v1 marker grammar keeps producing and validating `atf-extract/1.x`
 * so that existing corpora stay re-ingestable. These constants therefore gate
 * on major 1 rather than on the package's current major, and everything
 * structural is delegated to the shared {@link parseContractId} so the two
 * majors reject a malformed identifier identically.
 */

import {
  EXTRACT_CONTRACT_HEADER,
  EXTRACT_CONTRACT_NAME,
  isCompatibleContract as isCompatibleContractForMajor,
  parseContractId,
  type ContractId,
} from "../version.js";

export { EXTRACT_CONTRACT_HEADER, EXTRACT_CONTRACT_NAME, parseContractId, type ContractId };

/** Current v1 contract version. */
export const EXTRACT_CONTRACT_VERSION = "1.1.0";

/** v1 major version — the only part a v1 consumer must gate on. */
export const EXTRACT_CONTRACT_MAJOR = 1;

/** Canonical v1 `contract` field value, e.g. `atf-extract/1.1.0`. */
export const EXTRACT_CONTRACT_ID = `${EXTRACT_CONTRACT_NAME}/${EXTRACT_CONTRACT_VERSION}`;

/** True when `value` is a v1-compatible (`atf-extract/1.x`) contract id. */
export function isCompatibleContract(value: string): boolean {
  return isCompatibleContractForMajor(value, EXTRACT_CONTRACT_MAJOR);
}
