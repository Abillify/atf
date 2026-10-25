// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Plugin Allowlist & Integrity Verification (`src/graph/plugin-verifier.ts`)
 *
 * Provides SHA-256 manifest verification and allowlist checking for plugin
 * modules before they are loaded. This is the security gate that prevents
 * untrusted code from executing in the platform process.
 *
 * Security policy:
 * - If BOTH allowlist AND manifest are configured: plugin must pass AT LEAST ONE
 * - If NEITHER is configured AND APP_ENV=production: reject (safe default)
 * - If a plugin fails verification: log security event, skip it
 *
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { OperationalProfile } from "@atf/security-kit";
import type { Logger } from "../observability/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Schema of `plugins.manifest.json` */
export interface PluginsManifest {
  files: Record<string, string>; // filename → sha256 hex
}

export interface PluginVerifierOptions {
  /** Comma-separated list of allowed plugin filenames, or ["*"] to allow all. */
  allowlist?: string[];
  /** Path to the plugins.manifest.json file. */
  manifestPath?: string;
  /** Effective operational profile (ATF_PROFILE / APP_ENV). */
  appEnv?: OperationalProfile;
  /** Logger for security events. */
  logger?: Logger;
}

export interface PluginVerificationResult {
  allowed: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

/**
 * Loads and parses the plugins manifest file.
 * Returns undefined if the file doesn't exist or is invalid.
 */
export function loadPluginsManifest(
  manifestPath: string,
  logger?: Logger,
): PluginsManifest | undefined {
  if (!fs.existsSync(manifestPath)) {
    return undefined;
  }
  try {
    const raw = fs.readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("files" in parsed) ||
      typeof (parsed as Record<string, unknown>).files !== "object"
    ) {
      logger?.warn(
        "plugins.manifest.json has invalid structure — ignoring manifest",
        {
          path: manifestPath,
        },
      );
      return undefined;
    }
    const files = (parsed as { files: unknown }).files;
    if (typeof files !== "object" || files === null) {
      return undefined;
    }
    // Validate that all values are hex strings
    const manifest: PluginsManifest = { files: {} };
    for (const [key, value] of Object.entries(
      files as Record<string, unknown>,
    )) {
      if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
        logger?.warn(
          "plugins.manifest.json contains invalid hash — ignoring entry",
          { file: key, path: manifestPath },
        );
        continue;
      }
      manifest.files[key] = value.toLowerCase();
    }
    return manifest;
  } catch (err) {
    logger?.warn("Failed to read plugins.manifest.json — ignoring manifest", {
      path: manifestPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// SHA-256 computation
// ---------------------------------------------------------------------------

/** Computes the SHA-256 hash of a file synchronously (plugins are small). */
export function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

// ---------------------------------------------------------------------------
// Verification logic
// ---------------------------------------------------------------------------

/**
 * Verifies whether a plugin file is allowed to be loaded.
 *
 * Decision matrix:
 * - allowlist=["*"]: always allowed (wildcard)
 * - allowlist configured, file in list: allowed via allowlist
 * - manifest configured, file hash matches: allowed via manifest
 * - BOTH configured, file passes EITHER: allowed
 * - NEITHER configured, production: REJECTED (safe default)
 * - NEITHER configured, non-production: allowed (development convenience)
 */
export function verifyPlugin(
  filename: string,
  filePath: string,
  options: {
    allowlist?: string[];
    manifest?: PluginsManifest;
    appEnv?: OperationalProfile;
  },
): PluginVerificationResult {
  const { allowlist, manifest, appEnv } = options;

  const hasAllowlist = allowlist !== undefined && allowlist.length > 0;
  const hasManifest =
    manifest !== undefined && Object.keys(manifest.files).length > 0;

  // Wildcard allowlist: everything is permitted
  if (hasAllowlist && allowlist[0] === "*") {
    return { allowed: true };
  }

  // Neither configured: depends on environment
  if (!hasAllowlist && !hasManifest) {
    if (appEnv === "production") {
      return {
        allowed: false,
        reason:
          "No PLUGINS_ALLOWLIST or plugins.manifest.json configured in production — plugin loading denied (safe default)",
      };
    }
    // Non-production: allow for developer convenience
    return { allowed: true };
  }

  // Check allowlist
  const passesAllowlist =
    hasAllowlist &&
    (allowlist.includes(filename) ||
      allowlist.includes(path.basename(filename)));

  // Check manifest (compute hash only if manifest exists and has an entry for this file)
  let passesManifest = false;
  if (hasManifest) {
    const expectedHash =
      manifest.files[filename] ?? manifest.files[path.basename(filename)];
    if (expectedHash !== undefined) {
      const actualHash = computeFileHash(filePath);
      passesManifest = actualHash === expectedHash;
    }
    // If manifest exists but has no entry for this file, it doesn't pass manifest check
  }

  // If BOTH configured: must pass AT LEAST ONE
  // If only one configured: must pass that one
  if (hasAllowlist && hasManifest) {
    if (passesAllowlist || passesManifest) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Plugin "${filename}" failed both allowlist and signature verification`,
    };
  }

  if (hasAllowlist) {
    if (passesAllowlist) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Plugin "${filename}" is not in PLUGINS_ALLOWLIST`,
    };
  }

  // Only manifest configured
  if (passesManifest) {
    return { allowed: true };
  }

  if (manifest === undefined) {
    // Unreachable: this branch only runs when hasManifest is true (both the
    // "neither configured" and "allowlist only" branches above already
    // returned).
    return {
      allowed: false,
      reason: `Plugin "${filename}" has no entry in plugins.manifest.json`,
    };
  }
  const expectedHash =
    manifest.files[filename] ?? manifest.files[path.basename(filename)];
  if (expectedHash === undefined) {
    return {
      allowed: false,
      reason: `Plugin "${filename}" has no entry in plugins.manifest.json`,
    };
  }
  return {
    allowed: false,
    reason: `Plugin "${filename}" SHA-256 hash does not match plugins.manifest.json`,
  };
}

// ---------------------------------------------------------------------------
// High-level verifier factory
// ---------------------------------------------------------------------------

export interface PluginVerifier {
  /** Check if a plugin file is allowed to load. */
  verify(filename: string, filePath: string): PluginVerificationResult;
  /** Whether any verification mechanism is active. */
  readonly isActive: boolean;
}

/**
 * Creates a PluginVerifier configured from the app options.
 * The manifest is loaded once at creation time (reload on file change is not
 * needed since plugins are loaded at startup).
 */
export function createPluginVerifier(
  options: PluginVerifierOptions,
): PluginVerifier {
  const { allowlist, manifestPath, appEnv, logger } = options;

  // Resolve manifest
  let manifest: PluginsManifest | undefined;
  if (manifestPath) {
    manifest = loadPluginsManifest(manifestPath, logger);
  }

  const hasAllowlist = allowlist !== undefined && allowlist.length > 0;
  const hasManifest =
    manifest !== undefined && Object.keys(manifest.files).length > 0;
  const isActive = hasAllowlist || hasManifest || appEnv === "production";

  return {
    get isActive() {
      return isActive;
    },
    verify(filename: string, filePath: string): PluginVerificationResult {
      return verifyPlugin(filename, filePath, { allowlist, manifest, appEnv });
    },
  };
}
