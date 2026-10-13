// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Shared closure state for the flows management routes (Phase 18.4 split
 * of flows.ts, Req. 13.6). createFlowsContext() builds exactly the locals
 * createFlowsRouter used to close over; the route modules receive it as
 * `fc` so behaviour is unchanged.
 */

import * as fs from "node:fs";
import { expandFlowSource, type FlowRegistry } from "../graph/flow-parser.js";
import type { FlowStore } from "../graph/flow-store.js";
import type { DbFlowSource } from "../graph/flow-registry-composite.js";
import type { StudioTestRegistry } from "../graph/flow-registry-studio.js";
import type { CompliancePolicy } from "../compliance/policy-schema.js";
import type { SimulationDeps } from "../graph/graph-engine/simulate.js";
import type { AbManager } from "../graph/flow-ab.js";
import type { AppConfig } from "../config/index.js";
import {
  createOperatorAuthorizer,
  type OperatorAuthorizer,
  type OperatorIdentity,
} from "../middleware/operator-rbac.js";
import type { AuditLog } from "../observability/audit-log.js";

export interface FlowsRouterDeps {
  /** File-based flows (read-only here). */
  fileRegistry: FlowRegistry;
  /** Online flow store — when absent, write routes return 501. */
  store?: FlowStore;
  /** DB snapshot to refresh after a mutation (immediate local effect). */
  dbSource?: Pick<DbFlowSource, "refresh">;
  /** Known MCP tool ids for validation warnings. */
  knownToolIds?: ReadonlySet<string>;
  /** Require a valid token (header or ?token=) — mirrors MONITORING_AUTH. */
  authRequired?: boolean;
  /** Optional A/B experiment manager (exposes live experiment stats). */
  abManager?: AbManager;
  /** Operator RBAC authorizer (defaults to a back-compat one from authRequired). */
  operatorAuth?: OperatorAuthorizer;
  /** Optional audit log for recording flow mutations. */
  auditLog?: AuditLog;
  /**
   * Used to report a fallback from the comment-preserving YAML merge to a plain
   * rewrite. Optional — the outcome is also in the response body and the audit
   * entry (`commentsPreserved`), so a missing logger loses no evidence.
   */
  logger?: import("../observability/logger.js").Logger;
  /**
   * Directory that contains flow YAML/JSON files. Required for the file-based
   * write endpoint (POST/PUT /flows/write). When absent the endpoint returns 501.
   * Req. 22 — path-traversal protection uses this as the trusted base.
   */
  flowsDir?: string;
  /**
   * Flows directory used READ-ONLY to expand source-form definitions (model
   * shortcuts, prompt includes) for validation and to serve a file flow's
   * editable source. Independent of `flowsDir`, which additionally enables
   * writing files.
   */
  sourceDir?: string;
  /**
   * Throwaway registry for Studio "Run & Trace" test runs
   * (`POST /flows/:id/test-run`). When absent that endpoint returns 501.
   */
  studioTests?: StudioTestRegistry;
  /**
   * Application configuration, used solely to resolve the LLM behind
   * `POST /flows/:id/copilot` (`appConfig.defaultLlm` + provider API keys via
   * `createLlmProvider`). When absent, or `defaultLlm` is unset, the copilot
   * endpoint returns 501 rather than guessing a model.
   */
  appConfig?: AppConfig;
  /** Current compliance policy reader for read-only release assessment. */
  getCompliancePolicy?: () => CompliancePolicy | undefined;
  /**
   * Collaborators for `POST /flows/:id/simulate` (counterfactual impact
   * simulation — runs a draft against real historical snapshots). When
   * absent (or `appConfig` is absent), the endpoint returns 501: it needs a
   * replay store to source snapshots from, so there's nothing useful for it
   * to do without one.
   */
  simulation?: Omit<SimulationDeps, "appConfig">;
}

