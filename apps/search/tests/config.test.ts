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
    // Keep profile tests independent of a profile set on the host shell.
    delete process.env["ATF_PROFILE"];
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

  // Req 12.4: migrations run at boot outside production by default;
  // production defaults to dedicated migration Jobs (`bun run migrate`).
  it("defaults migrateOnStart to true outside production", () => {
    delete process.env["MIGRATE_ON_START"];
    delete process.env["NODE_ENV"];
    expect(loadConfig().migrateOnStart).toBe(true);
    process.env["NODE_ENV"] = "development";
    expect(loadConfig().migrateOnStart).toBe(true);
  });

  it("defaults migrateOnStart to false in production", () => {
    delete process.env["MIGRATE_ON_START"];
    process.env["NODE_ENV"] = "production";
    expect(loadConfig().migrateOnStart).toBe(false);
  });

  it("lets an explicit MIGRATE_ON_START win over NODE_ENV", () => {
    process.env["NODE_ENV"] = "production";
    process.env["MIGRATE_ON_START"] = "true";
    expect(loadConfig().migrateOnStart).toBe(true);
    process.env["NODE_ENV"] = "development";
    process.env["MIGRATE_ON_START"] = "false";
    expect(loadConfig().migrateOnStart).toBe(false);
  });

  // Betriebsprofil: ATF_PROFILE ist der plattformweite Schalter und überstimmt
  // NODE_ENV; unbekannte Werte brechen den Start ab statt die Prod-Gates
  // stillschweigend abzuschalten.
  it("lets ATF_PROFILE override NODE_ENV", () => {
    delete process.env["MIGRATE_ON_START"];
    process.env["ATF_PROFILE"] = "production";
    process.env["NODE_ENV"] = "development";
    expect(loadConfig().nodeEnv).toBe("production");
    expect(loadConfig().migrateOnStart).toBe(false);
    process.env["ATF_PROFILE"] = "development";
    process.env["NODE_ENV"] = "production";
    expect(loadConfig().nodeEnv).toBe("development");
  });

  it("normalises case and whitespace in the profile", () => {
    delete process.env["MIGRATE_ON_START"];
    process.env["NODE_ENV"] = "  PRODUCTION ";
    expect(loadConfig().nodeEnv).toBe("production");
  });

  it("fails fast on an unknown profile instead of disabling the gate", () => {
    process.env["NODE_ENV"] = "prod";
    expect(() => loadConfig()).toThrow("NODE_ENV");
    process.env["NODE_ENV"] = "development";
    process.env["ATF_PROFILE"] = "PRODUCTIVE";
    expect(() => loadConfig()).toThrow("ATF_PROFILE");
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

  it("defaults RERANK_SCORE_TRANSFORM to auto and validates the value", () => {
    delete process.env["RERANK_SCORE_TRANSFORM"];
    expect(loadConfig()).toMatchObject({ rerankScoreTransform: "auto" });
    process.env["RERANK_SCORE_TRANSFORM"] = "sigmoid";
    expect(loadConfig()).toMatchObject({ rerankScoreTransform: "sigmoid" });
    process.env["RERANK_SCORE_TRANSFORM"] = "bogus";
    expect(() => loadConfig()).toThrow("RERANK_SCORE_TRANSFORM");
    delete process.env["RERANK_SCORE_TRANSFORM"];
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

  // A fallback embedding model that differs from the primary writes vectors
  // into a different space than the indexed ones — equal dimension is not the
  // same vector space, and the mismatch silently destroys relevance. Fail at
  // startup unless the operator explicitly asserts a shared space.
  describe("EMBED_FALLBACK_MODEL same-space guard", () => {
    it("accepts a fallback model equal to the primary", () => {
      process.env["EMBED_FALLBACK_MODEL"] = "text-embedding-3-small";
      delete process.env["EMBED_FALLBACK_SAME_SPACE"];
      expect(loadConfig().embedFallbackModel).toBe("text-embedding-3-small");
    });

    it("throws when the fallback model differs from the primary", () => {
      process.env["EMBED_FALLBACK_MODEL"] = "bge-m3";
      delete process.env["EMBED_FALLBACK_SAME_SPACE"];
      expect(() => loadConfig()).toThrow("EMBED_FALLBACK_MODEL");
      expect(() => loadConfig()).toThrow("same vector space");
    });

    it("accepts a differing fallback model with an explicit same-space assertion", () => {
      process.env["EMBED_FALLBACK_MODEL"] = "BAAI/bge-m3";
      process.env["EMBED_FALLBACK_SAME_SPACE"] = "true";
      const config = loadConfig();
      expect(config.embedFallbackModel).toBe("BAAI/bge-m3");
      expect(config.embedFallbackSameSpace).toBe(true);
    });

    it("still throws when the same-space flag is present but false", () => {
      process.env["EMBED_FALLBACK_MODEL"] = "bge-m3";
      process.env["EMBED_FALLBACK_SAME_SPACE"] = "false";
      expect(() => loadConfig()).toThrow("EMBED_FALLBACK_MODEL");
    });

    it("defaults embedFallbackSameSpace to false and stays unset without a fallback", () => {
      delete process.env["EMBED_FALLBACK_MODEL"];
      delete process.env["EMBED_FALLBACK_SAME_SPACE"];
      const config = loadConfig();
      expect(config.embedFallbackSameSpace).toBe(false);
      expect(config.embedFallbackModel).toBeNull();
      expect(config.embedFallbackUrl).toBeNull();
    });
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

  // Req 11.8: API_TOKEN_NEXT is the additive rotation token.
  it("loads API_TOKEN_NEXT and infers token auth from it alone", () => {
    delete process.env["API_TOKEN"];
    delete process.env["AUTHN_MODE"];
    process.env["API_TOKEN_NEXT"] = "rotation-token-01234567890123456789";

    const config = loadConfig();
    expect(config.apiToken).toBeNull();
    expect(config.apiTokenNext).toBe("rotation-token-01234567890123456789");
    expect(config.authnMode).toBe("token");
  });

  it("keeps both tokens when API_TOKEN and API_TOKEN_NEXT are set", () => {
    process.env["API_TOKEN"] = "primary-token-0123456789012345678901";
    process.env["API_TOKEN_NEXT"] = "rotation-token-01234567890123456789";

    const config = loadConfig();
    expect(config.apiToken).toBe("primary-token-0123456789012345678901");
    expect(config.apiTokenNext).toBe("rotation-token-01234567890123456789");
  });

  // Req 11.8: optional server TLS, enabled by TLS_CERT_FILE + TLS_KEY_FILE.
  it("throws when TLS_CERT_FILE is set without TLS_KEY_FILE", () => {
    process.env["TLS_CERT_FILE"] = "/etc/tls/server.crt";
    delete process.env["TLS_KEY_FILE"];

    expect(() => loadConfig()).toThrow(
      "TLS_CERT_FILE and TLS_KEY_FILE must be set together",
    );
  });

  it("loads server TLS config when cert and key are set", () => {
    process.env["TLS_CERT_FILE"] = "/etc/tls/server.crt";
    process.env["TLS_KEY_FILE"] = "/etc/tls/server.key";

    const config = loadConfig();
    expect(config.tls).toEqual({
      certFile: "/etc/tls/server.crt",
      keyFile: "/etc/tls/server.key",
      clientCaFile: null,
    });
  });

  it("reads TLS_CLIENT_CA_FILE for mTLS client verification", () => {
    process.env["TLS_CERT_FILE"] = "/etc/tls/server.crt";
    process.env["TLS_KEY_FILE"] = "/etc/tls/server.key";
    process.env["TLS_CLIENT_CA_FILE"] = "/etc/tls/client-ca.pem";

    const config = loadConfig();
    expect(config.tls?.clientCaFile).toBe("/etc/tls/client-ca.pem");
  });

  it("defaults tls to null when no TLS vars are set", () => {
    expect(loadConfig().tls).toBeNull();
  });

  it("reads CONVERTER_CA_CERT_FILE for trusting a self-signed converter", () => {
    process.env["CONVERTER_URL"] = "https://extract.internal:8080";
    process.env["CONVERTER_CA_CERT_FILE"] = "/etc/tls/extract-ca.pem";

    const config = loadConfig();
    expect(config.converter?.caCertFile).toBe("/etc/tls/extract-ca.pem");
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

  describe("transaction token verification keys (ADR-0035)", () => {
    const required = () => {
      process.env["TRANSACTION_ENFORCEMENT"] = "required";
    };
    it("keeps HS256-only as the default when only the shared secret is set", () => {
      required();
      process.env["TRANSACTION_HS256_SECRET"] = "t".repeat(40);
      expect(loadConfig()).toMatchObject({ transactionAlgorithms: ["HS256"], transactionJwksUri: null });
    });
    it("accepts the asymmetric algorithms too when a JWKS URL is set (a rolling migration)", () => {
      required();
      process.env["TRANSACTION_HS256_SECRET"] = "t".repeat(40);
      process.env["TRANSACTION_JWKS_URI"] = "https://runtime.internal/.well-known/atf-transaction-jwks.json";
      expect(loadConfig().transactionAlgorithms).toEqual(["HS256", "ES256", "EdDSA"]);
    });
    it("needs no shared secret once only asymmetric algorithms are accepted", () => {
      required();
      process.env["TRANSACTION_JWKS_URI"] = "https://runtime.internal/jwks";
      process.env["TRANSACTION_ALGORITHMS"] = "EdDSA";
      expect(loadConfig()).toMatchObject({ transactionAlgorithms: ["EdDSA"], transactionSecret: null });
    });
    it("refuses a configuration that can verify nothing, or names an unknown algorithm", () => {
      required();
      expect(() => loadConfig()).toThrow("TRANSACTION_HS256_SECRET or TRANSACTION_JWKS_URI");
      process.env["TRANSACTION_JWKS_URI"] = "https://runtime.internal/jwks";
      process.env["TRANSACTION_ALGORITHMS"] = "HS256";
      expect(() => loadConfig()).toThrow("TRANSACTION_HS256_SECRET is required when TRANSACTION_ALGORITHMS accepts HS256");
      process.env["TRANSACTION_ALGORITHMS"] = "EdDSA,none";
      expect(() => loadConfig()).toThrow("only HS256, ES256 or EdDSA");
      process.env["TRANSACTION_ALGORITHMS"] = "EdDSA";
      process.env["TRANSACTION_JWKS_URI"] = "ftp://runtime.internal/jwks";
      expect(() => loadConfig()).toThrow("http(s) URL");
    });
    it("is not required while enforcement is off", () => {
      process.env["TRANSACTION_ENFORCEMENT"] = "off";
      expect(loadConfig()).toMatchObject({ transactionAlgorithms: [], transactionJwksUri: null });
    });
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

describe("loadConfig — full-text search language", () => {
  const keys = ["POSTGRES_URL", "EMBED_URL", "EMBED_MODEL", "FTS_LANGUAGE", "FTS_EXTRA_LANGUAGES"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
    process.env["POSTGRES_URL"] = "postgres://u:p@localhost:5432/db";
    process.env["EMBED_URL"] = "http://embed:8080";
    process.env["EMBED_MODEL"] = "text-embedding-3-small";
    delete process.env["FTS_LANGUAGE"];
    delete process.env["FTS_EXTRA_LANGUAGES"];
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults new collections to German stemming", () => {
    expect(loadConfig().defaultFtsLanguage).toBe("german");
  });

  it("rejects an unknown FTS_LANGUAGE at startup instead of at the first ingest", () => {
    process.env["FTS_LANGUAGE"] = "klingon";
    expect(() => loadConfig()).toThrow("FTS_LANGUAGE");
  });

  it("accepts an operator configuration listed in FTS_EXTRA_LANGUAGES as the default", () => {
    process.env["FTS_EXTRA_LANGUAGES"] = "german_compound";
    process.env["FTS_LANGUAGE"] = "german_compound";
    const config = loadConfig();
    expect(config.ftsExtraLanguages).toEqual(["german_compound"]);
    expect(config.defaultFtsLanguage).toBe("german_compound");
  });

  it("rejects an FTS_EXTRA_LANGUAGES entry that is not a configuration name", () => {
    process.env["FTS_EXTRA_LANGUAGES"] = "german; DROP TABLE x";
    expect(() => loadConfig()).toThrow("FTS_EXTRA_LANGUAGES");
  });
});
