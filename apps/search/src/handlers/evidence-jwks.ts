// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * GET /.well-known/atf-search-evidence-jwks.json — the public key that
 * verifies signed evidence packs. Unauthenticated, like the other
 * `.well-known` documents. 404 while `SEARCH_EVIDENCE_SIGNING_KEY` is unset.
 */

import type { Request, Response } from "express";
import { evidenceJwks, type EvidenceSigningKey } from "../evidence-signing.js";

export function createEvidenceJwksHandler(key: EvidenceSigningKey | null) {
  return (_req: Request, res: Response): void => {
    if (key === null) {
      res.status(404).json({
        error: "EVIDENCE_SIGNING_NOT_CONFIGURED",
        message: "Evidence pack signing is not configured",
      });
      return;
    }
    res
      .status(200)
      .set("Cache-Control", "public, max-age=300")
      .json(evidenceJwks(key));
  };
}