/** Everything createFlowsRouter used to close over, as an explicit object. */
export interface FlowsContext {
  deps: FlowsRouterDeps;
  fileRegistry: FlowRegistry;
  store: FlowStore | undefined;
  dbSource: Pick<DbFlowSource, "refresh"> | undefined;
  knownToolIds: ReadonlySet<string> | undefined;
  abManager: AbManager | undefined;
  auditLog: AuditLog | undefined;
  flowsDir: string | undefined;
  appConfig: AppConfig | undefined;
  getCompliancePolicy: (() => CompliancePolicy | undefined) | undefined;
  authRequired: boolean;
  sourceDir: string | undefined;
  expandForValidation: (def: unknown) => unknown;
  operatorAuth: OperatorAuthorizer;
  logger: import("../observability/logger.js").Logger | undefined;
  guard: (
    ctx: {
      req: {
        header: (k: string) => string | undefined;
        query: (k: string) => string | undefined;
      };
    },
    perm: Parameters<OperatorAuthorizer["authorize"]>[2],
  ) => Promise<OperatorIdentity | null>;
  unauthorized: (ctx: import("hono").Context) => Response;
  flowsDirWritable: () => boolean;
  requireStore: (ctx: import("hono").Context) => Response;
  requireFlowsDir: (ctx: import("hono").Context) => Response;
}

export function createFlowsContext(deps: FlowsRouterDeps): FlowsContext {
  const {
    fileRegistry,
    store,
    dbSource,
    knownToolIds,
    abManager,
    auditLog,
    flowsDir,
    appConfig,
    getCompliancePolicy,
  } = deps;
  const authRequired = deps.authRequired ?? false;
  const sourceDir = deps.sourceDir ?? flowsDir;
  /**
   * Source-form definitions keep `llm.shortcut`, `{{vars.*}}` and prompt
   * includes as references (that is what the editor saves). Validation must
   * see what the runtime will run, so expand a copy first. A no-op for
   * already-expanded definitions.
   */
  const expandForValidation = (def: unknown): unknown =>
    sourceDir !== undefined ? expandFlowSource(def, sourceDir) : def;
  const operatorAuth =
    deps.operatorAuth ?? createOperatorAuthorizer({ authRequired });
  const logger = deps.logger;

  /** Permission-aware guard: returns the actor when allowed, else null. */
  const guard = async (
    ctx: {
      req: {
        header: (k: string) => string | undefined;
        query: (k: string) => string | undefined;
      };
    },
    perm: Parameters<OperatorAuthorizer["authorize"]>[2],
  ): Promise<OperatorIdentity | null> => {
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      perm,
    );
    return r.ok
      ? (r.actor ?? { name: "operator", role: "admin", via: "open" })
      : null;
  };

  const unauthorized = (ctx: import("hono").Context) =>
    ctx.json(
      {
        error: {
          message: "Unauthorized operator access.",
          type: "authentication_error",
        },
      },
      401,
    );

  /** Configured AND actually writable (a read-only mount must not offer writes). */
  const flowsDirWritable = (): boolean => {
    if (flowsDir === undefined) return false;
    try {
      fs.accessSync(flowsDir, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };

  const requireStore = (ctx: import("hono").Context) =>
    ctx.json(
      {
        error: {
          message:
            "Online flow editing is disabled. Set FLOW_EDITOR_ENABLED=true and configure DATABASE_URL, or deploy flows via FLOWS_DIR.",
          type: "not_implemented_error",
        },
      },
      501,
    );

  const requireFlowsDir = (ctx: import("hono").Context) =>
    ctx.json(
      {
        error: {
          message:
            "File-based flow writing is disabled. Configure FLOWS_DIR to enable this endpoint.",
          type: "not_implemented_error",
        },
      },
      501,
    );

  return {
    deps,
    fileRegistry,
    store,
    dbSource,
    knownToolIds,
    abManager,
    auditLog,
    flowsDir,
    appConfig,
    getCompliancePolicy,
    authRequired,
    sourceDir,
    expandForValidation,
    operatorAuth,
    logger,
    guard,
    unauthorized,
    flowsDirWritable,
    requireStore,
    requireFlowsDir,
  };
}
