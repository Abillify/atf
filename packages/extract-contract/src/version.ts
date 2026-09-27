// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * version.ts
 *
 * The contract version is the compatibility handle between a producer
 * (`@atf/extract`) and a consumer (`@atf/search`, a runtime flow, an operator
 * re-ingesting stored content).
 *
 * Versioning rule, mirroring the other `packages/*-contract` packages:
 *
 *   MAJOR — the wire format changed in a way that makes previously produced
 *           payloads parse differently. A consumer pinned to the old major
 *           must refuse the payload rather than mis-index it.
 *   MINOR — additive: a new optional record type, block field or envelope
 *           field. Old consumers keep working because they ignore what they do
 *           not know.
 *   PATCH — clarification or bug fix with no observable payload change.
 *
 * The version travels out-of-band, never inside a body: on the wire as the
 * `contract` envelope field and the `X-Extract-Contract` response header, and
 * into Search as `metadata.extract_contract`.
 *
 * ## v1 vs v2
 *
 * This is the shared version machinery. `EXTRACT_CONTRACT_*` names the *current*
 * major, which is now 2 (the NDJSON record stream). The v1 marker grammar is
 * still produced and consumed for legacy corpora; its own constants live in
 * `./v1/version.ts` and gate on major 1. Both share {@link parseContractId} so
 * a mis-formed identifier is rejected identically on either path.
 */

/** Wire identifier prefix. Combined with the version to form `atf-extract/2.0.0`. */
export const EXTRACT_CONTRACT_NAME = "atf-extract";

/** Current contract version (v2 — the NDJSON record stream). */
export const EXTRACT_CONTRACT_VERSION = "2.0.0";

/** Current major version — the only part a consumer must gate on. */
export const EXTRACT_CONTRACT_MAJOR = 2;

/** Canonical `contract` field value, e.g. `atf-extract/2.0.0`. */
export const EXTRACT_CONTRACT_ID = `${EXTRACT_CONTRACT_NAME}/${EXTRACT_CONTRACT_VERSION}`;

/** Response header carrying a contract id. */
export const EXTRACT_CONTRACT_HEADER = "X-Extract-Contract";

/** Parsed form of a `atf-extract/<major>.<minor>.<patch>` identifier. */
export interface ContractId {
  name: string;
  version: string;
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse a contract identifier such as `atf-extract/2.0.0`.
 * Returns null when the value is not a well-formed identifier.
 */
export function parseContractId(value: string): ContractId | null {
  const match = /^([a-z][a-z0-9-]*)\/(\d+)\.(\d+)\.(\d+)$/i.exec(value.trim());
  if (match === null) return null;
  const [, name, major, minor, patch] = match;
  if (name === undefined || major === undefined || minor === undefined || patch === undefined) {
    return null;
  }
  return {
    name,
    version: `${major}.${minor}.${patch}`,
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
  };
}

/**
 * True when a payload produced under `value` can be consumed by a build pinned
 * to `expectedMajor`.
 *
 * Same major means compatible: minor versions are additive by definition, so a
 * newer producer only ever adds fields this consumer ignores. Defaults to the
 * current major so existing call sites keep gating on v2.
 */
export function isCompatibleContract(
  value: string,
  expectedMajor: number = EXTRACT_CONTRACT_MAJOR,
): boolean {
  const parsed = parseContractId(value);
  return (
    parsed !== null &&
    parsed.name === EXTRACT_CONTRACT_NAME &&
    parsed.major === expectedMajor
  );
}
