// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pipeline/isolate.ts
 *
 * Runs the native parsers (BPMN, XLSX, DOCX, VSDX, e-mail — the code that
 * inflates ZIP containers and parses hostile XML) in a Worker thread with a
 * heap ceiling, so a pathological document kills the parser, not the service
 * (requirement 5.2): the main thread keeps answering `/health` and lease
 * heartbeats while a parse runs.
 *
 * The task travels as a plain structured-cloneable object; the result is one
 * too (buffers arrive back as `Uint8Array`, which every consumer here is
 * typed for). An `ExtractError` thrown in the child is serialised by name and
 * revived on this side, so callers see the same typed error, status and
 * retryability as an in-process parse.
 *
 * Memory limit: `resourceLimits.maxOldGenerationSizeMb` is enforced by Node,
 * which is the production runtime (`node:26`, `dist-node`). Bun accepts the
 * option but ignores it (documented in its Node-compat notes), so local
 * development runs the same code path unenforced. When a Worker cannot even
 * start, the design's fallback applies: first `child_process.fork` with
 * `--max-old-space-size`, then — if that fails too — a direct in-process call
 * with a warning, because isolation is defense-in-depth and must not turn a
 * broken sandbox into an outage.
 */

import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { Logger } from "pino";
import {
  conversionFailed,
  documentTooComplex,
  ExtractError,
  type ExtractErrorCode,
} from "../errors.js";
import type {
  DocxHeadingHints,
  EmailRecords,
  EmbeddedSource,
  MboxRecords,
  NativeRecords,
  ParsedVsdx,
  ParsedXlsx,
  ZipLimits,
} from "./native/index.js";

export type { ExtractErrorCode };

/** One native parse to run off the main thread. Plain data only. */
export type IsolateTask =
  | { kind: "bpmn"; reference: string; buffer: Uint8Array }
  | { kind: "xlsx"; buffer: Uint8Array; limits: ZipLimits }
  | { kind: "docx-headings"; buffer: Uint8Array; limits: ZipLimits }
  | { kind: "docx-embeddings"; buffer: Uint8Array; limits: ZipLimits }
  | { kind: "vsdx"; buffer: Uint8Array; limits: ZipLimits }
  | { kind: "email"; buffer: Uint8Array; msgMaxEmbedDepth?: number }
  | { kind: "mbox-split"; buffer: Uint8Array }
  | { kind: "mbox-records"; messages: Uint8Array[] }
  | { kind: "zip-guard"; buffer: Uint8Array; limits: ZipLimits };

/** The result type each task kind produces. */
export interface IsolateTaskResults {
  bpmn: NativeRecords;
  xlsx: ParsedXlsx;
  "docx-headings": DocxHeadingHints;
  "docx-embeddings": { sources: EmbeddedSource[]; warnings: string[] };
  vsdx: ParsedVsdx;
  email: EmailRecords;
  "mbox-split": Uint8Array[];
  "mbox-records": MboxRecords;
  /** `assertZipWithinLimits` either throws or returns nothing (null on IPC). */
  "zip-guard": null;
}

/** An `ExtractError` flattened across the process boundary. */
export interface SerializedExtractError {
  __extractError: true;
  code: ExtractErrorCode;
  message: string;
  context: Record<string, unknown>;
}

/** Any other child-side failure, flattened to its message. */
export interface SerializedPlainError {
  __extractError: false;
  message: string;
}

/** The child's reply to one {@link IsolateTask}. */
export type IsolateResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: SerializedExtractError | SerializedPlainError };

/** Runs one task off-thread, or in-process when isolation is unavailable. */
export interface IsolatedRunner {
  run<K extends IsolateTask["kind"]>(
    task: Extract<IsolateTask, { kind: K }>,
    /** The same operation, executed directly when isolation is off/unavailable. */
    direct: () => IsolateTaskResults[K] | Promise<IsolateTaskResults[K]>,
  ): Promise<IsolateTaskResults[K]>;
}

export interface IsolatedRunnerOptions {
  /** PARSE_ISOLATED — false runs every parser in-process. */
  enabled: boolean;
  /** PARSE_MEMORY_LIMIT_MB — old-generation ceiling for the parser thread. */
  maxOldGenerationSizeMb: number;
  /** Wall-clock ceiling per isolated parse; 0 (default) disables it. */
  timeoutMs?: number;
  logger: Logger;
}

/** A runner that never isolates — the fallback and the disabled mode. */
export function createDirectIsolatedRunner(): IsolatedRunner {
  return {
    async run(_task, direct) {
      return direct();
    },
  };
}

/**
 * Create the isolated parser runner (requirement 5.2). One short-lived Worker
 * per task: parsers run once per document, so pooling would trade a clean
 * heap for a leaked one.
 */
export function createIsolatedRunner(options: IsolatedRunnerOptions): IsolatedRunner {
  const { enabled, maxOldGenerationSizeMb, logger } = options;
  const timeoutMs = options.timeoutMs ?? 0;
  if (!enabled) return createDirectIsolatedRunner();

  return {
    async run<K extends IsolateTask["kind"]>(
      task: Extract<IsolateTask, { kind: K }>,
      direct: () => IsolateTaskResults[K] | Promise<IsolateTaskResults[K]>,
    ): Promise<IsolateTaskResults[K]> {
      try {
        return await runIsolated<IsolateTaskResults[K]>(task, {
          maxOldGenerationSizeMb,
          timeoutMs,
        });
      } catch (error) {
        if (error instanceof IsolateUnavailableError) {
          logger.warn(
            { err: error, kind: task.kind },
            "isolated parser unavailable; parsing in-process (requirement 5.2 degraded)",
          );
          return direct();
        }
        throw error;
      }
    },
  };
}

