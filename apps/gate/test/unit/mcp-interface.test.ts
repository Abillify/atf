// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { ToolConfigSchema } from "../../src/config/schema.ts";
import { MonitorBus } from "../../src/monitor/events.ts";
import { FakeDb } from "../helpers/fake-db.ts";

const runtime = () => ({ db: new FakeDb({ main: [{ id: 1 }] }), bus: new MonitorBus(10) });

describe("ToolRegistry · MCP interface (outputSchema / annotations / requiredScopes)", () => {
  it("derives readOnlyHint/destructiveHint from access when annotations are omitted", () => {
    const read = ToolConfigSchema.parse({
      name: "r",
      type: "database",
      database: "main",
      query: "select 1",
      access: "read",
    });
    const write = ToolConfigSchema.parse({
      name: "w",
      type: "database",
      database: "main",
      query: "delete from x",
      access: "write",
    });
    const reg = new ToolRegistry([read, write], runtime());
    const defs = new Map(reg.list().map((d) => [d.name, d]));

    expect(defs.get("r")!.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(defs.get("w")!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("lets explicit tool.yaml annotations override the access-derived defaults", () => {
    const upsert = ToolConfigSchema.parse({
      name: "upsert",
      type: "database",
      database: "main",
      query: "insert into x values (1) on conflict do nothing",
      access: "write",
      annotations: { idempotentHint: true, title: "Idempotent upsert" },
    });
    const reg = new ToolRegistry([upsert], runtime());
    const def = reg.list().find((d) => d.name === "upsert")!;
    expect(def.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      title: "Idempotent upsert",
    });
  });

  it("advertises a default outputSchema for database tools and an explicit one when configured", () => {
    const defaulted = ToolConfigSchema.parse({
      name: "d",
      type: "database",
      database: "main",
      query: "select 1",
    });
    const explicit = ToolConfigSchema.parse({
      name: "e",
      type: "database",
      database: "main",
      query: "select 1",
      outputSchema: {
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
      },
    });
    const reg = new ToolRegistry([defaulted, explicit], runtime());
    const defs = new Map(reg.list().map((d) => [d.name, d]));
    expect(defs.get("d")!.outputSchema).toBeDefined();
    expect((defs.get("d")!.outputSchema as { required: string[] }).required).toEqual([
      "rowCount",
      "truncated",
      "rows",
    ]);
    expect(defs.get("e")!.outputSchema).toEqual({
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
    });
  });

  it("uses only explicit required scopes and leaves empty requirements open to authenticated callers", () => {
    const gated = ToolConfigSchema.parse({
      name: "g",
      type: "database",
      database: "main",
      query: "select 1",
      requiredScopes: ["admin:read"],
    });
    const ungated = ToolConfigSchema.parse({
      name: "u",
      type: "database",
      database: "main",
      query: "select 1",
    });
    const legacyUnchecked = ToolConfigSchema.parse({
      name: "legacy_unchecked",
      type: "database",
      database: "main",
      query: "select 1",
      requiredScopes: ["admin:read"],
      scopeCheck: false,
    });
    const reg = new ToolRegistry([gated, ungated, legacyUnchecked], runtime());
    expect(reg.requiredScopesOf("g")).toEqual(["admin:read"]);
    expect(reg.requiredScopesOf("u")).toEqual([]);
    expect(reg.requiredScopesOf("legacy_unchecked")).toEqual(["admin:read"]);
  });
});
