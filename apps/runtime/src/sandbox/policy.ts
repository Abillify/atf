// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Sandbox execution policy (`src/sandbox/policy.ts`)
 *
 * Decides whether an assistant may run code, and under what conditions. Pure —
 * no filesystem, no container runtime, no clock — so the security rule can be
 * read, reviewed and tested as a rule.
 *
 * ## The split that makes this safe
 *
 * **Writing a script is not running one.** An assistant generating a Python file
 * into its own workspace has done nothing dangerous: the file sits in a directory
 * only that assistant can reach, and nothing has executed. So writing is
 * unrestricted, and every gate here applies to EXECUTION.
 *
 * This matters because the alternative — gating file writes — produces an
 * assistant that cannot draft, iterate, or show its work before asking, and
 * therefore asks for approval on a script the user cannot yet read.
 *
 * ## The three gates
 *
 * 1. **Capability.** Is code execution enabled for this deployment and this
 *    assistant at all? Off by default.
 * 2. **Authority.** Autonomy decides whether execution needs a human decision.
 *    `supervised` always asks; `assisted` asks for anything beyond the safe set;
 *    `autonomous` runs without asking but still inside the container limits.
 * 3. **Shape.** The interpreter must be one of a fixed set, and the target must be
 *    a workspace-relative path. Both are enforced structurally rather than by
 *    inspecting the code, because inspecting code for danger does not work: any
 *    check on the source is defeated by generating the dangerous form at runtime.
 *
 * ## What is NOT attempted
 *
 * There is deliberately no source-code analysis, no import allowlist, and no
 * pattern matching on the script. The containment boundary is the container:
 * no network, a read-only root filesystem, only the assistant's own workspace
 * mounted, dropped capabilities, bounded CPU/memory/PIDs/time. A script that gets
 * past that is a container escape, which a regex was never going to prevent.
 *
 * No `any` at module boundaries.
 */

import type { AssistantAutonomy } from "../assistants/types.js";

// ---------------------------------------------------------------------------
// Interpreters
// ---------------------------------------------------------------------------

/**
 * Interpreters an assistant may invoke.
 *
 * A closed set, not a command string. Allowing a free-form command would make the
 * container's entrypoint model-controlled, and then every argument-injection
 * question becomes a security question. With a fixed interpreter and a validated
 * script path, the command line is constructed entirely by us.
 */
export const SANDBOX_INTERPRETERS = ["python", "bash", "node"] as const;

export type SandboxInterpreter = (typeof SANDBOX_INTERPRETERS)[number];

/** True when `value` names a supported interpreter. */
export function isSandboxInterpreter(value: string): value is SandboxInterpreter {
  return (SANDBOX_INTERPRETERS as readonly string[]).includes(value);
}

/**
 * Interpreters considered low-risk enough to run without asking at `assisted`
 * autonomy.
 *
 * Only `python`. Not because Python is inherently safer than the others, but
 * because inside this container it is the *analysis* path: the assistant reads
 * files from its workspace, computes, writes results back. `bash` exists to drive
 * tooling and `node` to run generated JavaScript; both are more often used to
 * reach outward, so they stay behind a decision at `assisted`.
 */
const UNATTENDED_INTERPRETERS: ReadonlySet<SandboxInterpreter> = new Set<SandboxInterpreter>([
  "python",
]);

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Resource ceilings applied to every run.
 *
 * Constants rather than per-assistant configuration: an operator raising them does
 * not get a more capable assistant, they get a host that one runaway script can
 * destabilise. A deployment that genuinely needs more can override the whole
 * profile at the backend level, which is a deliberate operator act.
 */
export interface SandboxLimits {
  /** Wall-clock ceiling for one run. */
  timeoutMs: number;
  /** Container memory ceiling. */
  memoryMb: number;
  /** CPU share, in cores. */
  cpus: number;
  /** Process/thread ceiling, so a fork bomb hits a limit instead of the host. */
  pids: number;
  /** Combined stdout+stderr characters retained. */
  maxOutputChars: number;
  /** Writable scratch space at /tmp inside the container. */
  tmpfsMb: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  timeoutMs: 60_000,
  memoryMb: 512,
  cpus: 1,
  pids: 128,
  // Generous enough for a real analysis result, small enough that a runaway
  // print loop cannot fill the model's context. The excess is truncated with a
  // marker rather than dropped silently.
  maxOutputChars: 24_000,
  tmpfsMb: 64,
};

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/**
 * Network posture for a run.
 *
 * `none` is the default and the only value an assistant can select for itself.
 * `egress` exists for operator-configured workloads that genuinely need to reach
 * out; it is never chosen by the model, because a script with network access can
 * exfiltrate the workspace it was given to analyse.
 */
export type SandboxNetwork = "none" | "egress";

// ---------------------------------------------------------------------------
// Request and decision
// ---------------------------------------------------------------------------

