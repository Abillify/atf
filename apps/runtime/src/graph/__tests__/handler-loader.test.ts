// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the dynamic node-type handler plugin loader
 * (src/graph/handler-loader.ts).
 *
 * Writes throwaway plugin modules into a temp dir and loads them into a fresh
 * registry, covering the supported export shapes (`nodeType`, `nodeTypes`,
 * `default`, `register()`), error isolation (bad import / no registration /
 * duplicate), and a missing directory being a no-op.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { NodeHandlerRegistry } from "../node-handler-registry.js";
import { loadHandlerPlugins } from "../handler-loader.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiperator-plugins-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const writePlugin = (name: string, body: string): void => {
  fs.writeFileSync(path.join(dir, name), body, "utf8");
};

const FACTORY = "factory: () => () => ({})";

describe("loadHandlerPlugins", () => {
  test("registers a `nodeType` export and makes the type resolvable", async () => {
    writePlugin(
      "my-type.ts",
      `export const nodeType = { type: "my-type", emitsLifecycle: true, ${FACTORY} };`,
    );
    const registry = new NodeHandlerRegistry();
    const result = await loadHandlerPlugins(registry, dir);

    expect(result.loaded).toEqual(["my-type"]);
    expect(result.failed).toEqual([]);
    expect(registry.has("my-type")).toBe(true);
  });

  test("supports `nodeTypes` array, `default`, and `register()` shapes", async () => {
    writePlugin(
      "arr.ts",
      `export const nodeTypes = [
         { type: "a", emitsLifecycle: false, ${FACTORY} },
         { type: "b", emitsLifecycle: true, ${FACTORY} },
       ];`,
    );
    writePlugin(
      "def.ts",
      `export default { type: "c", emitsLifecycle: false, ${FACTORY} };`,
    );
    writePlugin(
      "reg.ts",
      `export function register(registry) {
         registry.register({ type: "d", emitsLifecycle: true, ${FACTORY} });
       }`,
    );
    const registry = new NodeHandlerRegistry();
    const result = await loadHandlerPlugins(registry, dir);

    expect(new Set(registry.registeredTypes())).toEqual(
      new Set(["a", "b", "c", "d"]),
    );
    expect(result.failed).toEqual([]);
  });

  test("carries a plugin's configSchema through to the registration", async () => {
    // A schema-shaped object (avoids a bare `zod` import that would not resolve
    // from a temp dir outside the project's node_modules — see the docs note on
    // where to place PLUGINS_DIR).
    writePlugin(
      "with-schema.ts",
      `const configSchema = {
         safeParse: (v) => ({ success: typeof v?.threshold === "number" }),
       };
       export const nodeType = {
         type: "schema-type",
         emitsLifecycle: true,
         ${FACTORY},
         configSchema,
       };`,
    );
    const registry = new NodeHandlerRegistry();
    await loadHandlerPlugins(registry, dir);
    const schema = registry.get("schema-type")?.configSchema;
    expect(schema).toBeDefined();
    if (schema === undefined) throw new Error("expected a configSchema");
    expect(schema.safeParse({ threshold: 1 }).success).toBe(true);
    expect(schema.safeParse({ threshold: "x" }).success).toBe(false);
  });

  test("isolates a throwing import, a no-registration module, and a duplicate", async () => {
    writePlugin("boom.ts", `throw new Error("kaboom");`);
    writePlugin("empty.ts", `export const unrelated = 42;`);
    writePlugin(
      "dup1.ts",
      `export const nodeType = { type: "dup", emitsLifecycle: true, ${FACTORY} };`,
    );
    writePlugin(
      "dup2.ts",
      `export const nodeType = { type: "dup", emitsLifecycle: true, ${FACTORY} };`,
    );
    writePlugin(
      "good.ts",
      `export const nodeType = { type: "good", emitsLifecycle: true, ${FACTORY} };`,
    );

    const registry = new NodeHandlerRegistry();
    const result = await loadHandlerPlugins(registry, dir);

    // The good ones registered; "dup" registered exactly once.
    expect(registry.has("good")).toBe(true);
    expect(registry.has("dup")).toBe(true);
    expect(registry.registeredTypes().filter((t) => t === "dup")).toHaveLength(
      1,
    );
    // boom (import), empty (no registration), and the second dup are reported.
    expect(result.failed.length).toBe(3);
  });

  test("skips test/declaration/partial files", async () => {
    writePlugin(
      "real.ts",
      `export const nodeType = { type: "real", emitsLifecycle: true, ${FACTORY} };`,
    );
    writePlugin(
      "skip.test.ts",
      `export const nodeType = { type: "nope", emitsLifecycle: true, ${FACTORY} };`,
    );
    writePlugin(
      "_wip.ts",
      `export const nodeType = { type: "wip", emitsLifecycle: true, ${FACTORY} };`,
    );
    writePlugin(
      "types.d.ts",
      `export const nodeType = { type: "dts", emitsLifecycle: true, ${FACTORY} };`,
    );

    const registry = new NodeHandlerRegistry();
    await loadHandlerPlugins(registry, dir);
    expect(registry.registeredTypes()).toEqual(["real"]);
  });

  test("a missing directory is a no-op", async () => {
    const registry = new NodeHandlerRegistry();
    const result = await loadHandlerPlugins(
      registry,
      path.join(dir, "does-not-exist"),
    );
    expect(result.loaded).toEqual([]);
    expect(registry.registeredTypes()).toEqual([]);
  });
});

