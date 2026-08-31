// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for plugin allowlist and signature verification
 * (src/graph/plugin-verifier.ts).
 *
 * Validates: Requirements 4.1, 4.2
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import {
  computeFileHash,
  createPluginVerifier,
  loadPluginsManifest,
  verifyPlugin,
  type PluginsManifest,
} from "../plugin-verifier.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiperator-verifier-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeFile(name: string, content: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

describe("computeFileHash", () => {
  test("returns the correct SHA-256 hex digest", () => {
    const content = "export const x = 42;\n";
    const filePath = writeFile("test.ts", content);
    expect(computeFileHash(filePath)).toBe(sha256(content));
  });
});

describe("loadPluginsManifest", () => {
  test("loads a valid manifest", () => {
    const hash = sha256("content");
    const manifestPath = writeFile(
      "plugins.manifest.json",
      JSON.stringify({ files: { "plugin.ts": hash } }),
    );
    const manifest = loadPluginsManifest(manifestPath);
    expect(manifest).toEqual({ files: { "plugin.ts": hash } });
  });

  test("returns undefined for missing file", () => {
    expect(loadPluginsManifest(path.join(dir, "nope.json"))).toBeUndefined();
  });

  test("returns undefined for invalid structure", () => {
    const manifestPath = writeFile(
      "plugins.manifest.json",
      JSON.stringify({ wrong: true }),
    );
    expect(loadPluginsManifest(manifestPath)).toBeUndefined();
  });

  test("skips entries with invalid hash values", () => {
    const validHash = sha256("x");
    const manifestPath = writeFile(
      "plugins.manifest.json",
      JSON.stringify({
        files: { "good.ts": validHash, "bad.ts": "not-a-hash" },
      }),
    );
    const manifest = loadPluginsManifest(manifestPath);
    expect(manifest).toEqual({ files: { "good.ts": validHash } });
  });
});

describe("verifyPlugin", () => {
  test("allows plugin when wildcard allowlist is set", () => {
    const filePath = writeFile("any.ts", "code");
    const result = verifyPlugin("any.ts", filePath, {
      allowlist: ["*"],
      appEnv: "production",
    });
    expect(result.allowed).toBe(true);
  });

  test("allows plugin when filename is in allowlist", () => {
    const filePath = writeFile("allowed.ts", "code");
    const result = verifyPlugin("allowed.ts", filePath, {
      allowlist: ["allowed.ts", "other.ts"],
      appEnv: "production",
    });
    expect(result.allowed).toBe(true);
  });

  test("rejects plugin not in allowlist", () => {
    const filePath = writeFile("evil.ts", "bad code");
    const result = verifyPlugin("evil.ts", filePath, {
      allowlist: ["good.ts"],
      appEnv: "production",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not in PLUGINS_ALLOWLIST");
  });

  test("allows plugin when hash matches manifest", () => {
    const content = "export const x = 1;\n";
    const filePath = writeFile("signed.ts", content);
    const manifest: PluginsManifest = {
      files: { "signed.ts": sha256(content) },
    };
    const result = verifyPlugin("signed.ts", filePath, {
      manifest,
      appEnv: "production",
    });
    expect(result.allowed).toBe(true);
  });

  test("rejects plugin when hash doesn't match manifest", () => {
    const filePath = writeFile("tampered.ts", "modified content");
    const manifest: PluginsManifest = {
      files: { "tampered.ts": sha256("original content") },
    };
    const result = verifyPlugin("tampered.ts", filePath, {
      manifest,
      appEnv: "production",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("SHA-256 hash does not match");
  });

  test("rejects plugin with no manifest entry", () => {
    const filePath = writeFile("unknown.ts", "code");
    const manifest: PluginsManifest = { files: { "other.ts": sha256("x") } };
    const result = verifyPlugin("unknown.ts", filePath, {
      manifest,
      appEnv: "production",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("no entry in plugins.manifest.json");
  });

  test("with BOTH configured, allows if passes allowlist only", () => {
    const filePath = writeFile("mixed.ts", "code");
    const manifest: PluginsManifest = {
      files: { "mixed.ts": sha256("different") },
    };
    const result = verifyPlugin("mixed.ts", filePath, {
      allowlist: ["mixed.ts"],
      manifest,
      appEnv: "production",
    });
    expect(result.allowed).toBe(true);
  });

  test("with BOTH configured, allows if passes manifest only", () => {
    const content = "code";
    const filePath = writeFile("manifest-only.ts", content);
    const manifest: PluginsManifest = {
      files: { "manifest-only.ts": sha256(content) },
    };
    const result = verifyPlugin("manifest-only.ts", filePath, {
      allowlist: ["other.ts"],
      manifest,
      appEnv: "production",
    });
    expect(result.allowed).toBe(true);
  });

  test("with BOTH configured, rejects if fails both", () => {
    const filePath = writeFile("neither.ts", "code");
    const manifest: PluginsManifest = {
      files: { "neither.ts": sha256("different") },
    };
    const result = verifyPlugin("neither.ts", filePath, {
      allowlist: ["good.ts"],
      manifest,
      appEnv: "production",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("failed both allowlist and signature");
  });

  test("rejects in production when NEITHER allowlist nor manifest configured", () => {
    const filePath = writeFile("prod.ts", "code");
    const result = verifyPlugin("prod.ts", filePath, {
      appEnv: "production",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(
      "No PLUGINS_ALLOWLIST or plugins.manifest.json configured in production",
    );
  });

  test("allows in development when NEITHER configured", () => {
    const filePath = writeFile("dev.ts", "code");
    const result = verifyPlugin("dev.ts", filePath, {
      appEnv: "development",
    });
    expect(result.allowed).toBe(true);
  });

  test("allows when no appEnv specified and NEITHER configured (non-production default)", () => {
    const filePath = writeFile("noenv.ts", "code");
    const result = verifyPlugin("noenv.ts", filePath, {});
    expect(result.allowed).toBe(true);
  });
});

describe("createPluginVerifier", () => {
  test("isActive is true in production even without allowlist/manifest", () => {
    const verifier = createPluginVerifier({ appEnv: "production" });
    expect(verifier.isActive).toBe(true);
  });

  test("isActive is true when allowlist is configured", () => {
    const verifier = createPluginVerifier({
      allowlist: ["plugin.ts"],
      appEnv: "development",
    });
    expect(verifier.isActive).toBe(true);
  });

  test("isActive is false in development without any config", () => {
    const verifier = createPluginVerifier({ appEnv: "development" });
    expect(verifier.isActive).toBe(false);
  });

  test("loads manifest from file and uses it for verification", () => {
    const content = 'export const hello = "world";\n';
    const pluginPath = writeFile("verified.ts", content);
    writeFile(
      "plugins.manifest.json",
      JSON.stringify({ files: { "verified.ts": sha256(content) } }),
    );
    const verifier = createPluginVerifier({
      manifestPath: path.join(dir, "plugins.manifest.json"),
      appEnv: "production",
    });
    expect(verifier.isActive).toBe(true);
    const result = verifier.verify("verified.ts", pluginPath);
    expect(result.allowed).toBe(true);
  });
});
