// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Sandbox service (`src/sandbox/sandbox-service.ts`)
 *
 * The one entry point an assistant's tools call to write and run scripts. Joins
 * the policy (`policy.ts`), the workspace boundary
 * (`assistants/workspace.ts`), the human approval gate
 * (`graph/approval-gate.ts`) and the container backend (`docker-backend.ts`).
 *
 * Thin on purpose: every decision worth arguing about lives in one of those four
 * modules. What this file owns is the ORDER, and the order is the security
 * property:
 *
 *   1. policy check      — is this shape of run permitted at all
 *   2. path resolution   — realpath containment against the workspace
 *   3. approval          — a human decides, if the autonomy level says so
 *   4. execution         — container with the hardening flags
 *
 * Approval comes after path resolution so the prompt names a path that has already
 * been proven to be inside the workspace; asking a human to approve a path that
 * later turns out to escape would make the approval meaningless.
 *
 * No `any` at module boundaries.
 */

import path from "node:path";
import fs from "node:fs";
import type { AssistantWorkspaceResolver } from "../assistants/workspace.js";
import { WorkspacePathError } from "../assistants/workspace.js";
import type { AssistantScope, AssistantAutonomy } from "../assistants/types.js";
import type { ApprovalRegistry } from "../graph/approval-gate.js";
import type { Logger } from "../observability/logger.js";
import type { ContainerSandboxBackend, SandboxRunResult } from "./docker-backend.js";
import {
  decideSandboxExecution,
  type SandboxExecutionRequest,
  type SandboxInterpreter,
  type SandboxLimits,
  type SandboxNetwork,
} from "./policy.js";

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/**
 * The result of asking to run something.
 *
 * A discriminated union rather than a result plus flags: "refused by policy",
 * "denied by a human" and "ran and failed" need completely different follow-up
 * from the model, and a shared shape with optional fields invites treating one as
 * another.
 */
export type SandboxExecutionOutcome =
  | { kind: "executed"; result: SandboxRunResult }
  | {
      kind: "refused";
      /** Why policy or the workspace boundary refused. Model-facing. */
      detail: string;
    }
  | {
      kind: "denied";
      /** Human decision text, or the auto-deny reason on timeout. */
      detail: string;
      timedOut: boolean;
    };

/** Result of writing a script. */
export interface ScriptWriteResult {
  /** Path as the assistant should refer to it, relative to its workspace. */
  relativePath: string;
  bytes: number;
  /** True when an existing file was replaced. */
  replaced: boolean;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface SandboxServiceOptions {
  workspaces: AssistantWorkspaceResolver;
  backend?: ContainerSandboxBackend;
  approvals?: ApprovalRegistry;
  /** Deployment-level switch. */
  enabled: boolean;
  /** Operator-configured network posture. Never model-selected. */
  network?: SandboxNetwork;
  limits?: Partial<SandboxLimits>;
  logger?: Logger;
}

/** Context of the run requesting execution. */
export interface SandboxCallContext {
  scope: AssistantScope;
  autonomy: AssistantAutonomy;
  assistantActive: boolean;
  /** Whether code execution is enabled for this specific assistant. */
  enabledForAssistant: boolean;
  executionId: string;
  nodeId: string;
  /** Display name of the person whose request this is, for the approval record. */
  requestedBy?: string;
  signal?: AbortSignal;
}

/** Maximum script size an assistant may write. */
export const MAX_SCRIPT_BYTES = 256 * 1024;

/** Writes and runs assistant scripts. */
export class SandboxService {
  constructor(private readonly options: SandboxServiceOptions) {}

  /** True when a container runtime is present and execution is switched on. */
  get available(): boolean {
    return this.options.enabled && this.options.backend !== undefined;
  }

