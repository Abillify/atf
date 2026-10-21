// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * `resolveForcedToolArgs` — wildcard `config.toolArgs` keys with the fixed
 * merge order `"*"`, then `"<server>/*"`, then the exact ref (later wins per
 * argument name). Wildcard arguments only reach a tool whose input schema
 * declares them; exact entries always apply.
 */

import { describe, expect, test } from "bun:test";
import { applyStickyArgs, resolveForcedToolArgs, type ToolArgsConfig } from "../tool-args-merge.js";

const noSubstitute = (value: unknown) => value;
const resolve = (
  cfg: ToolArgsConfig | undefined,
  toolRef: string,
  declared?: readonly string[],
) =>
  resolveForcedToolArgs(
    cfg,
    toolRef,
    declared === undefined ? undefined : new Set(declared),
    noSubstitute,
  );

describe("resolveForcedToolArgs", () => {
  test("without a config there is nothing to force", () => {
    expect(resolve(undefined, "vectorsearch/search", ["collection"])).toBeUndefined();
    expect(resolve({}, "vectorsearch/search", ["collection"])).toBeUndefined();
  });

  test("an exact entry behaves exactly as before, declared or not", () => {
    expect(
      resolve({ "vectorsearch/search": { collection: "cases" } }, "vectorsearch/search", [
        "collection",
      ]),
    ).toEqual({ collection: "cases" });
    expect(
      resolve({ "vectorsearch/search": { tenant: "acme" } }, "vectorsearch/search", ["collection"]),
    ).toEqual({ tenant: "acme" });
    expect(
      resolve({ "vectorsearch/search": { collection: "cases" } }, "vectorsearch/get_documents", [
        "collection",
      ]),
    ).toBeUndefined();
  });

  test(`"*" applies only where the tool declares the argument`, () => {
    const cfg: ToolArgsConfig = { "*": { collection: "cases" } };
    expect(resolve(cfg, "vectorsearch/search", ["collection", "query"])).toEqual({
      collection: "cases",
    });
    // get_time has no `collection` parameter — the pin must not leak into it.
    expect(resolve(cfg, "clock/get_time", ["tz"])).toBeUndefined();
    // A schema that declares no properties at all gets no wildcard arguments.
    expect(resolve(cfg, "vectorsearch/search", [])).toBeUndefined();
    expect(resolve(cfg, "vectorsearch/search")).toBeUndefined();
  });

  test(`"<server>/*" applies to every tool of that server only`, () => {
    const cfg: ToolArgsConfig = { "vectorsearch/*": { collection: "cases" } };
    expect(resolve(cfg, "vectorsearch/search", ["collection"])).toEqual({ collection: "cases" });
    expect(resolve(cfg, "vectorsearch/get_documents", ["collection"])).toEqual({
      collection: "cases",
    });
    expect(resolve(cfg, "gate/get_orders", ["collection"])).toBeUndefined();
    expect(resolve(cfg, "vectorsearch/search", ["query"])).toBeUndefined();
  });

  test("the merge order is *, then server/*, then the exact ref", () => {
    const cfg: ToolArgsConfig = {
      "*": { collection: "from-global", limit: 10, lang: "de" },
      "vectorsearch/*": { collection: "from-server", limit: 20 },
      "vectorsearch/search": { collection: "from-exact" },
    };
    expect(
      resolve(cfg, "vectorsearch/search", ["collection", "limit", "lang", "query"]),
    ).toEqual({ collection: "from-exact", limit: 20, lang: "de" });
    expect(
      resolve(cfg, "vectorsearch/get_documents", ["collection", "limit", "lang"]),
    ).toEqual({ collection: "from-server", limit: 20, lang: "de" });
    expect(resolve(cfg, "gate/get_orders", ["collection", "limit", "lang"])).toEqual({
      collection: "from-global",
      limit: 10,
      lang: "de",
    });
  });

  test("an exact entry also sets arguments no wildcard set", () => {
    const cfg: ToolArgsConfig = {
      "*": { collection: "cases" },
      "gate/get_orders": { order_id: "7" },
    };
    expect(resolve(cfg, "gate/get_orders", ["collection"])).toEqual({
      collection: "cases",
      order_id: "7",
    });
  });

  test("templates are resolved on every level", () => {
    const cfg: ToolArgsConfig = {
      "*": { scope: "{{classification.pathPrefix}}" },
      "vectorsearch/*": { tag: ["{{query}}"] },
      "vectorsearch/search": { pinned: { inner: "{{context.tenant}}" } },
    };
    const seen: unknown[] = [];
    const resolved = resolveForcedToolArgs(
      cfg,
      "vectorsearch/search",
      new Set(["scope", "tag", "pinned"]),
      (value) => {
        seen.push(value);
        return typeof value === "string" ? value.replace("{{classification.pathPrefix}}", "/a/b") : value;
      },
    );
    expect(resolved).toEqual({
      scope: "/a/b",
      tag: ["{{query}}"],
      pinned: { inner: "{{context.tenant}}" },
    });
    // Every level hands its values to the substitution callback.
    expect(seen).toContain("{{classification.pathPrefix}}");
    expect(seen).toEqual([
      "{{classification.pathPrefix}}",
      ["{{query}}"],
      { inner: "{{context.tenant}}" },
    ]);
  });

  test(`"*" alone on a tool ref without a server part still matches`, () => {
    expect(resolve({ "*": { collection: "cases" } }, "search", ["collection"])).toEqual({
      collection: "cases",
    });
    // A bare ref's server is the ref itself, mirroring `agent-tools.ts`.
    expect(resolve({ "search/*": { collection: "cases" } }, "search", ["collection"])).toEqual({
      collection: "cases",
    });
  });

  test("an empty entry forces nothing", () => {
    expect(resolve({ "vectorsearch/search": {} }, "vectorsearch/search", ["collection"])).toBeUndefined();
    expect(resolve({ "*": {} }, "vectorsearch/search", ["collection"])).toBeUndefined();
  });
});

