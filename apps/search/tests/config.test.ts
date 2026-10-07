// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Config tests for vectorsearch-api
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import { loadConfig } from "../src/index.js";
import { checkProductionReadiness } from "../src/prod-gate.js";

const REQUIRED_VARS = ["POSTGRES_URL", "EMBED_URL", "EMBED_MODEL"] as const;
type RequiredVar = (typeof REQUIRED_VARS)[number];

describe("Config", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env["POSTGRES_URL"] =
      "postgresql://user:pass@localhost:5432/vectorsearch";
    process.env["EMBED_URL"] = "http://embed:8080";
    process.env["EMBED_MODEL"] = "text-embedding-3-small";
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  it("throws when POSTGRES_URL is missing", () => {
    delete process.env["POSTGRES_URL"];
    expect(() => loadConfig()).toThrow("POSTGRES_URL");
  });

  it("throws when POSTGRES_URL is empty", () => {
    process.env["POSTGRES_URL"] = "";
    expect(() => loadConfig()).toThrow("POSTGRES_URL");
  });

  it("throws when EMBED_URL is missing", () => {
    delete process.env["EMBED_URL"];
    expect(() => loadConfig()).toThrow("EMBED_URL");
  });

  it("defaults the RRF list weights to 1.0 (unchanged ranking)", () => {
    delete process.env["RRF_WEIGHT_DENSE"];
    delete process.env["RRF_WEIGHT_FTS"];
    delete process.env["RRF_WEIGHT_IDENTIFIER"];
    expect(loadConfig()).toMatchObject({
      rrfWeightDense: 1.0,
      rrfWeightFts: 1.0,
      rrfWeightIdentifier: 1.0,
    });
  });

  it("parses configured RRF list weights", () => {
    process.env["RRF_WEIGHT_DENSE"] = "2";
    process.env["RRF_WEIGHT_FTS"] = "0.5";
    process.env["RRF_WEIGHT_IDENTIFIER"] = "3";
    expect(loadConfig()).toMatchObject({
      rrfWeightDense: 2,
      rrfWeightFts: 0.5,
      rrfWeightIdentifier: 3,
    });
  });

  it("rejects a non-positive RRF weight", () => {
    process.env["RRF_WEIGHT_IDENTIFIER"] = "0";
    expect(() => loadConfig()).toThrow("RRF_WEIGHT_IDENTIFIER");
  });

  // Req 4.3/4.4: sparse list weight + missing-list-zero flag.
  it("defaults RRF_WEIGHT_SPARSE to 1.0 and RRF_MISSING_ZERO to true", () => {
    delete process.env["RRF_WEIGHT_SPARSE"];
    delete process.env["RRF_MISSING_ZERO"];
    expect(loadConfig()).toMatchObject({
      rrfWeightSparse: 1.0,
      rrfMissingZero: true,
    });
  });

  it("parses RRF_WEIGHT_SPARSE and RRF_MISSING_ZERO=false", () => {
    process.env["RRF_WEIGHT_SPARSE"] = "2.5";
    process.env["RRF_MISSING_ZERO"] = "false";
    expect(loadConfig()).toMatchObject({
      rrfWeightSparse: 2.5,
      rrfMissingZero: false,
    });
  });

  it("rejects a non-positive RRF_WEIGHT_SPARSE", () => {
    process.env["RRF_WEIGHT_SPARSE"] = "-1";
    expect(() => loadConfig()).toThrow("RRF_WEIGHT_SPARSE");
  });

  // Req 4.7 (task 6.9): lexical list ranker. bm25 is parsed here; whether it
  // takes effect depends on the BM25 extension detection in postgres-client.
  it("defaults FTS_RANKER to ts_rank_cd and parses bm25", () => {
    delete process.env["FTS_RANKER"];
    expect(loadConfig()).toMatchObject({ ftsRanker: "ts_rank_cd" });
    process.env["FTS_RANKER"] = "bm25";
    expect(loadConfig()).toMatchObject({ ftsRanker: "bm25" });
  });

  it("rejects an unknown FTS_RANKER", () => {
    process.env["FTS_RANKER"] = "bm15";
    expect(() => loadConfig()).toThrow("FTS_RANKER");
  });

  // Req 4.8 (task 6.10): optional relevance threshold + abstention signal.
  it("defaults MIN_RERANK_SCORE to null (disabled)", () => {
    delete process.env["MIN_RERANK_SCORE"];
    expect(loadConfig()).toMatchObject({ minRerankScore: null });
  });

  it("parses MIN_RERANK_SCORE and treats empty as disabled", () => {
    process.env["MIN_RERANK_SCORE"] = "0.35";
    expect(loadConfig()).toMatchObject({ minRerankScore: 0.35 });
    process.env["MIN_RERANK_SCORE"] = "";
    expect(loadConfig()).toMatchObject({ minRerankScore: null });
    process.env["MIN_RERANK_SCORE"] = "   ";
    expect(loadConfig()).toMatchObject({ minRerankScore: null });
  });

  it("rejects a non-numeric MIN_RERANK_SCORE", () => {
    process.env["MIN_RERANK_SCORE"] = "abc";
    expect(() => loadConfig()).toThrow(
      "MIN_RERANK_SCORE must be a finite number",
    );
  });

  it("defaults the HNSW iterative-scan tuning (Req 4.1)", () => {
    delete process.env["HNSW_ITERATIVE_SCAN"];
    delete process.env["HNSW_MAX_SCAN_TUPLES"];
    expect(loadConfig()).toMatchObject({
      hnswIterativeScan: "relaxed_order",
      hnswMaxScanTuples: 20_000,
    });
  });

  it("parses each allowed HNSW_ITERATIVE_SCAN mode", () => {
    for (const mode of ["relaxed_order", "strict_order", "off"] as const) {
      process.env["HNSW_ITERATIVE_SCAN"] = mode;
      expect(loadConfig().hnswIterativeScan).toBe(mode);
    }
  });

  it("rejects an invalid HNSW_ITERATIVE_SCAN value", () => {
    process.env["HNSW_ITERATIVE_SCAN"] = "aggressive";
    expect(() => loadConfig()).toThrow(
      "HNSW_ITERATIVE_SCAN must be one of: relaxed_order, strict_order, off",
    );
  });

  it("parses HNSW_MAX_SCAN_TUPLES and rejects non-positive values", () => {
    process.env["HNSW_MAX_SCAN_TUPLES"] = "50000";
    expect(loadConfig().hnswMaxScanTuples).toBe(50_000);
    process.env["HNSW_MAX_SCAN_TUPLES"] = "0";
    expect(() => loadConfig()).toThrow("HNSW_MAX_SCAN_TUPLES");
  });

  it("throws when EMBED_URL is empty", () => {
    process.env["EMBED_URL"] = "";
    expect(() => loadConfig()).toThrow("EMBED_URL");
  });

  it("throws when EMBED_MODEL is missing", () => {
    delete process.env["EMBED_MODEL"];
    expect(() => loadConfig()).toThrow("EMBED_MODEL");
  });

  it("throws when EMBED_MODEL is empty", () => {
    process.env["EMBED_MODEL"] = "";
    expect(() => loadConfig()).toThrow("EMBED_MODEL");
  });

  it("succeeds when all required vars are set", () => {
    const config = loadConfig();
    expect(config.postgresUrl).toBe(
      "postgresql://user:pass@localhost:5432/vectorsearch",
    );
    expect(config.embedUrl).toBe("http://embed:8080");
    expect(config.embedModel).toBe("text-embedding-3-small");
    expect(config.embedModelRevision).toBe("text-embedding-3-small");
    expect(config.apiToken).toBeNull();
    expect(config.mcp2026Path).toBe("/mcp/v2026");
    expect(config.mcpServiceName).toBe("vectorsearch");
    expect(config.mcpServiceVersion).toBe("1.0.0");
  });

  it("validates and loads MCP 2026 service metadata", () => {
    process.env["MCP_2026_PATH"] = "/protocol/mcp-2026";
    process.env["MCP_SERVICE_NAME"] = "knowledge-search";
    process.env["MCP_SERVICE_VERSION"] = "2026.8";
    expect(loadConfig()).toMatchObject({
      mcp2026Path: "/protocol/mcp-2026",
      mcpServiceName: "knowledge-search",
      mcpServiceVersion: "2026.8",
    });
    process.env["MCP_2026_PATH"] = "/mcp";
    expect(() => loadConfig()).toThrow("distinct from /mcp");
  });

  it("loads a production transaction and authorization configuration that passes the production gate", () => {
    process.env["NODE_ENV"] = "production";
    process.env["AUTHN_MODE"] = "oidc";
    process.env["AUTHZ_ENABLED"] = "true";
    process.env["TENANT_ISOLATION_ENABLED"] = "true";
    // Req 3.3: a production deployment must require an end-user identity (or
    // record a waiver) to pass the gate.
    process.env["ACL_REQUIRE_IDENTITY"] = "true";
    process.env["DEFAULT_TENANT_ID"] = "tenant-production";
    process.env["API_OIDC_ISSUERS"] = JSON.stringify([
      {
        issuer: "https://id.example.com",
        audience: "vectorsearch",
        tenantClaim: "tenant_id",
        scopesClaim: "scope",
      },
    ]);
    process.env["TRANSACTION_ENFORCEMENT"] = "required";
    process.env["TRANSACTION_HS256_SECRET"] = "t".repeat(40);
    process.env["TRANSACTION_ISSUER"] = "agent-runtime";
    const config = loadConfig();
    expect(checkProductionReadiness(config).fatal).toEqual([]);
  });

  it("loads DEFAULT_TENANT_ID and keeps the legacy OIDC alias compatible", () => {
    process.env["API_OIDC_DEFAULT_TENANT_ID"] = "  tenant-default  ";
    expect(loadConfig().defaultTenantId).toBe("tenant-default");
    process.env["API_OIDC_DEFAULT_TENANT_ID"] = "   ";
    expect(loadConfig().defaultTenantId).toBe("default");
  });

  it("migrates legacy authorization settings without treating optional as disabled", () => {
    delete process.env["AUTHZ_ENABLED"];
    delete process.env["AUTHZ_ENFORCEMENT"];
    expect(loadConfig()).toMatchObject({
      authzEnabled: false,
      authzEnforcement: "off",
    });

    process.env["AUTHZ_ENFORCEMENT"] = "required";
    expect(loadConfig().authzEnabled).toBe(true);

    process.env["AUTHZ_ENFORCEMENT"] = "off";
    expect(loadConfig().authzEnabled).toBe(false);

    process.env["AUTHZ_ENFORCEMENT"] = "optional";
    expect(() => loadConfig()).toThrow(
      "AUTHZ_ENFORCEMENT=optional cannot be migrated safely",
    );

    process.env["AUTHZ_ENABLED"] = "true";
    expect(loadConfig().authzEnabled).toBe(true);
  });

  it("rejects disabled authentication when tenant isolation is enabled", () => {
    process.env["AUTHN_MODE"] = "disabled";
    process.env["TENANT_ISOLATION_ENABLED"] = "true";
    delete process.env["API_TOKEN"];
    delete process.env["API_OIDC_ISSUERS"];

    expect(() => loadConfig()).toThrow(
      "AUTHN_MODE=disabled cannot be used with TENANT_ISOLATION_ENABLED=true",
    );

    process.env["TENANT_ISOLATION_ENABLED"] = "false";
    expect(loadConfig()).toMatchObject({
      authnMode: "disabled",
      tenantIsolationEnabled: false,
      defaultTenantId: "default",
    });
  });

  it.each(["token", "token_or_oidc"] as const)(
    "requires a dedicated server-configured tenant for AUTHN_MODE=%s with isolation",
    (mode) => {
      process.env["AUTHN_MODE"] = mode;
      process.env["API_TOKEN"] = "static-token";
      process.env["TENANT_ISOLATION_ENABLED"] = "true";
      delete process.env["API_SERVICE_TENANT_ID"];
      if (mode === "token_or_oidc") {
        process.env["API_OIDC_ISSUERS"] = JSON.stringify([
          {
            issuer: "https://id.example.com",
            tenantClaim: "tenant_id",
          },
        ]);
      }

      expect(() => loadConfig()).toThrow("API_SERVICE_TENANT_ID is required");
    },
  );

  it.each(["token", "token_or_oidc"] as const)(
    "binds AUTHN_MODE=%s to the server-configured tenant when isolation is enabled",
    (mode) => {
      process.env["AUTHN_MODE"] = mode;
      process.env["API_TOKEN"] = "static-token";
      process.env["API_SERVICE_TENANT_ID"] = "service-tenant";
      process.env["TENANT_ISOLATION_ENABLED"] = "true";
      if (mode === "token_or_oidc") {
        process.env["API_OIDC_ISSUERS"] = JSON.stringify([
          {
            issuer: "https://id.example.com",
            tenantClaim: "tenant_id",
          },
        ]);
      }

      expect(loadConfig()).toMatchObject({
        authnMode: mode,
        tenantIsolationEnabled: true,
        defaultTenantId: "service-tenant",
        apiServiceTenantId: "service-tenant",
      });
    },
  );

  it("Property: any missing required var causes startup failure", () => {
    fc.assert(
      fc.property(
        fc.subarray(REQUIRED_VARS as unknown as RequiredVar[], {
          minLength: 1,
        }),
        fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
        (missingVars, deleteFlags) => {
          process.env["POSTGRES_URL"] =
            "postgresql://user:pass@localhost:5432/vectorsearch";
          process.env["EMBED_URL"] = "http://embed:8080";
          process.env["EMBED_MODEL"] = "text-embedding-3-small";

          missingVars.forEach((varName, idx) => {
            if (deleteFlags[idx]) {
              delete process.env[varName];
            } else {
              process.env[varName] = "";
            }
          });

          let threw = false;
          let errorMessage = "";
          try {
            loadConfig();
          } catch (err) {
            threw = true;
            errorMessage = err instanceof Error ? err.message : String(err);
          }

          if (!threw) return false;
          return missingVars.some((varName) => errorMessage.includes(varName));
        },
      ),
      { numRuns: 100 },
    );
  });
});
