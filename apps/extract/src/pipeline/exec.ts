// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * exec.ts
 *
 * Running external converter binaries.
 *
 * `execFile`, never `exec`: arguments are passed as an array so a filename
 * containing a space, a quote or a `;` cannot become shell syntax. Uploaded
 * filenames are attacker-controlled, and this is the single place where they
 * reach a process boundary.
 *
 * Two failure modes are separated because they need opposite responses:
 *
 *   ENOENT           → the binary is not in the image. Permanent; an operator
 *                      must fix the Dockerfile. Retrying is pointless.
 *   non-zero exit    → the binary ran and rejected the input, or crashed.
 *                      Often transient (LibreOffice is not reliable under
 *                      concurrency) and worth retrying.
 *
 * Collapsing both into one error is how "poppler-utils is missing" gets
 * misdiagnosed as "this PDF is corrupt" for an afternoon.
 *
 * Where the binaries *execute* is a second axis (requirement 5.7). By default
 * they are children of this process; with `CONVERTER_MODE=isolated` every call
 * is forwarded over a Unix socket to the `extract-converter` sidecar, which
 * runs them behind `network_mode: none`, a read-only root filesystem and the
 * default seccomp profile. Both paths produce the same error taxonomy, so
 * nothing upstream of `run()` knows or cares which one was used — that is the
 * property that makes the isolation switchable per deployment instead of a
 * fork in the pipeline.
 */

