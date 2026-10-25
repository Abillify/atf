// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * whoami.ts
 *
 * `GET /v1/whoami` (extract-outpost E1, requirements 5.1, 5.2).
 *
 * Echoes the identity the auth middleware resolved and advertises what this
 * instance can actually do, so a client — primarily the Outpost — can validate
 * its configuration *before* the first upload instead of discovering a missing
 * scope or a missing route in the middle of a sync run:
 *
 * - `401` from this route means the credential is rejected, full stop.
 * - A missing `extract.ingest` scope in the answer is a configuration error.
 * - `features.deleteByReference` plus the `extract.delete` scope decide whether
 * mirror-delete can work at all (checks this up front).
 * - `limits.maxUploadBytes` lets a client reject an oversized file without
 *   transferring it.
 *
 * No scope is required beyond authentication itself: the answer is the caller's
 * own identity, which the caller necessarily already knows. The response is
 * parsed against `whoamiResponseSchema` before it is sent, so a drift between
 * this handler and the shared contract fails loudly here rather than in every
 * client.
 */

import type { RequestHandler } from "express";
import { whoamiResponseSchema } from "@atf/extract-contract/v2";
import { getPrincipal } from "../request-principal.js";

/**
 * Kept in sync with `apps/extract/package.json` (same convention as the
 * hard-coded version in `apps/search/src/openapi.ts`).
 */
export const EXTRACT_SERVICE_VERSION = "0.11.0";

export interface WhoamiHandlerDeps {
  /** Which capability routes are actually mounted on this instance. */
  features: {
    ingest: boolean;
    resumableUploads: boolean;
    deleteByReference: boolean;
    ownJobRead: boolean;
  };
  /** `MAX_UPLOAD_BYTES` — the per-upload ceiling (direct and resumable). */
  maxUploadBytes: number;
}

export function createWhoamiHandler(deps: WhoamiHandlerDeps): RequestHandler {
  return (req, res) => {
    const principal = getPrincipal(req);
    // A browser session is an OIDC JWT login; on the machine API surface it
    // reports as its underlying credential type. The contract enum has no
    // "session" member on purpose — it describes machine credentials.
    const source = principal.source === "session" ? "jwt" : principal.source;
    const body = whoamiResponseSchema.parse({
      ...(principal.userId !== undefined ? { subject: principal.userId } : {}),
      ...(principal.tenantId !== undefined ? { tenantId: principal.tenantId } : {}),
      source,
      ...(principal.issuer !== undefined ? { issuer: principal.issuer } : {}),
      ...(principal.audience !== undefined ? { audience: principal.audience } : {}),
      scopes: principal.scopes ?? [],
      service: { name: "atf-extract", version: EXTRACT_SERVICE_VERSION },
      features: deps.features,
      limits: { maxUploadBytes: deps.maxUploadBytes },
    });
    res.status(200).json(body);
  };
}
