// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
import { trimTrailingSlashes } from "@atf/security-kit";

/**
 * Citation impact route (`src/routes/citation-impact.ts`)
 *
 * `GET /monitoring/citation-impact?since=<RFC3339>&base_ref=<optional>&limit=<1..1000>`
 *
 * Builds the signed citation impact report (see
 * `compliance/citation-impact.ts`): the past answers whose cited passages
 * changed or disappeared in a newer document revision, checked against the
 * Search service at `CITATION_CHECK_URL`. Operator-plane, gated by
 * `monitoring:read` like the other `/monitoring/*` routes.
 *
 * Tenant scoping: with `tenant_id` the report covers that tenant only;
 * without it the report spans ALL tenants, which additionally requires the
 * `admin` operator role (a `viewer`/`operator` token gets 403). Without
 * `CITATION_CHECK_URL` the route answers 503 — the check itself is the whole
 * point of the report and cannot be performed locally.
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppConfig } from "../config/schema.js";
import {
  buildCitationImpactReport,
  chunkCheckItems,
  CITATION_CHECK_MAX_ITEMS,
  type CitationCheckItem,
  type CitationCheckResult,
  parseCitationCheckResponse,
  signCitationImpact,
} from "../compliance/citation-impact.js";
import type { CitationPairGroup } from "../compliance/citation-impact.js";
import type { Ed25519EvidenceKey } from "../observability/evidence-key.js";
import { egressFetch } from "../security/egress.js";
import {
  createOperatorAuthorizer,
  type OperatorAuthorizer,
} from "../middleware/operator-rbac.js";

/** How the cited pairs are read — injectable so tests avoid Postgres. */
export interface CitationImpactSource {
  citedPairs(options: {
    since: string;
    limit: number;
    tenantId?: string;
    baseRef?: string;
  }): Promise<CitationPairGroup[]>;
}

export interface CitationImpactRouterDeps {
  config: AppConfig;
  authRequired?: boolean;
  operatorAuth?: OperatorAuthorizer;
  /** Reads cited pairs; absent when no citation index / database exists. */
  source?: CitationImpactSource;
  /** Ed25519 evidence key — the report is signed only when configured. */
  evidenceKey?: Ed25519EvidenceKey;
  /** Egress seam for the citation check; defaults to the guarded fetch. */
  fetchFn?: typeof fetch;
  /** Clock seam for deterministic tests. */
  now?: () => Date;
}

const CHECK_TIMEOUT_MS = 15_000;

function unauthorized(ctx: Context): Response {
  return ctx.json(
    {
      error: {
        message: "Unauthorized monitoring access.",
        type: "authentication_error",
      },
    },
    401,
  );
}

function parseSince(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return 200;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 1_000) return undefined;
  return n;
}

export function createCitationImpactRouter(
  deps: CitationImpactRouterDeps,
): Hono {
  const app = new Hono();
  const authRequired = deps.authRequired ?? false;
  const operatorAuth =
    deps.operatorAuth ?? createOperatorAuthorizer({ authRequired });
  const fetchFn = deps.fetchFn ?? egressFetch;

  app.get("/monitoring/citation-impact", async (ctx: Context) => {
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "monitoring:read",
    );
    if (!r.ok) return unauthorized(ctx);

    const tenantParam = ctx.req.query("tenant_id")?.trim();
    const tenantId = tenantParam === "" || tenantParam === undefined ? undefined : tenantParam;
    // All-tenant reports are an admin-only capability: a scoped operator
    // token must not enumerate other tenants' citation activity.
    if (tenantId === undefined && r.actor?.role !== "admin") {
      return ctx.json(
        {
          error: {
            message:
              "citation impact across all tenants requires the admin operator role; pass tenant_id to scope the report",
            type: "authorization_error",
          },
        },
        403,
      );
    }

    const since = parseSince(ctx.req.query("since"));
    if (since === undefined) {
      return ctx.json(
        {
          error: {
            message: "since must be an RFC 3339 timestamp",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const limit = parseLimit(ctx.req.query("limit"));
    if (limit === undefined) {
      return ctx.json(
        {
          error: {
            message: "limit must be an integer between 1 and 1000",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const baseRefParam = ctx.req.query("base_ref")?.trim();
    const baseRef = baseRefParam === "" || baseRefParam === undefined ? undefined : baseRefParam;

    const baseUrl = deps.config.citationCheckUrl;
    if (baseUrl === undefined || baseUrl === "") {
      return ctx.json(
        {
          error: {
            message: "citation check is not configured (CITATION_CHECK_URL)",
            type: "service_unavailable",
          },
        },
        503,
      );
    }
    if (deps.source === undefined) {
      return ctx.json(
        {
          error: {
            message:
              "citation impact needs the citation index with a database (CITATION_INDEX_ENABLED, DATABASE_URL)",
            type: "service_unavailable",
          },
        },
        503,
      );
    }

    const groups = await deps.source.citedPairs({
      since,
      limit,
      ...(tenantId !== undefined ? { tenantId } : {}),
      ...(baseRef !== undefined ? { baseRef } : {}),
    });

    const items: CitationCheckItem[] = groups.map((group) => ({
      base_ref: group.baseRef,
      chunk_id: group.chunkId,
    }));

    const results: CitationCheckResult[] = [];
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (deps.config.citationCheckToken !== undefined) {
      headers.Authorization = `Bearer ${deps.config.citationCheckToken}`;
    }
    const url = `${trimTrailingSlashes(baseUrl)}/v2/citations/check`;
    for (const block of chunkCheckItems(items, CITATION_CHECK_MAX_ITEMS)) {
      let resp: Response;
      try {
        resp = await fetchFn(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ items: block }),
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        });
      } catch (err) {
        return ctx.json(
          {
            error: {
              message: `citation check request failed: ${err instanceof Error ? err.message : String(err)}`,
              type: "upstream_error",
            },
          },
          502,
        );
      }
      if (!resp.ok) {
        return ctx.json(
          {
            error: {
              message: `citation check responded HTTP ${resp.status}`,
              type: "upstream_error",
            },
          },
          502,
        );
      }
      let body: unknown;
      try {
        body = await resp.json();
      } catch {
        return ctx.json(
          {
            error: { message: "citation check returned invalid JSON", type: "upstream_error" },
          },
          502,
        );
      }
      try {
        results.push(...parseCitationCheckResponse(body).results);
      } catch (err) {
        return ctx.json(
          {
            error: {
              message: `citation check returned an unusable body: ${err instanceof Error ? err.message : String(err)}`,
              type: "upstream_error",
            },
          },
          502,
        );
      }
    }

    const unsigned = buildCitationImpactReport(groups, results, {
      generatedAt: (deps.now?.() ?? new Date()).toISOString(),
      since,
      tenantId: tenantId ?? null,
    });
    const report =
      deps.evidenceKey !== undefined
        ? signCitationImpact(unsigned, deps.evidenceKey)
        : unsigned;
    return ctx.json(report);
  });

  return app;
}