  /**
   * Writes a script into the assistant's workspace.
   *
   * Unrestricted by design — see the policy module's note. Writing is not running,
   * and gating writes produces an assistant that cannot draft or show its work
   * before asking for permission to run it.
   */
  async writeScript(params: {
    scope: AssistantScope;
    relativePath: string;
    content: string;
  }): Promise<ScriptWriteResult> {
    const bytes = Buffer.byteLength(params.content, "utf8");
    if (bytes > MAX_SCRIPT_BYTES) {
      throw new Error(
        `Script is ${bytes} bytes, over the ${MAX_SCRIPT_BYTES} limit. ` +
          "Split it into smaller scripts, or write the data to a separate file.",
      );
    }
    // The resolver proves containment with realpath, following any symlink in the
    // existing prefix. A lexical check would be defeated by a symlink the assistant
    // itself created on an earlier run.
    const absolute = await this.options.workspaces.resolveInWorkspace(
      params.scope,
      params.relativePath,
    );
    const existed = fs.existsSync(absolute);
    await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
    await fs.promises.writeFile(absolute, params.content, {
      encoding: "utf8",
      // Owner-only. The workspace is per-assistant, and a mode that let other
      // local users read it would undo that on a shared host.
      mode: 0o600,
    });
    return {
      relativePath: params.relativePath,
      bytes,
      replaced: existed,
    };
  }

  /** Reads a file from the assistant's workspace. */
  async readFile(params: {
    scope: AssistantScope;
    relativePath: string;
    maxBytes?: number;
  }): Promise<string> {
    const absolute = await this.options.workspaces.resolveInWorkspace(
      params.scope,
      params.relativePath,
    );
    const limit = params.maxBytes ?? MAX_SCRIPT_BYTES;
    const stat = await fs.promises.stat(absolute);
    if (!stat.isFile()) {
      throw new Error(`${params.relativePath} is not a regular file.`);
    }
    if (stat.size > limit) {
      throw new Error(
        `${params.relativePath} is ${stat.size} bytes, over the ${limit} read limit. ` +
          "Have a script process it and write a summary instead of reading it whole.",
      );
    }
    return fs.promises.readFile(absolute, "utf8");
  }