/** The sandbox itself could not run (start/load failure) — fall back. */
class IsolateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsolateUnavailableError";
  }
}

interface RunOptions {
  maxOldGenerationSizeMb: number;
  timeoutMs: number;
}

/**
 * The Worker entry, found by probing the layouts this file can end up in:
 *
 * - checkout (`src/pipeline/isolate.ts`): the sibling `isolate-entry.ts`,
 *   which installs a resolve hook for the `./x.js` → `x.ts` rewrite itself;
 * - production bundle (`dist/index.js`, this module inlined at the root):
 *   the entry is the second build entry point under `pipeline/`.
 */
function resolveEntryUrl(): URL {
  const candidates = [
    "./pipeline/isolate-entry.js",
    "./isolate-entry.js",
    "./isolate-entry.ts",
  ];
  for (const candidate of candidates) {
    const url = new URL(candidate, import.meta.url);
    if (existsSync(fileURLToPath(url))) return url;
  }
  // Nothing found: let the Worker constructor fail; the caller degrades to
  // in-process parsing with a warning (requirement 5.2 degraded).
  return new URL("./isolate-entry.ts", import.meta.url);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deserializeError(
  error: SerializedExtractError | SerializedPlainError,
): Error {
  if (error.__extractError) {
    // status/retryable are recomputed by the class from the code.
    return new ExtractError(error.code, error.message, error.context);
  }
  return new Error(error.message);
}

async function runIsolated<T>(task: IsolateTask, opts: RunOptions): Promise<T> {
  try {
    return await runInWorker<T>(task, opts);
  } catch (error) {
    if (!(error instanceof IsolateUnavailableError)) throw error;
    // Design fallback: child_process.fork under Node, with the heap ceiling
    // as a V8 flag. If that cannot start either, the runner goes direct.
    try {
      return await runInFork<T>(task, opts);
    } catch (forkError) {
      if (forkError instanceof IsolateUnavailableError) {
        throw new IsolateUnavailableError(
          `worker: ${messageOf(error)}; fork: ${messageOf(forkError)}`,
        );
      }
      throw forkError;
    }
  }
}

function runInWorker<T>(task: IsolateTask, opts: RunOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(resolveEntryUrl(), {
        resourceLimits: { maxOldGenerationSizeMb: opts.maxOldGenerationSizeMb },
      });
    } catch (error) {
      reject(new IsolateUnavailableError(messageOf(error)));
      return;
    }
    let settled = false;
    let responded = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      fn();
      void worker.terminate().catch(() => undefined);
    };
    worker.on("message", (response: IsolateResponse) => {
      responded = true;
      finish(() => {
        if (response.ok) resolve(response.result as T);
        else reject(deserializeError(response.error));
      });
    });
    worker.on("error", (error: { code?: string }) => {
      finish(() => {
        if (error.code === "ERR_WORKER_OUT_OF_MEMORY") {
          reject(
            documentTooComplex(
              `The isolated parser exceeded its ${String(opts.maxOldGenerationSizeMb)} MB memory limit (PARSE_MEMORY_LIMIT_MB)`,
              { kind: task.kind },
            ),
          );
        } else if (!responded) {
          // Failed before answering: a load/start failure, not a parse failure.
          reject(new IsolateUnavailableError(messageOf(error)));
        } else {
          reject(
            conversionFailed(`The isolated ${task.kind} parser failed`, {
              kind: task.kind,
              detail: messageOf(error),
            }),
          );
        }
      });
    });
    worker.on("exit", (code) => {
      finish(() => {
        reject(
          conversionFailed(
            `The isolated ${task.kind} parser exited (code ${String(code)}) without a result`,
            { kind: task.kind, exitCode: code },
          ),
        );
      });
    });
    if (opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        finish(() => {
          reject(
            conversionFailed(
              `The isolated ${task.kind} parser timed out after ${String(opts.timeoutMs)} ms`,
              { kind: task.kind },
            ),
          );
        });
      }, opts.timeoutMs);
      timer.unref();
    }
    worker.postMessage(task);
  });
}

function runInFork<T>(task: IsolateTask, opts: RunOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = fork(fileURLToPath(resolveEntryUrl()), {
        // Advanced serialization carries the Uint8Array payloads; the
        // default JSON channel would not.
        serialization: "advanced",
        execArgv: [`--max-old-space-size=${String(opts.maxOldGenerationSizeMb)}`],
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
    } catch (error) {
      reject(new IsolateUnavailableError(messageOf(error)));
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      fn();
      child.kill();
    };
    child.on("message", (response: IsolateResponse) => {
      finish(() => {
        if (response.ok) resolve(response.result as T);
        else reject(deserializeError(response.error));
      });
    });
    child.on("error", (error) => {
      finish(() => {
        reject(new IsolateUnavailableError(messageOf(error)));
      });
    });
    child.on("exit", (code) => {
      finish(() => {
        reject(
          conversionFailed(
            `The forked ${task.kind} parser exited (code ${String(code)}) without a result`,
            { kind: task.kind, exitCode: code },
          ),
        );
      });
    });
    if (opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        finish(() => {
          reject(
            conversionFailed(
              `The forked ${task.kind} parser timed out after ${String(opts.timeoutMs)} ms`,
              { kind: task.kind },
            ),
          );
        });
      }, opts.timeoutMs);
      timer.unref();
    }
    try {
      child.send(task);
    } catch (error) {
      finish(() => {
        reject(new IsolateUnavailableError(messageOf(error)));
      });
    }
  });
}
