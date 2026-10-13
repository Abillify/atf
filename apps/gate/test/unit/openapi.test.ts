// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandOpenApiImports } from "../../src/config/openapi.ts";
import { OpenApiImportSchema, HttpToolSchema } from "../../src/config/schema.ts";

const SPEC = `
openapi: 3.0.0
info: { title: Pets, version: "1" }
servers: [{ url: "https://api.example.com/v1" }]
paths:
  /pets/{petId}:
    get:
      operationId: getPet
      summary: Get a pet by id
      parameters:
        - { name: petId, in: path, required: true, schema: { type: string } }
        - { name: verbose, in: query, required: false, schema: { type: boolean } }
      responses: { "200": { description: ok } }
  /pets:
    post:
      operationId: createPet
      summary: Create a pet
      requestBody:
        required: true
        content:
          application/json:
            schema: { type: object, properties: { name: { type: string } }, required: [name] }
      responses: { "201": { description: created } }
`;

const dir = mkdtempSync(join(tmpdir(), "mcpgate-openapi-"));
writeFileSync(join(dir, "pets.yaml"), SPEC);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function expand(overrides: Record<string, unknown> = {}) {
  const imp = OpenApiImportSchema.parse({ spec: "pets.yaml", prefix: "pet_", ...overrides });
  return expandOpenApiImports([imp], (i) => readFileSync(join(dir, i.spec), "utf8")) as Array<
    Record<string, unknown>
  >;
}

describe("expandOpenApiImports", () => {
  it("generates one valid http tool per operation", () => {
    const tools = expand();
    expect(tools).toHaveLength(2);
    // Each generated tool validates against the http tool schema.
    for (const t of tools) expect(() => HttpToolSchema.parse(t)).not.toThrow();
  });

  it("maps path params into the URL and marks them required (GET → read)", () => {
    const tools = expand();
    const getPet = tools.find((t) => t.name === "pet_getpet");
    expect(getPet).toBeDefined();
    expect(getPet.access).toBe("read");
    const req = getPet.request as Record<string, unknown>;
    expect(req.method).toBe("GET");
    expect(String(req.url)).toContain("/pets/:param.petId");
    expect(String(req.url)).toContain("verbose=:param.verbose");
    const schema = getPet.inputSchema as { required: string[] };
    expect(schema.required).toContain("petId");
    expect(schema.required).not.toContain("verbose");
  });

  it("maps a JSON request body to :param.body (POST → write)", () => {
    const tools = expand();
    const createPet = tools.find((t) => t.name === "pet_createpet");
    expect(createPet.access).toBe("write");
    const req = createPet.request as Record<string, unknown>;
    expect(req.method).toBe("POST");
    expect(req.body).toBe(":param.body");
    expect((createPet.inputSchema as { required: string[] }).required).toContain("body");
  });

  it("honours include / exclude by operationId", () => {
    expect(expand({ include: ["getPet"] })).toHaveLength(1);
    expect(expand({ exclude: ["getPet"] })).toHaveLength(1);
  });

  it("uses an explicit baseUrl override", () => {
    const tools = expand({ baseUrl: "https://staging.example.com" });
    const req = (tools[0].request as Record<string, unknown>).url as string;
    expect(req.startsWith("https://staging.example.com")).toBe(true);
  });

  it("parses a JSON spec (format auto-detected)", () => {
    const json = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      servers: [{ url: "https://x.example.com" }],
      paths: { "/a": { get: { operationId: "getA", responses: { "200": { description: "ok" } } } } },
    });
    const imp = OpenApiImportSchema.parse({ spec: "inline.json" });
    const tools = expandOpenApiImports([imp], () => json) as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("geta");
  });
});