/** What the assistant asked to run. */
export interface SandboxExecutionRequest {
  interpreter: SandboxInterpreter;
  /** Workspace-relative path of the script. Validated by the workspace resolver. */
  scriptPath: string;
  /** Arguments passed to the script. Never interpreted by a shell. */
  args?: readonly string[];
  /** Why the assistant wants to run it. Shown in the approval prompt. */
  purpose?: string;
}

/** Deployment- and assistant-level capability state. */
export interface SandboxCapability {
  /** Whether the deployment has a container runtime configured. */
  runtimeAvailable: boolean;
  /** Whether code execution is enabled for this deployment. */
  enabledForDeployment: boolean;
  /** Whether it is enabled for this assistant. */
  enabledForAssistant: boolean;
  autonomy: AssistantAutonomy;
  /** False when the assistant is suspended or archived. */
  assistantActive: boolean;
}

/** Why execution was refused outright. */
export type SandboxRefusalReason =
  | "no-runtime"
  | "disabled-for-deployment"
  | "disabled-for-assistant"
  | "assistant-inactive"
  | "unsupported-interpreter"
  | "invalid-script-path"
  | "too-many-arguments"
  | "argument-too-long";

export type SandboxPolicyDecision =
  | {
      allow: true;
      /** True when a human must approve before the run starts. */
      requiresApproval: boolean;
      /** Rendered approval prompt, present when approval is required. */
      approvalPrompt?: string;
      limits: SandboxLimits;
      network: SandboxNetwork;
    }
  | {
      allow: false;
      reason: SandboxRefusalReason;
      /**
       * Model-facing explanation that states what to do instead. A bare refusal
       * produces a retry of the same call; a stated alternative produces progress
       * or an honest report to the user.
       */
      detail: string;
    };

/** Bounds on the argument vector, so a request cannot become its own payload. */
const MAX_ARGS = 32;
const MAX_ARG_CHARS = 4_096;

/** Extensions each interpreter accepts, so a mismatch is caught before the run. */
const INTERPRETER_EXTENSIONS: Record<SandboxInterpreter, readonly string[]> = {
  python: [".py"],
  bash: [".sh", ".bash"],
  node: [".js", ".mjs", ".cjs"],
};

/**
 * Decides whether a run may proceed.
 *
 * Refusal order is the policy: capability before shape, so a deployment without a
 * container runtime says so rather than complaining about a file extension the
 * user cannot act on anyway.
 */
export function decideSandboxExecution(params: {
  request: SandboxExecutionRequest;
  capability: SandboxCapability;
  limits?: Partial<SandboxLimits>;
  /** Operator-configured network posture. Never model-selected. */
  network?: SandboxNetwork;
}): SandboxPolicyDecision {
  const { request, capability } = params;

  if (!capability.runtimeAvailable) {
    return {
      allow: false,
      reason: "no-runtime",
      detail:
        "No container runtime is available on this deployment, so scripts cannot be executed. " +
        "You can still write the script and explain to the user how to run it themselves.",
    };
  }
  if (!capability.enabledForDeployment) {
    return {
      allow: false,
      reason: "disabled-for-deployment",
      detail:
        "Code execution is disabled on this deployment. Write the script and describe what it does " +
        "instead of trying to run it.",
    };
  }
  if (!capability.enabledForAssistant) {
    return {
      allow: false,
      reason: "disabled-for-assistant",
      detail:
        "Code execution is not enabled for you. Your user can enable it in your settings. " +
        "Until then, write the script and explain it rather than running it.",
    };
  }
  if (!capability.assistantActive) {
    return {
      allow: false,
      reason: "assistant-inactive",
      detail: "You are suspended or archived and may not execute anything.",
    };
  }

  if (!isSandboxInterpreter(request.interpreter)) {
    return {
      allow: false,
      reason: "unsupported-interpreter",
      detail:
        `"${String(request.interpreter)}" is not an available interpreter. ` +
        `Use one of: ${SANDBOX_INTERPRETERS.join(", ")}.`,
    };
  }

  const pathCheck = checkScriptPath(request.scriptPath, request.interpreter);
  if (pathCheck !== undefined) {
    return { allow: false, reason: "invalid-script-path", detail: pathCheck };
  }

  const args = request.args ?? [];
  if (args.length > MAX_ARGS) {
    return {
      allow: false,
      reason: "too-many-arguments",
      detail:
        `A run takes at most ${MAX_ARGS} arguments; ${args.length} were given. ` +
        "Put the data in a file in your workspace and pass its path instead.",
    };
  }
  const oversized = args.find((arg) => arg.length > MAX_ARG_CHARS);
  if (oversized !== undefined) {
    return {
      allow: false,
      reason: "argument-too-long",
      detail:
        `One argument exceeds ${MAX_ARG_CHARS} characters. Write the value to a file in your ` +
        "workspace and pass the path instead of the value.",
    };
  }

  const limits: SandboxLimits = { ...DEFAULT_SANDBOX_LIMITS, ...params.limits };
  const network = params.network ?? "none";
  const requiresApproval = executionRequiresApproval(capability.autonomy, request.interpreter);

  return {
    allow: true,
    requiresApproval,
    ...(requiresApproval
      ? {
          approvalPrompt: buildApprovalPrompt({
            request,
            limits,
            network,
          }),
        }
      : {}),
    limits,
    network,
  };
}