describe("applyStickyArgs", () => {
  const declared = new Set(["query", "valid_at"]);

  test("remembers the first value the model sets and applies it from then on", () => {
    const store = new Map<string, unknown>();
    expect(applyStickyArgs(["valid_at"], store, { query: "a", valid_at: "2024-01-01" }, declared)).toEqual({
      valid_at: "2024-01-01",
    });
    // A later call without the argument gets the remembered value.
    expect(applyStickyArgs(["valid_at"], store, { query: "b" }, declared)).toEqual({ valid_at: "2024-01-01" });
    // A drifting model value is overridden: the first one sticks.
    expect(applyStickyArgs(["valid_at"], store, { valid_at: "2030-05-05" }, declared)).toEqual({
      valid_at: "2024-01-01",
    });
  });

  test("nothing is applied before the model has set the argument", () => {
    const store = new Map<string, unknown>();
    expect(applyStickyArgs(["valid_at"], store, { query: "a" }, declared)).toEqual({});
    expect(store.size).toBe(0);
  });

  test("null, empty and undefined do not count as set", () => {
    const store = new Map<string, unknown>();
    for (const blank of [undefined, null, ""]) {
      expect(applyStickyArgs(["valid_at"], store, { valid_at: blank }, declared)).toEqual({});
    }
    expect(store.size).toBe(0);
  });

  test("only arguments the tool declares are recorded or applied", () => {
    const store = new Map<string, unknown>();
    applyStickyArgs(["valid_at"], store, { valid_at: "2024-01-01" }, new Set(["query"]));
    expect(store.size).toBe(0);
    store.set("valid_at", "2024-01-01");
    expect(applyStickyArgs(["valid_at"], store, {}, new Set(["query"]))).toEqual({});
    expect(applyStickyArgs(["valid_at"], store, {}, undefined)).toEqual({});
  });

  test("without configured names nothing happens", () => {
    const store = new Map<string, unknown>();
    expect(applyStickyArgs(undefined, store, { valid_at: "x" }, declared)).toEqual({});
    expect(applyStickyArgs([], store, { valid_at: "x" }, declared)).toEqual({});
    expect(store.size).toBe(0);
  });
});
