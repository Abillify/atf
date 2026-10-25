// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pipeline/isolate-entry.ts
 *
 * The child side of `isolate.ts`: it receives one parse task
 * over the Worker/fork channel, runs it against the native parsers, and posts
 * the structured-cloneable result back. An `ExtractError` is serialised by
 * name — `instanceof` does not survive the process boundary — and revived by
 * the parent, so the caller sees the same typed error either way.
 *
 * Loading: in a source checkout under Node, the entry is the `.ts` file
 * itself. Its *static* imports are therefore only `node:` builtins; the
 * native modules are imported dynamically, after a `node:module` resolve hook
 * maps relative `./x.js` specifiers onto the existing `.ts` sources (Node
 * strips the types natively). Bun resolves `./x.js` → `x.ts` in workers on
 * its own and has no `registerHooks`, hence the guard. In the production
 * bundle this file is compiled to `pipeline/isolate-entry.js` with everything
 * inlined, and the hook is a no-op.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parentPort } from "node:worker_threads";
import type {
  ExtractErrorCode,
  IsolateResponse,
  IsolateTask,
  SerializedExtractError,
  SerializedPlainError,
} from "./isolate.js";

type ResolveHookContext = { parentURL?: string };
type ResolveResult = { url: string; shortCircuit?: boolean };
type RegisterHooks = (hooks: {
  resolve: (
    specifier: string,
    context: ResolveHookContext,
    nextResolve: (
      specifier: string,
      context: ResolveHookContext,
    ) => ResolveResult | Promise<ResolveResult>,
  ) => ResolveResult | Promise<ResolveResult>;
}) => void;

try {
  const moduleNamespace = await import("node:module");
  const registerHooks = (moduleNamespace as unknown as { registerHooks?: RegisterHooks })
    .registerHooks;
  if (typeof registerHooks === "function") {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (
          specifier.startsWith(".") &&
          specifier.endsWith(".js") &&
          context.parentURL?.startsWith("file:")
        ) {
          const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
          if (existsSync(fileURLToPath(candidate))) {
            return { url: candidate.href, shortCircuit: true };
          }
        }
        return nextResolve(specifier, context);
      },
    });
  }
} catch {
  // Bun: no registerHooks, and none needed — it resolves ./x.js → x.ts itself.
}

const native = await import("./native/index.js");

function serializeError(
  error: unknown,
): SerializedExtractError | SerializedPlainError {
  if (error instanceof Error && error.name === "ExtractError") {
    const shaped = error as unknown as {
      code: ExtractErrorCode;
      context: Record<string, unknown>;
    };
    return {
      __extractError: true,
      code: shaped.code,
      message: error.message,
      context: shaped.context,
    };
  }
  return {
    __extractError: false,
    message: error instanceof Error ? error.message : String(error),
  };
}

async function dispatch(task: IsolateTask): Promise<unknown> {
  switch (task.kind) {
    case "bpmn":
      return native.buildBpmnRecords(task.reference, task.buffer);
    case "xlsx":
      return native.readXlsx(task.buffer, task.limits);
    case "docx-headings":
      return native.buildDocxHeadingHints(task.buffer, task.limits);
    case "docx-embeddings":
      return native.extractDocxEmbeddings(task.buffer, task.limits);
    case "vsdx":
      return native.parseVsdx(task.buffer, task.limits);
    case "email":
      return task.msgMaxEmbedDepth !== undefined
        ? native.buildEmailRecords(task.buffer, native.parseMsg(task.buffer, task.msgMaxEmbedDepth))
        : native.buildEmailRecords(task.buffer);
    case "mbox-split":
      return native.splitMbox(task.buffer);
    case "mbox-records":
      return native.buildMboxRecords(task.messages);
    case "zip-guard":
      native.assertZipWithinLimits(task.buffer, task.limits);
      return null;
  }
}

// One channel, two transports: a Worker has `parentPort`, a forked child has
// the process IPC. Both speak the same {ok, result|error} protocol.
const port = parentPort;
const channel =
  port !== null
    ? {
        on: (handler: (message: IsolateTask) => void): void => {
          port.on("message", handler);
        },
        post: (message: IsolateResponse): void => {
          port.postMessage(message);
        },
      }
    : {
        on: (handler: (message: IsolateTask) => void): void => {
          process.on("message", handler);
        },
        post: (message: IsolateResponse): void => {
          process.send?.(message);
        },
      };

channel.on((task) => {
  void dispatch(task).then(
    (result) => channel.post({ ok: true, result }),
    (error: unknown) => channel.post({ ok: false, error: serializeError(error) }),
  );
});
