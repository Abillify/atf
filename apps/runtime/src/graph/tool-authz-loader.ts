// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tool Authorization Policy Loader (`src/graph/tool-authz-loader.ts`)
 *
 * Watches `tool-authz.json` in the flows directory and hot-reloads the
 * ToolAuthzEngine whenever the file changes, following the same pattern as
 * `flow-authorizer.ts` and `guardrail-policy.ts`.
 *
 * The file is optional — when absent, the engine is a no-op that allows
 * all tool calls (preserving backward compatibility).
 *
 * SECURITY NOTE (Req. 4.1/4.2): The tool-authz.json file resides in the
 * operator-controlled `./flows` directory (not in PLUGINS_DIR). Since this
 * directory is the platform's trusted source of truth (identical trust level
 * as flow definitions), no additional allowlist/signature verification is
 * required here. The PLUGINS_ALLOWLIST and plugins.manifest.json verification
 * applies only to dynamically loaded code modules in PLUGINS_DIR.
 *
 * No `any` at module boundaries.
 */

import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../observability/logger.js";
import type { Metrics } from "../observability/metrics.js";
import {
  createDenyAllToolAuthzEngine,
  createToolAuthzEngine,
  createToolAuthzEngineFromJson,
  ToolAuthzPolicySchema,
  type ToolAuthzEngine,
} from "./tool-authz.js";

export const TOOL_AUTHZ_FILE = "tool-authz.json";

export interface ToolAuthzSaveResult {
  ok: boolean;
  error?: string;
}

export interface ToolAuthzLoader {
  /** The current engine (reloaded on file change). */
  readonly engine: ToolAuthzEngine;
  /** True when a policy file was found and loaded successfully. */
  readonly hasPolicy: boolean;
  /**
   * True once a reload of `tool-authz.json` has failed (parse or read error)
   * and has not since been followed by a successful reload (Req 7.7). While
   * stale, the engine in effect is the last-known-good (or deny-all) policy —
   * NOT the file on disk. Surfaced as `aiperator_policy_stale_total` and the
   * `policy_stale` health flag.
   */
  readonly policyStale: boolean;
  /** Reload the policy file. Called by the flow-parser watcher on file change. */
  reload(): void;
  /**
   * Validates and persists a new policy to `tool-authz.json`, then reloads the
   * engine. Returns `{ ok: false, error }` on validation/write failure without
   * touching the on-disk file. Used by the dashboard's policy editor.
   */
  save(policy: unknown): ToolAuthzSaveResult;
}

class ToolAuthzLoaderImpl implements ToolAuthzLoader {
  private _engine: ToolAuthzEngine;
  private _hasPolicy = false;
  /** True once a syntactically valid policy has been loaded at least once. */
  private _hasValidPolicy = false;
  /** Req 7.7: set on every failed reload, cleared on the next success. */
  private _policyStale = false;
  private readonly filePath: string;
  private readonly failClosed: boolean;
  private readonly metrics: Metrics | undefined;

  constructor(
    flowsDir: string,
    private readonly logger?: Logger,
    options?: { failClosed?: boolean; metrics?: Metrics },
  ) {
    this.filePath = path.join(flowsDir, TOOL_AUTHZ_FILE);
    // Fail-closed is the secure default; callers opt out with failClosed:false.
    this.failClosed = options?.failClosed !== false;
    this.metrics = options?.metrics;
    this._engine = createToolAuthzEngine(undefined); // no-op until loaded
    this.reload();
  }

  get engine(): ToolAuthzEngine {
    return this._engine;
  }

  get hasPolicy(): boolean {
    return this._hasPolicy;
  }

  get policyStale(): boolean {
    return this._policyStale;
  }

  /** Req 7.7: mark the policy stale and count the failed reload. */
  private markPolicyStale(): void {
    this._policyStale = true;
    this.metrics?.recordCounter("aiperator_policy_stale_total", {});
  }

  save(policy: unknown): ToolAuthzSaveResult {
    // Validate before touching disk so a bad payload never corrupts the file.
    const parsed = ToolAuthzPolicySchema.safeParse(policy);
    if (!parsed.success) {
      const error = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      return { ok: false, error };
    }
    try {
      const serialized = JSON.stringify(parsed.data, null, 2);
      // Atomic write: write to a temp file then rename, so a crash mid-write
      // never leaves a truncated policy file that would disable all rules.
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, serialized, "utf-8");
      fs.renameSync(tmp, this.filePath);
      this.reload();
      this.logger?.info("Tool authorization policy saved via API", {
        file: this.filePath,
        ruleCount: parsed.data.rules.length,
      });
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger?.error("Failed to write tool-authz.json", { error });
      return { ok: false, error };
    }
  }

  reload(): void {
    if (!fs.existsSync(this.filePath)) {
      if (this._hasPolicy) {
        this._engine = createToolAuthzEngine(undefined);
        this._hasPolicy = false;
        this.logger?.info(
          "Tool authorization policy removed (tool-authz.json deleted)",
        );
      }
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const { engine, error } = createToolAuthzEngineFromJson(raw, {
        failClosed: this.failClosed,
      });
      if (error !== undefined) {
        // Malformed policy. Fail-closed: if we have no last-known-good policy
        // to fall back on, install the deny-all engine so a broken file never
        // degrades to "all tools allowed". Otherwise keep the previous policy.
        if (this.failClosed && !this._hasValidPolicy) {
          this._engine = createDenyAllToolAuthzEngine(
            `tool-authz.json failed to parse (${error}) — denying all tool calls (fail-closed)`,
          );
          this._hasPolicy = true;
          this.markPolicyStale();
          this.logger?.error(
            "Failed to parse tool-authz.json — failing CLOSED (all tool calls denied)",
            { error, file: this.filePath },
          );
          return;
        }
        this.markPolicyStale();
        this.logger?.warn(
          this.failClosed
            ? "Failed to parse tool-authz.json — keeping last-known-good policy (fail-closed)"
            : "Failed to parse tool-authz.json — keeping previous policy (fail-open)",
          { error, file: this.filePath },
        );
        return;
      }
      this._engine = engine;
      this._hasPolicy = engine.active;
      this._hasValidPolicy = true;
      this._policyStale = false;
      this.logger?.info("Tool authorization policy loaded", {
        file: this.filePath,
        active: this._hasPolicy,
      });
    } catch (err) {
      this.markPolicyStale();
      this.logger?.warn(
        "Error reading tool-authz.json — keeping previous policy",
        {
          error: err instanceof Error ? err.message : String(err),
          file: this.filePath,
        },
      );
    }
  }
}

export function createToolAuthzLoader(
  flowsDir: string,
  logger?: Logger,
  options?: { failClosed?: boolean; metrics?: Metrics },
): ToolAuthzLoader {
  return new ToolAuthzLoaderImpl(flowsDir, logger, options);
}
