// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Reference derivation (requirements 7.2, 7.9, 8.2).
 *
 * `outpost:<sourceId>:<h>` where `h` is the first 32 characters of the
 * base64url encoding of SHA-256 over `sourceId + "\u0000" + NFC(quellId)`.
 * 32 base64url characters are 192 bits — collisions are practically
 * impossible. The reference contains no plaintext path or file name beyond
 * the source id, and it does NOT depend on the collection: switching the
 * collection is a re-assignment, not a new identity (8.2).
 */

import { createHash } from "node:crypto";

/** Length of the hash part in characters (192 bit, base64url). */
export const REFERENCE_HASH_LENGTH = 32;

/** Separator between source id and source id content in the hash input. */
export const REFERENCE_SEPARATOR = "\u0000";

/** Derive the stable Extract reference for a source item. */
export function deriveReference(sourceId: string, quellId: string): string {
  const hash = createHash("sha256")
    .update(sourceId + REFERENCE_SEPARATOR + quellId.normalize("NFC"), "utf8")
    .digest("base64url")
    .slice(0, REFERENCE_HASH_LENGTH);
  return `outpost:${sourceId}:${hash}`;
}
