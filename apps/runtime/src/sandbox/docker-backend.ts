// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Container-backed script execution (`src/sandbox/docker-backend.ts`)
 *
 * Runs one script in one throw-away container with only the assistant's own
 * workspace mounted.
 *
 * ## Ephemeral, not warm
 *
 * A fresh container per run, `--rm`. A long-lived per-assistant container would
 * save a second of startup and buy a much worse property: state left behind by one
 * run is visible to the next, so a script can plant something for a later run to
 * pick up, and a crashed run leaves a container that must be reaped. Correctness
 * over latency here — and the latency is paid in a background analysis step, not in
 * a user-visible reply.
 *
 * ## The hardening flags, and what each one is for
 *
 * Every flag below closes a specific hole. They are listed in
 * {@link buildContainerArgs} with the reason inline, because a flag whose purpose
 * is not recorded is a flag someone removes during a debugging session.
 *
 * ## What this does not do
 *
 * No image building, no dependency installation, no package manager access. The
 * image is operator-supplied and fixed. An assistant that could install packages
 * could install anything, and the network is off precisely so it cannot.
 *
 * No `any` at module boundaries.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import type { Logger } from "../observability/logger.js";
import {
  boundSandboxOutput,
  type SandboxInterpreter,
  type SandboxLimits,
  type SandboxNetwork,
} from "./policy.js";

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** How a run ended. */
export type SandboxRunStatus =
  | "completed"
  | "failed"
  | "timeout"
  | "out-of-memory"
  | "runtime-error";

export interface SandboxRunResult {
  status: SandboxRunStatus;
  /** Process exit code, when the container produced one. */
  exitCode?: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  /**
   * Model-facing summary. Written here rather than at the call site so a failure
   * mode always arrives with an explanation of what to try next.
   */
  summary: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SandboxBackendConfig {
  /**
   * Container binary. `docker` or `podman`; both accept the flags used here.
   */
  binary: string;
  /**
   * Image to run. Operator-supplied and fixed — never model-selected, since an
   * arbitrary image is an arbitrary program.
   */
  image: string;
  /**
   * User inside the container, as `uid:gid`. Non-root so a container escape does
   * not start from root, and so files written into the mounted workspace are owned
   * by an unprivileged id.
   */
  user?: string;
  /** Mount point of the workspace inside the container. */
  workdir?: string;
  logger?: Logger;
}

const DEFAULT_WORKDIR = "/workspace";
const DEFAULT_USER = "1000:1000";

/**
 * Interpreter binaries, resolved by name inside the container.
 *
 * A fixed map rather than a passed-through command: the model names an interpreter
 * from a closed set (see `policy.ts`) and this translates it. There is no path by
 * which model output becomes the executable.
 */
const INTERPRETER_BINARIES: Record<SandboxInterpreter, string> = {
  python: "python3",
  bash: "bash",
  node: "node",
};

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export interface SandboxRunRequest {
  /** Canonical host path of the workspace to mount. */
  workspacePath: string;
  /** Script path, relative to the workspace root, already validated. */
  relativeScriptPath: string;
  interpreter: SandboxInterpreter;
  args: readonly string[];
  limits: SandboxLimits;
  network: SandboxNetwork;
  /** Cancels the run — composed with the flow deadline by the caller. */
  signal?: AbortSignal;
}

/** Executes scripts in throw-away containers. */
export class ContainerSandboxBackend {
  private readonly workdir: string;
  private readonly user: string;

  constructor(private readonly config: SandboxBackendConfig) {
    this.workdir = config.workdir ?? DEFAULT_WORKDIR;
    this.user = config.user ?? DEFAULT_USER;
  }

