// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Compliance Policy Loader (`src/compliance/policy-loader.ts`)
 *
 * Hot-reloading loader for `compliance-policy.yaml` (or `.json`) in FLOWS_DIR.
 * Follows the same pattern as `canary.ts` and `flow-dispatcher.ts`:
 *   - A bad or missing file is never a hard crash — the loader returns `undefined`
 *     and the evaluator treats that as "policy absent / allow-all".
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
  /** True when a policy file is present and valid. */
  readonly hasPolicy: boolean;
  /** Reloads from disk. Called by the file-watcher hot-reload hook. */
  reload(): void;
}

class CompliancePolicyLoaderImpl implements CompliancePolicyLoader {
  private _policy: CompliancePolicy | undefined;

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

  reload(): void {
    this.load();
  }

  private load(): void {
    const filePath = resolveConfigFile(this.flowsDir, POLICY_FILE);
    if (filePath === null) {
      if (this._policy !== undefined) {
        this.logger?.info("[Compliance] Policy file removed — policy disabled");
        this._policy = undefined;
      }
      return;
    }

    let raw: unknown;
    try {
      raw = parseFlowFile(filePath);
    } catch (err) {
      this.logger?.warn("[Compliance] Failed to read/parse compliance-policy — policy DISABLED", {
        file: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      this._policy = undefined;
      return;
    }

    const result = CompliancePolicySchema.safeParse(raw);
    if (!result.success) {
      this.logger?.warn("[Compliance] compliance-policy failed schema validation — policy DISABLED", {
        issues: result.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      this._policy = undefined;
      return;
    }

    this._policy = result.data;
    this.logger?.info("[Compliance] Policy loaded", {
      dataRules: result.data.dataRules?.length ?? 0,
      modelRules: result.data.modelRules?.length ?? 0,
      approvalRules: result.data.approvalRules?.length ?? 0,
      retentionRules: result.data.retentionRules?.length ?? 0,
      auditRules: result.data.auditRules?.length ?? 0,
    });
  }
}

export function createCompliancePolicyLoader(
  flowsDir: string,
  logger?: Logger,
): CompliancePolicyLoader {
  return new CompliancePolicyLoaderImpl(flowsDir, logger);
}