describe("loadHandlerPlugins — verifier integration (Req. 4.1, 4.2)", () => {
  function sha256(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  test("rejects all plugins in production without allowlist/manifest", async () => {
    writePlugin(
      "valid.ts",
      `export const nodeType = { type: "valid", emitsLifecycle: true, ${FACTORY} };`,
    );
    const registry = new NodeHandlerRegistry();
    const result = await loadHandlerPlugins(registry, dir, undefined, {
      appEnv: "production",
    });
    expect(result.loaded).toEqual([]);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]).toContain("No PLUGINS_ALLOWLIST");
    expect(registry.has("valid")).toBe(false);
  });

  test("allows plugins matching the allowlist", async () => {
    writePlugin(
      "allowed.ts",
      `export const nodeType = { type: "allowed-type", emitsLifecycle: true, ${FACTORY} };`,
    );
    writePlugin(
      "blocked.ts",
      `export const nodeType = { type: "blocked-type", emitsLifecycle: true, ${FACTORY} };`,
    );
    const registry = new NodeHandlerRegistry();
    const result = await loadHandlerPlugins(registry, dir, undefined, {
      allowlist: ["allowed.ts"],
      appEnv: "production",
    });
    expect(result.loaded).toEqual(["allowed-type"]);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]).toContain("blocked.ts");
    expect(registry.has("allowed-type")).toBe(true);
    expect(registry.has("blocked-type")).toBe(false);
  });

  test("allows plugins matching the manifest hash", async () => {
    const pluginCode = `export const nodeType = { type: "signed-type", emitsLifecycle: true, ${FACTORY} };`;
    writePlugin("signed.ts", pluginCode);
    const manifestPath = path.join(dir, "plugins.manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ files: { "signed.ts": sha256(pluginCode) } }),
      "utf-8",
    );

    const registry = new NodeHandlerRegistry();
    const result = await loadHandlerPlugins(registry, dir, undefined, {
      manifestPath,
      appEnv: "production",
    });
    expect(result.loaded).toEqual(["signed-type"]);
    expect(result.failed).toEqual([]);
    expect(registry.has("signed-type")).toBe(true);
  });

  test("wildcard allowlist allows all plugins in production", async () => {
    writePlugin(
      "any.ts",
      `export const nodeType = { type: "any-type", emitsLifecycle: true, ${FACTORY} };`,
    );
    const registry = new NodeHandlerRegistry();
    const result = await loadHandlerPlugins(registry, dir, undefined, {
      allowlist: ["*"],
      appEnv: "production",
    });
    expect(result.loaded).toEqual(["any-type"]);
    expect(result.failed).toEqual([]);
  });

  test("no verifierOptions: all plugins load (backward compatible)", async () => {
    writePlugin(
      "compat.ts",
      `export const nodeType = { type: "compat-type", emitsLifecycle: true, ${FACTORY} };`,
    );
    const registry = new NodeHandlerRegistry();
    const result = await loadHandlerPlugins(registry, dir);
    expect(result.loaded).toEqual(["compat-type"]);
  });

  test("rejects plugin with hash mismatch (tampered file)", async () => {
    const originalCode = `export const nodeType = { type: "tampered-type", emitsLifecycle: true, ${FACTORY} };`;
    // Write a different version to disk than what the manifest expects
    writePlugin("tampered.ts", `${originalCode}\n// injected`);
    const manifestPath = path.join(dir, "plugins.manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ files: { "tampered.ts": sha256(originalCode) } }),
      "utf-8",
    );

    const registry = new NodeHandlerRegistry();
    const result = await loadHandlerPlugins(registry, dir, undefined, {
      manifestPath,
      appEnv: "production",
    });
    expect(result.loaded).toEqual([]);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]).toContain("SHA-256 hash does not match");
    expect(registry.has("tampered-type")).toBe(false);
  });

  test("logs security event when plugin is rejected (not allowlisted)", async () => {
    writePlugin(
      "evil.ts",
      `export const nodeType = { type: "evil-type", emitsLifecycle: true, ${FACTORY} };`,
    );
    const logged: Array<{ message: string; fields: Record<string, unknown> }> =
      [];
    const mockLogger = {
      debug() {},
      info() {},
      warn() {},
      error(message: string, fields?: Record<string, unknown>) {
        logged.push({ message, fields: fields ?? {} });
      },
      child() {
        return mockLogger;
      },
    };
    const registry = new NodeHandlerRegistry();
    await loadHandlerPlugins(registry, dir, mockLogger, {
      allowlist: ["good.ts"],
      appEnv: "production",
    });
    expect(logged.length).toBe(1);
    const entry = logged[0];
    if (entry === undefined) throw new Error("expected a logged event");
    expect(entry.message).toContain("SECURITY");
    expect(entry.fields.event).toBe("plugin_verification_failed");
    expect(entry.fields.plugin).toBe("evil.ts");
  });

  test("logs security event when plugin has invalid signature (hash mismatch)", async () => {
    const code = `export const nodeType = { type: "sig-type", emitsLifecycle: true, ${FACTORY} };`;
    writePlugin("sig.ts", `${code}\n// modified`);
    const manifestPath = path.join(dir, "plugins.manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ files: { "sig.ts": sha256(code) } }),
      "utf-8",
    );

    const logged: Array<{ message: string; fields: Record<string, unknown> }> =
      [];
    const mockLogger = {
      debug() {},
      info() {},
      warn() {},
      error(message: string, fields?: Record<string, unknown>) {
        logged.push({ message, fields: fields ?? {} });
      },
      child() {
        return mockLogger;
      },
    };
    const registry = new NodeHandlerRegistry();
    await loadHandlerPlugins(registry, dir, mockLogger, {
      manifestPath,
      appEnv: "production",
    });
    expect(logged.length).toBe(1);
    const entry = logged[0];
    if (entry === undefined) throw new Error("expected a logged event");
    expect(entry.message).toContain("SECURITY");
    expect(entry.fields.event).toBe("plugin_verification_failed");
    expect(entry.fields.reason).toContain(
      "SHA-256 hash does not match",
    );
  });

  test("logs security event in production with no config (safe default)", async () => {
    writePlugin(
      "noconfig.ts",
      `export const nodeType = { type: "noconfig-type", emitsLifecycle: true, ${FACTORY} };`,
    );
    const logged: Array<{ message: string; fields: Record<string, unknown> }> =
      [];
    const mockLogger = {
      debug() {},
      info() {},
      warn() {},
      error(message: string, fields?: Record<string, unknown>) {
        logged.push({ message, fields: fields ?? {} });
      },
      child() {
        return mockLogger;
      },
    };
    const registry = new NodeHandlerRegistry();
    await loadHandlerPlugins(registry, dir, mockLogger, {
      appEnv: "production",
    });
    expect(logged.length).toBe(1);
    const entry = logged[0];
    if (entry === undefined) throw new Error("expected a logged event");
    expect(entry.message).toContain("SECURITY");
    expect(entry.fields.event).toBe("plugin_verification_failed");
    expect(entry.fields.reason).toContain("No PLUGINS_ALLOWLIST");
  });
});
