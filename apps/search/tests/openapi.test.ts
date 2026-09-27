// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Contract checks for the v2 parts of the generated OpenAPI document: the
 * revision endpoints document their status codes and machine-readable error
 * codes, and /v2/search documents group_by / identifier_search.
 */
import { describe, expect, it } from "vitest";
import { buildOpenApiSpec, buildOpenApiYaml } from "../src/openapi.js";

type Json = Record<string, unknown>;
const spec = buildOpenApiSpec("http://localhost") as unknown as Json;
const paths = spec.paths as Record<string, Record<string, Json>>;

function responses(path: string, method: string): Record<string, Json> {
  const op = paths[path]?.[method];
  if (!op) throw new Error(`${method.toUpperCase()} ${path} is not documented`);
  return op.responses as Record<string, Json>;
}

function codes(path: string, method: string, status: string): string[] {
  return (responses(path, method)[status]?.["x-error-codes"] as string[] | undefined) ?? [];
}

const REV = "/v2/documents/{ref}/revisions/{rev}";

describe("OpenAPI · v2 revisions", () => {
  it("documents 202 (commit pending) on the final commit", () => {
    expect(responses(`${REV}/commit`, "post")["202"]).toBeDefined();
  });

  it("documents the new 409 codes", () => {
    expect(codes("/v2/documents/{ref}/revisions", "post", "409")).toContain("IDEMPOTENCY_KEY_REUSED");
    expect(codes(REV, "get", "409")).toContain("REVISION_REFERENCE_MISMATCH");
    expect(codes(`${REV}/commit`, "post", "409")).toEqual(
      expect.arrayContaining(["COMMIT_DOCUMENT_END_MISSING", "COMMIT_MISSING_BATCHES"]),
    );
    expect(codes(`${REV}/batches/{seq}`, "put", "409")).toContain("REVISION_COMMIT_PENDING");
    expect(codes(`${REV}/heartbeat`, "post", "409")).toContain("REVISION_COMMIT_PENDING");
  });

  it("documents 503 on every revision operation", () => {
    for (const [path, ops] of Object.entries(paths)) {
      if (!path.startsWith("/v2/documents/")) continue;
      for (const method of Object.keys(ops)) {
        expect(codes(path, method, "503"), `${method} ${path}`).toContain("POSTGRES_UNREACHABLE");
      }
    }
    expect(codes(`${REV}/commit`, "post", "503")).toContain("COMMIT_FINALIZE_INCOMPLETE");
    expect(codes(`${REV}/segments/{n}/commit`, "post", "503")).toContain("SEGMENT_FLIP_INCOMPLETE");
  });

  it("only uses error codes declared in the RevisionError schema", () => {
    const schemas = (spec.components as Json).schemas as Record<string, Json>;
    const revisionError = schemas.RevisionError as Json;
    const declared = ((revisionError.properties as Json).code as Json).enum as string[];
    for (const ops of Object.values(paths)) {
      for (const op of Object.values(ops)) {
        for (const res of Object.values((op.responses ?? {}) as Record<string, Json>)) {
          for (const code of (res["x-error-codes"] as string[] | undefined) ?? []) {
            expect(declared).toContain(code);
          }
        }
      }
    }
  });
});

describe("OpenAPI · /v2/search", () => {
  it("documents group_by and identifier_search", () => {
    const post = (paths["/v2/search"] as Record<string, Json>).post as Json;
    const body = (post.requestBody as Json).content as Record<string, Json>;
    const json = body["application/json"] as Json;
    const props = ((json.schema as Json).properties ?? {}) as Record<string, Json>;
    expect(props.group_by?.enum).toEqual(["none", "document", "section"]);
    expect(props.identifier_search?.type).toBe("boolean");
  });
});

describe("OpenAPI · serialisation", () => {
  it("resolves every $ref and renders YAML", () => {
    const refs = JSON.stringify(spec).match(/"\$ref":"#\/components\/schemas\/[A-Za-z]+"/g) ?? [];
    const schemas = (spec.components as Json).schemas as Record<string, unknown>;
    for (const ref of refs) {
      const name = ref.split("/").pop()?.replace(/"$/, "") ?? "";
      expect(schemas[name], name).toBeDefined();
    }
    expect(buildOpenApiYaml("http://localhost")).toContain("RevisionError");
  });
});
