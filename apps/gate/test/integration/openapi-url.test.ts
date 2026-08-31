// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigAsync } from "../../src/config/loader.ts";

const SPEC = `
openapi: 3.0.0
info: { title: Pets, version: "1" }
paths:
  /pets/{petId}:
    get:
      operationId: getPet
      summary: Get a pet
      parameters:
        - { name: petId, in: path, required: true, schema: { type: string } }
      responses: { "200": { description: ok } }
`;

let server: Server;
let port = 0;
let specHits = 0;
let dir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/openapi.yaml" && req.headers["x-spec-auth"] === "secret") {
      specHits++;
      res.writeHead(200, { "content-type": "text/yaml" });
      res.end(SPEC);
    } else {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;

  dir = mkdtempSync(join(tmpdir(), "mcpgate-openapi-url-"));
  const config = `
auth:
  mode: static
  static:
    tokens:
      - token: t
openapi:
  - spec: "http://127.0.0.1:${port}/openapi.yaml"
    baseUrl: "https://api.example.com"
    prefix: "pet_"
    specHeaders:
      X-Spec-Auth: secret
`;
  writeFileSync(join(dir, "config.yaml"), config);
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfigAsync · remote OpenAPI spec", () => {
  it("fetches a spec over HTTP (with specHeaders) and generates http tools", async () => {
    const { config } = await loadConfigAsync(dir);
    expect(specHits).toBeGreaterThan(0);
    const tool = config.tools.find((t) => t.name === "pet_getpet");
    expect(tool).toBeDefined();
    expect(tool?.type).toBe("http");
    if (tool?.type === "http") {
      expect(tool.request.method).toBe("GET");
      expect(tool.request.url).toContain("/pets/:param.petId");
    }
  });
});
