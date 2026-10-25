// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit cases for the configuration module: the Mirror_Delete
 * default, a per-source collection override, and — the reason `validateConfig`
 * returns a list instead of throwing — several problems reported at once.
 */

import { describe, expect, it } from "vitest";
import {
  COLLECTION_PATTERN,
  effectiveCollection,
  loadConfig,
  mergeConfig,
  serializeConfig,
  sourceEnvId,
  validateConfig,
} from "../../src/index.js";

const MINIMAL = {
  extractUrl: "https://extract.example.com",
  collection: "documents",
  sources: [{ type: "local", id: "docs", path: "/srv/docs" }],
};

const VALID_RESULT = await validateConfig(MINIMAL);
if (!VALID_RESULT.ok) throw new Error("MINIMAL must be valid");
const VALID_CONFIG = VALID_RESULT.value;

describe("configuration defaults", () => {
  it("enables Mirror_Delete by default (requirement 1.7)", () => {
    const result = validateConfig(MINIMAL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mirrorDelete).toBe(true);
    expect(result.value.syncIntervalSec).toBe(900);
    expect(result.value.deleteThresholdPercent).toBe(50);
    expect(result.value.resumableThresholdBytes).toBe(33_554_432);
    expect(result.value.maxConcurrentUploads).toBe(4);
    expect(result.value.health).toEqual({ bind: "127.0.0.1", port: 8787 });
    expect(result.value.allowInsecureLocalhost).toBe(false);
  });

  it("applies source-level defaults", () => {
    const result = validateConfig(MINIMAL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const src = result.value.sources[0];
    expect(src?.type).toBe("local");
    if (src?.type !== "local") return;
    expect(src.watch).toBe(false);
  });

  it("defaults a gdrive source to pdf export and oauth", () => {
    const result = validateConfig({
      ...MINIMAL,
      sources: [{ type: "gdrive", id: "g", folderId: "fid" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const src = result.value.sources[0];
    if (src?.type !== "gdrive") throw new Error("expected a gdrive source");
    expect(src.exportFormat).toBe("pdf");
    expect(src.auth).toBe("oauth");
  });
});

describe("per-source collection override (requirement 1.8)", () => {
  it("uses the source collection when set, the global one otherwise", () => {
    const result = validateConfig({
      ...MINIMAL,
      collection: "global_coll",
      sources: [
        { type: "local", id: "a", path: "/a", collection: "team_a" },
        { type: "local", id: "b", path: "/b" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [a, b] = result.value.sources;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (a === undefined || b === undefined) return;
    expect(effectiveCollection(a, result.value)).toBe("team_a");
    expect(effectiveCollection(b, result.value)).toBe("global_coll");
  });
});

describe("collected error messages", () => {
  it("reports a bad collection, a plain-HTTP URL and a bad source id together", () => {
    const result = validateConfig({
      ...MINIMAL,
      extractUrl: "http://extract.example.com",
      collection: "9bad-name!",
      sources: [{ type: "local", id: "docs", path: "/srv/docs", collection: "also bad" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.errors.map((e) => e.path).sort();
    expect(paths).toEqual(["collection", "extractUrl", "sources[0].collection"]);
    const text = result.errors.map((e) => e.message).join("\n");
    expect(text).toContain(COLLECTION_PATTERN);
    expect(text).toContain("https");
  });

  it("rejects source ids that collapse to the same environment name (6.10)", () => {
    const result = validateConfig({
      ...MINIMAL,
      sources: [
        { type: "local", id: "team-a", path: "/a" },
        { type: "local", id: "team.a", path: "/b" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes("TEAM_A"))).toBe(true);
  });

  it("maps a source id onto its environment name segment", () => {
    expect(sourceEnvId("team-a")).toBe("TEAM_A");
    expect(sourceEnvId("docs.eu-2")).toBe("DOCS_EU_2");
    expect(sourceEnvId("X")).toBe("X");
  });

  it("rejects an unknown source type", () => {
    const result = validateConfig({
      ...MINIMAL,
      sources: [{ type: "ftp", id: "f", path: "/f" }],
    });
    expect(result.ok).toBe(false);
  });

  it("ignores a secret-shaped key instead of failing on it", () => {
    // The schema knows no secret fields; a stray key must
    // not become part of the config object.
    const result = validateConfig({
      ...MINIMAL,
      apiToken: "super-secret",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("apiToken" in result.value).toBe(false);
  });
});

describe("loadConfig", () => {
  const readFile = async (path: string): Promise<string> => {
    if (path === "config.yaml") return serializeConfig(VALID_CONFIG);
    throw new Error(`unexpected read: ${path}`);
  };

  it("reads a YAML file and applies defaults", async () => {
    const result = await loadConfig("config.yaml", {}, { readFile });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.collection).toBe("documents");
    expect(result.value.mirrorDelete).toBe(true);
  });

  it("treats a missing file as a configuration error", async () => {
    const result = await loadConfig("nope.yaml", {}, { readFile });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.path).toBe("nope.yaml");
  });

  it("reports malformed YAML with the file path", async () => {
    const result = await loadConfig("bad.yaml", {}, {
      readFile: async () => "extractUrl: [unclosed",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toContain("not valid YAML");
  });

  it("an empty file counts as no file at all", async () => {
    const result = await loadConfig("empty.yaml", { OUTPOST_EXTRACT_URL: "https://x.example.com", OUTPOST_COLLECTION: "c" }, {
      readFile: async () => "   \n",
    });
    expect(result.ok).toBe(true);
  });
});

describe("mergeConfig", () => {
  it("env wins per key and arrays replace rather than append", () => {
    const merged = mergeConfig(
      { collection: "from_file", health: { bind: "0.0.0.0", port: 9000 }, sources: [1, 2, 3] },
      { OUTPOST_COLLECTION: "from_env", OUTPOST_HEALTH_PORT: "1234", OUTPOST_SOURCES: "[]" },
    );
    expect(merged["collection"]).toBe("from_env");
    expect(merged["health"]).toEqual({ bind: "0.0.0.0", port: 1234 });
    expect(merged["sources"]).toEqual([]);
  });

  it("reports a malformed env value with its variable name", () => {
    expect(() => mergeConfig({}, { OUTPOST_SYNC_INTERVAL_SEC: "soon" })).toThrow(
      /OUTPOST_SYNC_INTERVAL_SEC/,
    );
  });
});
