// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Compliance Policy Loader (`src/compliance/policy-loader.ts`)
 *
 * Hot-reloading loader for `compliance-policy.yaml` (or `.json`) in FLOWS_DIR.
 *   - A missing file means "no policy" — the evaluator allows everything.
 *   - A present but unreadable or invalid file never disables enforcement:
 *       · on hot-reload the last valid policy stays in force;
 *       · at startup (no valid policy yet) `enforcementBlocked` is true and the
 *         admission gates refuse every run until the file is fixed.
 *     `loadError` names the failure either way; it is cleared by the next
 *     successful load or by removing the file.
 *   - `reload()` is called by the chokidar file-watcher via `onComplianceChange`
 *     in the flow-parser service.
 *
 * No `any` at module boundaries.
 */

import type { CompliancePolicy } from "./policy-schema.js";
import { CompliancePolicySchema } from "./policy-schema.js";
import type { Logger } from "../observability/logger.js";
import { parseFlowFile, resolveConfigFile } from "../util/parse-flow-file.js";

const POLICY_FILE = "compliance-policy";

export interface CompliancePolicyLoader {
  /** Returns the currently loaded (and validated) policy, or undefined. */
  readonly policy: CompliancePolicy | undefined;
  /** True when a valid policy is in force (possibly the last valid one). */
  readonly hasPolicy: boolean;
  /** Why the policy file last failed to load, or undefined after a good load. */
  readonly loadError: string | undefined;
  /**
   * True when a policy file exists but no valid policy has ever been loaded
   * from it. Admission must then deny instead of treating it as "no policy".
   */
  readonly enforcementBlocked: boolean;
  /** Reloads from disk. Called by the file-watcher hot-reload hook. */
  reload(): void;
}

class CompliancePolicyLoaderImpl implements CompliancePolicyLoader {
  private _policy: CompliancePolicy | undefined;
  private _loadError: string | undefined;

  constructor(
    private readonly flowsDir: string,
    private readonly logger?: Logger,
  ) {
    this.load();
  }

  get policy(): CompliancePolicy | undefined {
    return this._policy;
  }

  get hasPolicy(): boolean {
    return this._policy !== undefined;
  }

  get loadError(): string | undefined {
    return this._loadError;
  }

  get enforcementBlocked(): boolean {
    return this._loadError !== undefined && this._policy === undefined;
  }

  reload(): void {
    this.load();
  }

  private load(): void {
    const filePath = resolveConfigFile(this.flowsDir, POLICY_FILE);
    if (filePath === null) {
      if (this._policy !== undefined || this._loadError !== undefined) {
        this.logger?.info("[Compliance] Policy file removed — policy disabled");
      }
      this._policy = undefined;
      this._loadError = undefined;
      return;
    }

    let raw: unknown;
    try {
      raw = parseFlowFile(filePath);
    } catch (err) {
      this.fail(filePath, `unreadable: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const result = CompliancePolicySchema.safeParse(raw);
    if (!result.success) {
      this.fail(
        filePath,
        `schema validation failed: ${result.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      );
      return;
    }

    this._policy = result.data;
    this._loadError = undefined;
    this.logger?.info("[Compliance] Policy loaded", {
      dataRules: result.data.dataRules?.length ?? 0,
      modelRules: result.data.modelRules?.length ?? 0,
      approvalRules: result.data.approvalRules?.length ?? 0,
      retentionRules: result.data.retentionRules?.length ?? 0,
      auditRules: result.data.auditRules?.length ?? 0,
    });
  }

  /**
   * A present but broken file: keep the last valid policy in force, or — with
   * none loaded yet — block admission. Never fall back to "no policy".
   */
  private fail(filePath: string, reason: string): void {
    this._loadError = reason;
    if (this._policy !== undefined) {
      this.logger?.error(
        "[Compliance] compliance-policy is invalid — keeping the last valid policy in force",
        { file: filePath, error: reason },
      );
    } else {
      this.logger?.error(
        "[Compliance] compliance-policy is invalid and no valid policy is loaded — all runs are DENIED until it is fixed",
        { file: filePath, error: reason },
      );
    }
  }
}

export function createCompliancePolicyLoader(
  flowsDir: string,
  logger?: Logger,
): CompliancePolicyLoader {
  return new CompliancePolicyLoaderImpl(flowsDir, logger);
}