  /**
   * Probes whether the container runtime is usable.
   *
   * Called once at startup, not per run: a per-run probe would double the process
   * spawns and the answer does not change while the process lives.
   */
  async probe(): Promise<boolean> {
    try {
      const result = await this.spawnProcess(
        this.config.binary,
        ["version", "--format", "{{.Server.Version}}"],
        5_000,
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const startedAt = Date.now();
    const args = this.buildContainerArgs(request);

    this.config.logger?.debug("Sandbox run starting", {
      interpreter: request.interpreter,
      script: request.relativeScriptPath,
      network: request.network,
    });

    let raw: SpawnOutcome;
    try {
      raw = await this.spawnProcess(
        this.config.binary,
        args,
        request.limits.timeoutMs,
        request.signal,
      );
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      return {
        status: "runtime-error",
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        truncated: false,
        durationMs,
        summary:
          "The container runtime could not start the script. This is an infrastructure problem, " +
          "not a problem with your script. Report it to the user rather than retrying.",
      };
    }

    const durationMs = Date.now() - startedAt;
    const bounded = boundSandboxOutput({
      stdout: raw.stdout,
      stderr: raw.stderr,
      maxChars: request.limits.maxOutputChars,
    });
    const status = classifyOutcome(raw, request.limits);

    return {
      status,
      ...(raw.exitCode !== undefined ? { exitCode: raw.exitCode } : {}),
      stdout: bounded.stdout,
      stderr: bounded.stderr,
      truncated: bounded.truncated,
      durationMs,
      summary: summarize(status, raw.exitCode, request.limits, bounded.truncated),
    };
  }

  /**
   * Builds the container argument vector.
   *
   * Each flag carries the reason it exists. They are not interchangeable defaults:
   * removing any one of them re-opens a specific hole, and the next person to debug
   * a failing script will be tempted to remove exactly the one that matters.
   */
  private buildContainerArgs(request: SandboxRunRequest): string[] {
    const scriptInContainer = path.posix.join(
      this.workdir,
      // Normalise separators so a Windows-authored relative path still addresses
      // the POSIX mount point correctly.
      request.relativeScriptPath.split(path.sep).join("/"),
    );

    return [
      "run",
      // Never leave a container behind. A reaper for orphaned containers would be a
      // second system to keep correct.
      "--rm",
      // No TTY, no stdin. The script cannot prompt, so it cannot hang waiting for
      // input that will never arrive — a wedged container that only the timeout
      // resolves.
      "--interactive=false",
      // Unprivileged. A container escape should not begin as root, and files
      // written into the mounted workspace get an unprivileged owner.
      "--user",
      this.user,
      // No new privileges: blocks setuid binaries inside the image from elevating.
      "--security-opt",
      "no-new-privileges",
      // Drop every Linux capability. A script needs none of them; leaving even
      // CAP_NET_RAW or CAP_CHOWN available is gratuitous attack surface.
      "--cap-drop",
      "ALL",
      // Read-only root filesystem. The image cannot be modified, so nothing can be
      // planted for a later run and no package manager can write.
      "--read-only",
      // A writable /tmp is still needed (interpreters use it), so it is a bounded
      // tmpfs — in memory, size-capped, gone when the container exits. `noexec`
      // stops a script from writing a binary there and running it.
      "--tmpfs",
      `/tmp:rw,noexec,nosuid,size=${request.limits.tmpfsMb}m`,
      // Network off by default. This is the single most important flag: a script
      // with network access can exfiltrate the workspace it was given to analyse.
      "--network",
      request.network === "none" ? "none" : "bridge",
      // Memory ceiling. Without it one script can push the host into swap or OOM.
      "--memory",
      `${request.limits.memoryMb}m`,
      // Disable swap by matching the swap limit to the memory limit: a script that
      // exceeds memory should fail fast, not degrade the host by swapping.
      "--memory-swap",
      `${request.limits.memoryMb}m`,
      "--cpus",
      String(request.limits.cpus),
      // Process ceiling, so a fork bomb hits a limit rather than the host's PID
      // space.
      "--pids-limit",
      String(request.limits.pids),
      // Only this assistant's workspace is visible, and it is the only writable
      // path. The isolation boundary of the whole feature is this one mount.
      "--volume",
      `${request.workspacePath}:${this.workdir}:rw`,
      "--workdir",
      this.workdir,
      // An empty environment. Inheriting the host environment would hand the
      // script every secret the server process holds.
      "--env",
      "HOME=/tmp",
      "--env",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      // Interpreters buffer stdout when it is not a TTY; unbuffered output means a
      // timeout still yields the output produced so far instead of nothing.
      "--env",
      "PYTHONUNBUFFERED=1",
      // No writes to __pycache__ in the (read-only) image, and no stray files in
      // the mounted workspace.
      "--env",
      "PYTHONDONTWRITEBYTECODE=1",
      this.config.image,
      INTERPRETER_BINARIES[request.interpreter],
      scriptInContainer,
      // Arguments are separate argv entries, never concatenated into a shell
      // string, so quoting and injection do not arise.
      ...request.args,
    ];
  }

  /**
   * Spawns a process with a hard timeout and no shell.
   *
   * `shell: false` (the default, stated explicitly by not passing `shell`) is
   * essential: with a shell, every argument becomes shell-parsed and the careful
   * argv construction above would be undone.
   */
  private spawnProcess(
    binary: string,
    args: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SpawnOutcome> {
    return new Promise<SpawnOutcome>((resolve, reject) => {
      const child = spawn(binary, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      // Output is accumulated in memory but the container's own limits bound how
      // much it can produce; the caller truncates for the model afterwards. A hard
      // in-process cap here would risk cutting a diagnosis mid-line.
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      const timer = setTimeout(() => {
        timedOut = true;
        // SIGKILL, not SIGTERM: the container runtime forwards a stop request, and
        // a script that ignores termination is exactly the case the timeout exists
        // for. `--rm` still reaps the container.
        child.kill("SIGKILL");
      }, timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();

      const onAbort = (): void => {
        child.kill("SIGKILL");
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const finish = (outcome: SpawnOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      });

      child.on("close", (code, killSignal) => {
        finish({
          exitCode: code ?? undefined,
          signal: killSignal ?? undefined,
          stdout,
          stderr,
          timedOut,
        });
      });
    });
  }
}

interface SpawnOutcome {
  exitCode?: number;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Classifies how a run ended.
 *
 * Exit code 137 is the container-runtime convention for SIGKILL, which covers both
 * our timeout kill and the kernel's OOM killer. They are distinguished by whether
 * our timer fired, because the two need different advice: shorten the work versus
 * process less data at once.
 */
function classifyOutcome(outcome: SpawnOutcome, _limits: SandboxLimits): SandboxRunStatus {
  if (outcome.timedOut) return "timeout";
  if (outcome.exitCode === 0) return "completed";
  if (outcome.exitCode === 137 || outcome.signal === "SIGKILL") {
    return "out-of-memory";
  }
  // 125 = the runtime itself failed (bad flag, missing image); 126/127 = the
  // command could not be executed or was not found. All three are infrastructure
  // faults rather than script faults, and telling the model to fix its script
  // would send it in circles.
  if (outcome.exitCode === 125 || outcome.exitCode === 126 || outcome.exitCode === 127) {
    return "runtime-error";
  }
  return "failed";
}

/** Builds the model-facing summary for a run outcome. */
function summarize(
  status: SandboxRunStatus,
  exitCode: number | undefined,
  limits: SandboxLimits,
  truncated: boolean,
): string {
  const truncationNote = truncated
    ? " Output was truncated; the middle is missing, so do not assume the omitted part was empty."
    : "";
  switch (status) {
    case "completed":
      return `The script completed successfully.${truncationNote}`;
    case "failed":
      return (
        `The script exited with code ${exitCode ?? "unknown"}. Read stderr for the cause, fix the ` +
        `script, and run it again.${truncationNote}`
      );
    case "timeout":
      return (
        `The script was stopped after ${limits.timeoutMs / 1000} seconds. Any output above is what it ` +
        "produced before being stopped. Split the work into smaller steps or process less data per run." +
        truncationNote
      );
    case "out-of-memory":
      return (
        `The script was killed, most likely for exceeding the ${limits.memoryMb} MB memory limit. ` +
        "Process the data in chunks instead of loading it all at once." +
        truncationNote
      );
    case "runtime-error":
      return (
        "The container runtime could not run the script (bad image, missing interpreter, or a " +
        "runtime fault). This is an infrastructure problem, not a problem with your script: report " +
        "it to the user instead of rewriting the script."
      );
  }
}
