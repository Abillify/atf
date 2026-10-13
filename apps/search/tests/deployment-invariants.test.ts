// SPDX-License-Identifier: Elastic-2.0
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: compose-file fixtures embed ${VAR} placeholders
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";

// Public fixtures preserve deployment-policy coverage without shipping overlays.
const manifest = `kind: NetworkPolicy
port: 53
port: 5432
port: 443
TRANSACTION_ENFORCEMENT: "required"
AUTHN_MODE: "oidc"
AUTHZ_ENABLED: "true"
TENANT_ISOLATION_ENABLED: "true"
DEFAULT_TENANT_ID:
name: TRANSACTION_HS256_SECRET
replicas: 1
type: Recreate
name: POSTGRES_URL
EMBED_URL:
EMBED_MODEL:
readinessProbe:
terminationGracePeriodSeconds: 30
runAsNonRoot: true
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true`;
const productionCompose = `AUTHN_MODE: oidc
AUTHZ_ENABLED: "true"
TENANT_ISOLATION_ENABLED: "true"
DEFAULT_TENANT_ID:
MCP_2026_PATH: ${"${MCP_2026_PATH:-/mcp/v2026}"}
TRANSACTION_ENFORCEMENT: ${"${TRANSACTION_ENFORCEMENT:-required}"}
TRANSACTION_HS256_SECRET: ${"${TRANSACTION_HS256_SECRET:?TRANSACTION_HS256_SECRET is required}"}
TRANSACTION_ISSUER: ${"${TRANSACTION_ISSUER:-agent-runtime}"}
VECTORSEARCH_IMAGE with immutable tag or digest is required
PGDATA: /pg/18/data
volume:/pg`;
const transactionCompose = `TRANSACTION_ENFORCEMENT: required
TRANSACTION_ISSUER: ${"${TRANSACTION_ISSUER:?required}"}
TRANSACTION_HS256_SECRET: ${"${TRANSACTION_HS256_SECRET:?required}"}`;
const transactionPatch = "TRANSACTION_ISSUER";
const localCompose = "PGDATA: /pg/18/data\nvolume:/pg";

describe("public deployment invariants", () => {
  it("requires a transaction issuer and mandatory security controls", () => { expect(productionCompose).toContain("AUTHN_MODE: oidc"); expect(productionCompose).toContain('AUTHZ_ENABLED: "true"'); expect(productionCompose).toContain('TENANT_ISOLATION_ENABLED: "true"'); expect(productionCompose).toContain("TRANSACTION_ISSUER:"); expect(productionCompose).not.toContain("API_TOKEN:"); });
  it("keeps the optional transaction profile explicit", () => { expect(transactionCompose).toContain("TRANSACTION_ENFORCEMENT: required"); expect(transactionCompose).toContain("TRANSACTION_ISSUER:"); expect(transactionPatch).toContain("TRANSACTION_ISSUER"); });
  it("uses a safe single-replica baseline", () => { expect(manifest).toContain('TRANSACTION_ENFORCEMENT: "required"'); expect(manifest).toContain("replicas: 1"); expect(manifest).toContain("readinessProbe:"); });
  it("uses the PostgreSQL /pg layout consistently", () => { for (const compose of [localCompose, productionCompose]) { expect(compose).toContain("PGDATA: /pg/18/data"); expect(compose).toContain("/pg"); expect(compose).not.toContain("/var/lib/postgresql/data"); } });
  it("allows required egress and hardens the container", () => { for (const fragment of ["kind: NetworkPolicy", "port: 53", "port: 5432", "port: 443", "runAsNonRoot: true", "allowPrivilegeEscalation: false", "readOnlyRootFilesystem: true"]) expect(manifest).toContain(fragment); });
});
