// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Per-source credential resolution (requirements 6.10, 6.17, 6.18).
 *
 * Called at the start of every run — the store is read FRESH each time so a
 * token written by `source-login` takes effect with the next scheduled run
 * without a restart (6.17). Access tokens may be cached within a run only.
 * A missing credential yields `needs-authorization: missing`; a token the
 * provider rejected during the previous refresh yields
 * `needs-authorization: rejected` (the token itself stays stored, 6.18).
 */

import { readFile } from "node:fs/promises";
import type { SourceConfig } from "../../config/schema.js";
import { sourceEnvId } from "../../config/validate.js";
import type { Env } from "../../config/secrets-file.js";
import { sourceGdriveSaKey, sourceOauthRefreshKey } from "../../credentials/keys.js";
import type { CredentialStore } from "../../credentials/store.js";

export type SourceCredential =
  | { kind: "service-account"; keyJson: string }
  | { kind: "refresh-token"; token: string }
  | /** local / s3 — credentials come from the config or the S3 chain. */
    { kind: "static" }
  | { kind: "needs-authorization"; reason: "missing" | "rejected" };

/** Docker env var naming a mounted service-account key file for a source. */
export const gdriveSaKeyFileEnv = (sourceId: string): string =>
  `OUTPOST_SOURCE_${sourceEnvId(sourceId)}_GDRIVE_SA_KEY_FILE`;

export interface ResolveDeps {
  /** Injectable file reader (Docker `_FILE` path); defaults to fs. */
  readFile?: (path: string) => Promise<string>;
}

/**
 * Resolve the credential for one source. Pure apart from store/file reads;
 * never caches across calls (6.17). `rejectedIds` carries the sources whose
 * stored token the provider rejected during the last refresh (6.18).
 */
export async function resolveSourceCredential(
  src: SourceConfig,
  store: CredentialStore,
  env: Env,
  rejectedIds: ReadonlySet<string> = new Set(),
  deps: ResolveDeps = {},
): Promise<SourceCredential> {
  if (src.type === "local" || src.type === "s3") {
    return { kind: "static" };
  }

  if (src.type === "gdrive" && src.auth === "service-account") {
    // Docker: mounted secret file wins (6.10) — no user authorization ever.
    const keyFile = env[gdriveSaKeyFileEnv(src.id)];
    if (keyFile !== undefined && keyFile !== "") {
      const read = deps.readFile ?? ((p: string) => readFile(p, "utf8"));
      try {
        return { kind: "service-account", keyJson: await read(keyFile) };
      } catch {
        // Unreadable file behaves like a missing credential; the message
        // never contains the path contents.
        return needsAuthorization(src.id, rejectedIds);
      }
    }
    // Desktop: key in the keychain.
    const stored = await store.get(sourceGdriveSaKey(src.id));
    if (stored !== null && stored !== "") {
      return { kind: "service-account", keyJson: stored };
    }
    return needsAuthorization(src.id, rejectedIds);
  }

  // gdrive (oauth) and dropbox: the per-source refresh token.
  const token = await store.get(sourceOauthRefreshKey(src.id));
  if (token !== null && token !== "") {
    return { kind: "refresh-token", token };
  }
  return needsAuthorization(src.id, rejectedIds);
}

/** `rejected` when the last refresh was refused, otherwise `missing`. */
function needsAuthorization(
  sourceId: string,
  rejectedIds: ReadonlySet<string>,
): SourceCredential {
  return {
    kind: "needs-authorization",
    reason: rejectedIds.has(sourceId) ? "rejected" : "missing",
  };
}

/** Human hint for logs and the UI (6.18). */
export const sourceLoginHint = (sourceId: string): string =>
  `atf-outpost source-login ${sourceId}`;