import { execFile, spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import {
  ExtractError,
  converterUnavailable,
  conversionFailed,
  isExtractErrorCode,
} from "../errors.js";
import {
  encodeFrame,
  FrameDecoder,
  type ConverterRequest,
  type ConverterResponse,
} from "../converter/protocol.js";

/**
 * Wall-clock ceiling applied when a caller omits `timeoutMs` (requirement 5.5).
 * A hung converter would otherwise hold its `PAGE_CONCURRENCY` slot — and the
 * job behind it — indefinitely. Callers pass `SUBPROCESS_TIMEOUT_MS`
 * explicitly; a `0` there is a deliberate, development-only disable that the
 * production-readiness gate refuses to boot with.
 */
export const DEFAULT_SUBPROCESS_TIMEOUT_MS = 120_000;

/**
 * Kernel-level ceilings applied to every converter subprocess via `prlimit`
 * (requirement 5.5). Both apply only on Linux and only when the `prlimit`
 * binary (part of util-linux) is present; elsewhere the container's cgroup
 * limits are the enforcement mechanism and these are inert.
 */
export interface SubprocessLimits {
  /**
   * `prlimit --as`: virtual address-space ceiling in MB. 0 disables.
   *
   * `--as` caps *virtual* mappings, which LibreOffice reserves generously, so
   * in a container the cgroup memory limit is the preferred ceiling (the "or
   * cgroup" branch of requirement 5.5); set this on bare-metal Linux where no
   * cgroup applies.
   */
  memoryLimitMb: number;
  /**
   * `prlimit --cpu`: CPU-second ceiling, SIGKILL on breach. 0 disables.
   * Caps cumulative CPU across all of the converter's threads; the wall-clock
   * bound remains {@link DEFAULT_SUBPROCESS_TIMEOUT_MS}.
   */
  cpuLimitSeconds: number;
}

let subprocessLimits: SubprocessLimits = { memoryLimitMb: 0, cpuLimitSeconds: 0 };

/**
 * Configure the `prlimit` wrapper. Called once at startup from the config;
 * the default (both 0) leaves subprocesses unwrapped.
 */
export function configureSubprocessLimits(limits: SubprocessLimits): void {
  subprocessLimits = {
    memoryLimitMb: limits.memoryLimitMb,
    cpuLimitSeconds: limits.cpuLimitSeconds,
  };
}

/**
 * Where {@link run} executes converter binaries (CONVERTER_MODE, requirement
 * 5.7). `isolated` forwards every call to the converter sidecar over
 * {@link ConverterTransport.socketPath}.
 */
export interface ConverterTransport {
  mode: "local" | "isolated";
  socketPath: string;
}

let converterTransport: ConverterTransport = {
  mode: "local",
  socketPath: "",
};

/**
 * Switch between in-container spawning and the isolated converter. Called once
 * at startup from the config, like {@link configureSubprocessLimits}: the test
 * harness, which builds apps directly, keeps the `local` default.
 */
export function configureConverterTransport(
  transport: ConverterTransport,
): void {
  converterTransport = {
    mode: transport.mode,
    socketPath: transport.socketPath,
  };
}

/** Current transport. Exported for tests and the startup log. */
export function getConverterTransport(): Readonly<ConverterTransport> {
  return converterTransport;
}

/**
 * Slack added to the converter's own wall-clock ceiling before the client
 * gives up on the socket. The sidecar enforces `timeoutMs` on the binary; this
 * only catches a sidecar that is wedged, unresponsive, or gone — where waiting
 * forever would hold a `PAGE_CONCURRENCY` slot for the life of the process.
 */
const CONVERTER_RPC_GRACE_MS = 15_000;

/**
 * Run a converter binary in the isolated converter container.
 *
 * One connection per call: conversions run for seconds to minutes, so pooling
 * would pin a socket for the whole document and complicate cancellation for no
 * measurable gain — connecting to a Unix socket is a microsecond-scale syscall
 * next to a LibreOffice start.
 *
 * The request carries paths, not bytes: `home` and the paths inside `args` are
 * resolved by the converter, which mounts the same scratch volume at the same
 * location. See the compose contract in the deployment configuration.
 */
async function runIsolated(
  command: string,
  args: readonly string[],
  home: string,
  options: RunOptions,
  timeoutMs: number,
  maxBuffer: number,
): Promise<RunResult> {
  const { socketPath } = converterTransport;
  const request: ConverterRequest = {
    id: 1,
    command,
    args: [...args],
    home,
    timeoutMs,
    maxBuffer,
  };

  return new Promise<RunResult>((resolve, reject) => {
    const socket: Socket = connect({ path: socketPath });
    socket.setNoDelay(true);
    const decoder = new FrameDecoder(maxBuffer + 64 * 1024);
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      options.signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      fn();
    };
    const fail = (error: unknown): void => finish(() => reject(error));
    const succeed = (result: RunResult): void => finish(() => resolve(result));

    function onAbort(): void {
      // The converter cannot observe this abort — it has no idea which request
      // belongs to which caller beyond the id — so the sidecar's own timeout
      // reaps the binary. Killing the connection at least stops us waiting for
      // output nobody reads.
      fail(conversionFailed(`"${command}" was aborted`, { command }));
    }

    if (timeoutMs > 0) {
      deadline = setTimeout(() => {
        fail(
          conversionFailed(
            `the isolated converter did not answer within ${timeoutMs + CONVERTER_RPC_GRACE_MS} ms`,
            { command, socketPath },
          ),
        );
      }, timeoutMs + CONVERTER_RPC_GRACE_MS);
      deadline.unref();
    }
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    socket.on("error", (err: NodeJS.ErrnoException) => {
      // A missing or refusing socket means the sidecar is not there — the same
      // operator action as a binary missing from the image, hence the same
      // code: fix the deployment, do not retry the document.
      if (
        err.code === "ENOENT" ||
        err.code === "ECONNREFUSED" ||
        err.code === "EACCES"
      ) {
        fail(
          converterUnavailable(
            `the isolated converter is not reachable on ${socketPath} (${err.code}). ` +
              "Start the extract-converter container, or set CONVERTER_MODE=local.",
            { command, socketPath, errno: err.code },
          ),
        );
        return;
      }
      fail(
        conversionFailed(`the converter socket failed: ${err.message}`, {
          command,
        }),
      );
    });

    socket.on("end", () => {
      fail(
        conversionFailed(
          `the converter closed the connection before answering ("${command}")`,
          { command },
        ),
      );
    });

    socket.on("data", (chunk: Buffer) => {
      let frames: string[];
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        fail(err);
        return;
      }
      for (const frame of frames) {
        let response: ConverterResponse;
        try {
          response = JSON.parse(frame) as ConverterResponse;
        } catch {
          fail(
            conversionFailed("the converter sent a malformed response", {
              command,
            }),
          );
          return;
        }
        if (response.id !== request.id) continue;
        if (response.ok === true) {
          succeed({ stdout: response.stdout, stderr: response.stderr });
          return;
        }
        const error = response.error;
        // The code crosses a container boundary, so it is validated before it
        // is trusted; an unknown code degrades to CONVERSION_FAILED rather
        // than becoming an arbitrary status.
        if (error?.__extractError === true && isExtractErrorCode(error.code)) {
          fail(new ExtractError(error.code, error.message, { command }));
          return;
        }
        fail(
          conversionFailed(
            `"${command}" failed in the converter: ${error?.message ?? "unknown error"}`,
            { command },
          ),
        );
        return;
      }
    });

    socket.write(encodeFrame(request));
  });
}