/**
 * Whether a run needs a human decision.
 *
 * `supervised` always asks — that is what the word means, and it is the default so
 * that enabling code execution does not silently also grant unattended execution.
 */
export function executionRequiresApproval(
  autonomy: AssistantAutonomy,
  interpreter: SandboxInterpreter,
): boolean {
  if (autonomy === "supervised") return true;
  if (autonomy === "autonomous") return false;
  return !UNATTENDED_INTERPRETERS.has(interpreter);
}

/**
 * Validates the script path's shape.
 *
 * Only the shape: containment against the workspace root is proven separately by
 * `AssistantWorkspaceResolver.resolveInWorkspace`, which follows symlinks. Both
 * checks are needed — this one produces a useful message for the model, that one
 * is the actual boundary.
 */
function checkScriptPath(scriptPath: string, interpreter: SandboxInterpreter): string | undefined {
  const trimmed = scriptPath.trim();
  if (trimmed.length === 0) {
    return 'A script path is required, relative to your workspace (for example "scripts/report.py").';
  }
  if (trimmed.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return (
      `"${trimmed}" is an absolute path. Scripts must live in your workspace and be addressed ` +
      'relatively, for example "scripts/report.py".'
    );
  }
  // A lexical `..` rejection here is a courtesy so the model gets a clear message;
  // the resolver's realpath check is what actually prevents traversal.
  if (trimmed.split(/[\\/]/).includes("..")) {
    return `"${trimmed}" tries to leave your workspace. You can only run scripts inside it.`;
  }
  const extensions = INTERPRETER_EXTENSIONS[interpreter];
  if (!extensions.some((extension) => trimmed.toLowerCase().endsWith(extension))) {
    return (
      `"${trimmed}" does not look like a ${interpreter} script. ` +
      `Expected one of: ${extensions.join(", ")}.`
    );
  }
  return undefined;
}

/**
 * Renders the approval prompt.
 *
 * States the interpreter, the path, the argument count, and the posture the run
 * will have. It deliberately does NOT include the script body: an approval prompt
 * carrying a hundred lines of generated code is one nobody reads, and the reviewer
 * can open the file — it is in the workspace, under a path this prompt names.
 */
function buildApprovalPrompt(params: {
  request: SandboxExecutionRequest;
  limits: SandboxLimits;
  network: SandboxNetwork;
}): string {
  const args = params.request.args ?? [];
  const lines = [
    `Run ${params.request.interpreter} script: ${params.request.scriptPath}`,
    args.length > 0 ? `Arguments: ${args.length}` : "Arguments: none",
    `Network: ${params.network === "none" ? "disabled" : "egress allowed"}`,
    `Limits: ${params.limits.timeoutMs / 1000}s, ${params.limits.memoryMb} MB, ${params.limits.cpus} CPU`,
  ];
  const purpose = params.request.purpose?.trim();
  if (purpose) {
    lines.push(`Purpose: ${purpose.slice(0, 300)}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Output shaping
// ---------------------------------------------------------------------------

/** A run's captured output, already bounded. */
export interface SandboxOutput {
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/**
 * Bounds combined output, keeping the head and the tail.
 *
 * Both ends, because a script's useful information sits at both: the head has the
 * setup and the first error, the tail has the result and the traceback. Keeping
 * only the tail (the simpler choice) loses the first failure, which is usually the
 * one that explains the rest.
 */
export function boundSandboxOutput(params: {
  stdout: string;
  stderr: string;
  maxChars: number;
}): SandboxOutput {
  const budget = Math.max(200, params.maxChars);
  // stderr is favoured when both are large: a run that produced a lot of both is
  // usually failing, and the diagnosis is in stderr.
  const stderrBudget = Math.min(params.stderr.length, Math.floor(budget * 0.6));
  const stdoutBudget = budget - stderrBudget;
  const stdout = boundText(params.stdout, stdoutBudget);
  const stderr = boundText(params.stderr, stderrBudget);
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated,
  };
}

function boundText(text: string, budget: number): { text: string; truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false };
  if (budget <= 0) {
    return { text: "[output omitted: no budget remaining]", truncated: true };
  }
  const marker = "\n[... output truncated ...]\n";
  const half = Math.max(1, Math.floor((budget - marker.length) / 2));
  return {
    text: `${text.slice(0, half)}${marker}${text.slice(text.length - half)}`,
    truncated: true,
  };
}
