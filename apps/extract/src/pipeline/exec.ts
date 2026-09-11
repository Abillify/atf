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
 */

import { execFile } from "node:child_process";
import { converterUnavailable, conversionFailed } from "../errors.js";

export interface RunOptions {
  /** Kill the process after this many ms. 0 disables. */
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
 * Run a converter binary.
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
  const { timeoutMs = 0, maxBuffer = 64 * 1024 * 1024 } = options;

  return new Promise<RunResult>((resolve, reject) => {
    const child = execFile(
      command,
      [...args],
      {
        env: buildEnv(home, options.env),
        maxBuffer,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(timeoutMs > 0 ? { timeout: timeoutMs, killSignal: "SIGKILL" as const } : {}),
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