  /** Lists workspace entries under a relative directory. */
  async listFiles(params: {
    scope: AssistantScope;
    relativePath?: string;
  }): Promise<{ name: string; kind: "file" | "directory"; bytes?: number }[]> {
    const target = params.relativePath ?? ".";
    const absolute = await this.options.workspaces.resolveInWorkspace(
      params.scope,
      target === "." ? "./" : target,
    );
    const entries = await fs.promises.readdir(absolute, {
      withFileTypes: true,
    });
    const results = await Promise.all(
      entries.map(async (entry) => {
        if (entry.isDirectory()) {
          return { name: entry.name, kind: "directory" as const };
        }
        try {
          const stat = await fs.promises.stat(path.join(absolute, entry.name));
          return {
            name: entry.name,
            kind: "file" as const,
            bytes: stat.size,
          };
        } catch {
          // A file that vanished between readdir and stat is reported without a
          // size rather than failing the whole listing.
          return { name: entry.name, kind: "file" as const };
        }
      }),
    );
    // Sorted so repeated listings are byte-identical: the result may end up in the
    // prompt, and readdir order is filesystem-dependent.
    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Runs a script, applying policy, containment, approval, and container limits.
   *
   * Never throws for a refusal or a denial — both are returned as outcomes. A
   * thrown refusal would surface to the model as a tool error, which reads as "the
   * tool is broken" rather than "you are not allowed to do that", and the model
   * retries broken tools.
   */
  async execute(params: {
    context: SandboxCallContext;
    request: SandboxExecutionRequest;
  }): Promise<SandboxExecutionOutcome> {
    const { context, request } = params;
    const backend = this.options.backend;

    const decision = decideSandboxExecution({
      request,
      capability: {
        runtimeAvailable: backend !== undefined,
        enabledForDeployment: this.options.enabled,
        enabledForAssistant: context.enabledForAssistant,
        autonomy: context.autonomy,
        assistantActive: context.assistantActive,
      },
      ...(this.options.limits !== undefined ? { limits: this.options.limits } : {}),
      ...(this.options.network !== undefined ? { network: this.options.network } : {}),
    });
    if (!decision.allow) {
      return { kind: "refused", detail: decision.detail };
    }
    if (backend === undefined) {
      // Unreachable given the capability check above; kept so the type narrows
      // without a non-null assertion.
      return {
        kind: "refused",
        detail: "No container runtime is available on this deployment.",
      };
    }

    // Containment BEFORE approval, so the approval prompt names a path already
    // proven to be inside the workspace.
    let workspacePath: string;
    let absoluteScript: string;
    try {
      workspacePath = await this.options.workspaces.ensureWorkspace(context.scope);
      absoluteScript = await this.options.workspaces.resolveInWorkspace(
        context.scope,
        request.scriptPath,
      );
    } catch (err) {
      if (err instanceof WorkspacePathError) {
        return { kind: "refused", detail: err.message };
      }
      throw err;
    }

    if (!fs.existsSync(absoluteScript)) {
      return {
        kind: "refused",
        detail:
          `There is no file at ${request.scriptPath} in your workspace. ` +
          "Write the script first, then run it.",
      };
    }

    if (decision.requiresApproval) {
      const gate = this.options.approvals;
      if (gate === undefined || !gate.enabled) {
        // Fail closed. The autonomy level says a human must decide; with no gate to
        // ask, the answer is no. Running anyway would silently convert `supervised`
        // into `autonomous` on any deployment that has not configured approvals.
        return {
          kind: "refused",
          detail:
            "Running a script needs a human decision at your autonomy level, but no approval " +
            "channel is configured on this deployment, so it cannot be run. Explain to the user " +
            "what the script does and let them run it themselves.",
        };
      }
      const outcome = await gate.request({
        executionId: context.executionId,
        nodeId: context.nodeId,
        // Namespaced so the approval history distinguishes a code run from an MCP
        // tool call of the same name.
        tool: `sandbox/${request.interpreter}`,
        args: {
          script: request.scriptPath,
          argumentCount: (request.args ?? []).length,
          network: decision.network,
          ...(request.purpose !== undefined ? { purpose: request.purpose } : {}),
          prompt: decision.approvalPrompt ?? "",
        },
        ...(context.scope.tenantId !== "_" ? { tenantId: context.scope.tenantId } : {}),
        ...(context.requestedBy !== undefined ? { requestedBy: context.requestedBy } : {}),
      });
      if (!outcome.approved) {
        return {
          kind: "denied",
          timedOut: outcome.timedOut === true,
          detail:
            outcome.timedOut === true
              ? "The approval request expired without a decision, so the script was not run. " +
                "Do not retry it in a loop — tell the user it is waiting on them."
              : `A human declined to run the script${outcome.reason !== undefined ? `: ${outcome.reason}` : "."} ` +
                "Do not retry it. Ask what they would prefer instead.",
        };
      }
    }

    const relativeScriptPath = path.relative(workspacePath, absoluteScript);
    const result = await backend.run({
      workspacePath,
      relativeScriptPath,
      interpreter: request.interpreter,
      args: request.args ?? [],
      limits: decision.limits,
      network: decision.network,
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    });

    this.options.logger?.info("Sandbox run finished", {
      assistantId: context.scope.assistantId,
      interpreter: request.interpreter,
      status: result.status,
      durationMs: result.durationMs,
    });
    return { kind: "executed", result };
  }
}

/**
 * Renders a run outcome as the text handed back to the model.
 *
 * Kept as a function rather than inlined at the tool boundary because the shape of
 * this text is what determines whether the model does something sensible next: a
 * result with no summary and no next step produces either a blind retry or a turn
 * that ends without telling the user anything.
 */
export function renderSandboxOutcome(outcome: SandboxExecutionOutcome): string {
  if (outcome.kind === "refused") {
    return `Not run: ${outcome.detail}`;
  }
  if (outcome.kind === "denied") {
    return `Not run: ${outcome.detail}`;
  }
  const { result } = outcome;
  const parts = [
    `Status: ${result.status}${result.exitCode !== undefined ? ` (exit ${result.exitCode})` : ""}`,
    `Duration: ${(result.durationMs / 1000).toFixed(1)}s`,
    result.summary,
  ];
  if (result.stdout.trim().length > 0) {
    parts.push("", "stdout:", result.stdout.trimEnd());
  }
  if (result.stderr.trim().length > 0) {
    parts.push("", "stderr:", result.stderr.trimEnd());
  }
  if (result.stdout.trim().length === 0 && result.stderr.trim().length === 0) {
    // A silent success is ambiguous to a model: it cannot tell "worked, printed
    // nothing" from "did not run". Saying so prevents a pointless re-run.
    parts.push("", "The script produced no output.");
  }
  return parts.join("\n");
}

/** Sandbox surface exposed to the assistant, for capability gating in prompts. */
export interface SandboxCapabilityInfo {
  available: boolean;
  interpreters: readonly SandboxInterpreter[];
  requiresApproval: boolean;
  network: SandboxNetwork;
}