/**
 * Open the converter socket once and report whether it accepts a connection.
 *
 * Used by the converter container's own readiness check and by `/health` in
 * isolated mode, where a sidecar that never started must surface as unhealthy
 * at startup rather than as a failed conversion later.
 */
export function probeConverterSocket(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ path: socketPath });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 5_000);
    timer.unref();
    socket.once("connect", () => {
      clearTimeout(timer);
      done(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

/** Cached availability of the `prlimit` binary; probed at most once. */
let prlimitAvailable: Promise<boolean> | undefined;

function hasPrlimit(): Promise<boolean> {
  if (process.platform !== "linux") return Promise.resolve(false);
  prlimitAvailable ??= new Promise<boolean>((resolve) => {
    const probeChild = spawn("prlimit", ["--version"], { stdio: "ignore" });
    probeChild.on("error", () => resolve(false));
    probeChild.on("exit", (code) => resolve(code === 0));
  });
  return prlimitAvailable;
}

/**
 * Wrap a command in `prlimit` so the kernel enforces the configured ceilings
 * on the converter itself. `prlimit` execs the command in place, so the
 * limits are the converter's own and its children inherit them as a ceiling.
 * Exported for tests; {@link run} decides whether to apply it.
 */
export function prlimitInvocation(
  command: string,
  args: readonly string[],
  limits: SubprocessLimits,
): { command: string; args: readonly string[] } {
  const prArgs: string[] = [];
  if (limits.memoryLimitMb > 0)
    prArgs.push(`--as=${limits.memoryLimitMb * 1024 * 1024}`);
  if (limits.cpuLimitSeconds > 0)
    prArgs.push(`--cpu=${limits.cpuLimitSeconds}`);
  if (prArgs.length === 0) return { command, args };
  return { command: "prlimit", args: [...prArgs, command, ...args] };
}

export interface RunOptions {
  /**
   * Kill the process after this many ms. 0 disables (development only — the
   * production-readiness gate rejects it). Defaults to
   * {@link DEFAULT_SUBPROCESS_TIMEOUT_MS} when omitted.
   */
  timeoutMs?: number;
  /** Extra environment entries. Merged over a minimal inherited environment. */
  env?: Record<string, string>;
  /** Working directory. */
  cwd?: string;
  /** Cap on captured stdout/stderr. Defaults to 64 MiB for pdftotext output. */
  maxBuffer?: number;
  /** Abort the process when this signal fires (client disconnect). */
  signal?: AbortSignal;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * Environment handed to converter binaries.
 *
 * Deliberately minimal rather than `process.env`: the service's own secrets
 * (`API_TOKEN`, `VISION_API_KEY`, `SEARCH_TOKEN`, `OIDC_CLIENT_SECRET`) have no
 * business being visible to a document parser, and a parser that can be made to
 * execute a macro or read its environment should find nothing there.
 *
 * `HOME` is required: LibreOffice refuses to start without a writable one, and
 * poppler reads font configuration from it.
 */
function buildEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: home,
    TMPDIR: home,
    LANG: process.env["LANG"] ?? "C.UTF-8",
    LC_ALL: process.env["LC_ALL"] ?? "C.UTF-8",
    ...extra,
  };
}

/**
 * Run a converter binary, choosing the execution site by transport mode.
 *
 * @param command  Absolute path or a name resolved via PATH.
 * @param args     Passed as an array; never interpolated into a shell.
 * @param home     Writable directory used as HOME and TMPDIR.
 */
export async function run(
  command: string,
  args: readonly string[],
  home: string,
  options: RunOptions = {},
): Promise<RunResult> {
  // Requirement 5.7: the binaries may live in another container. The prlimit
  // configuration travels with the call in spirit — the sidecar applies its
  // own SUBPROCESS_* settings when it executes, so the ceilings are enforced
  // where the process actually runs.
  if (converterTransport.mode === "isolated") {
    const {
      timeoutMs = DEFAULT_SUBPROCESS_TIMEOUT_MS,
      maxBuffer = 64 * 1024 * 1024,
    } = options;
    return runIsolated(command, args, home, options, timeoutMs, maxBuffer);
  }
  return runLocal(command, args, home, options);
}

/**
 * The in-container spawn path.
 *
 * Exported for the converter server, which must always execute locally: a
 * sidecar that routed a forwarded call back through {@link run} would loop
 * when its own `CONVERTER_MODE` were misconfigured to `isolated`.
 */
export async function runLocal(
  command: string,
  args: readonly string[],
  home: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const {
    timeoutMs = DEFAULT_SUBPROCESS_TIMEOUT_MS,
    maxBuffer = 64 * 1024 * 1024,
  } = options;

  // Requirement 5.5: kernel-enforced memory/CPU ceilings where the platform
  // provides them. The availability probe keeps a missing `prlimit` from
  // surfacing as a confusing ENOENT for the *real* converter.
  let invocation = { command, args };
  if (
    process.platform === "linux" &&
    (subprocessLimits.memoryLimitMb > 0 ||
      subprocessLimits.cpuLimitSeconds > 0) &&
    (await hasPrlimit())
  ) {
    invocation = prlimitInvocation(command, args, subprocessLimits);
  }

  return new Promise<RunResult>((resolve, reject) => {
    const child = execFile(
      invocation.command,
      [...invocation.args],
      {
        env: buildEnv(home, options.env),
        maxBuffer,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(timeoutMs > 0
          ? { timeout: timeoutMs, killSignal: "SIGKILL" as const }
          : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          reject(
            converterUnavailable(
              `Converter binary "${command}" is not installed in this image`,
              { command },
            ),
          );
          return;
        }
        // When wrapped, a missing converter surfaces through `prlimit`'s exit
        // rather than ENOENT: it reports the exec failure on stderr. Without
        // this, "poppler-utils is missing" would be misdiagnosed as "this
        // document failed to convert" — the exact confusion this file exists
        // to prevent.
        if (
          invocation.command === "prlimit" &&
          /no such file or directory/i.test(stderr)
        ) {
          reject(
            converterUnavailable(
              `Converter binary "${command}" is not installed in this image`,
              { command },
            ),
          );
          return;
        }
        if (code === "ABORT_ERR" || options.signal?.aborted === true) {
          reject(conversionFailed(`"${command}" was aborted`, { command }));
          return;
        }
        // stderr is kept in the error context for the log, never returned to the
        // client: it contains absolute temporary paths.
        reject(
          conversionFailed(`"${command}" failed: ${error.message}`, {
            command,
            args,
            exitCode: (error as NodeJS.ErrnoException & { code?: number }).code,
            stderr: stderr.slice(0, 4000),
          }),
        );
      },
    );
    // Nothing is ever written to a converter's stdin; closing it prevents a
    // binary that decides to prompt from hanging until the timeout.
    child.stdin?.end();
  });
}

/**
 * Probe whether a binary is present and runnable.
 *
 * Used by `/health` so a missing `poppler-utils` surfaces as an unhealthy
 * container at startup rather than as a failed conversion an hour later.
 */
export async function probe(
  command: string,
  args: readonly string[],
  home: string,
): Promise<{ available: boolean; version?: string; error?: string }> {
  try {
    const { stdout, stderr } = await run(command, args, home, { timeoutMs: 10_000 });
    // poppler tools print their version banner on stderr.
    const banner = (stdout.trim() || stderr.trim()).split("\n")[0]?.trim();
    return { available: true, ...(banner !== undefined && banner !== "" ? { version: banner } : {}) };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
