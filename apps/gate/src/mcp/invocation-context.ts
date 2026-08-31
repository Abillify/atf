// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthContext } from "../auth/context.ts";
import type { ToolResult } from "../tools/types.ts";

/**
 * Request-local mediation used by composite and router tools. It keeps every
 * nested tool call inside the same authorization/governance boundary as the
 * public MCP request without putting mutable request state in the registry.
 */
export interface NestedActionOptions {
  /** Stable within its parent action and identical across retries. */
  logicalActionId: string;
}

export type NestedToolInvoker = (
  name: string,
  args: Record<string, unknown>,
  ctx: AuthContext,
  signal: AbortSignal | undefined,
  options: NestedActionOptions,
) => Promise<ToolResult>;

const invocationStorage = new AsyncLocalStorage<NestedToolInvoker>();

export const runWithNestedInvoker = <T>(invoker: NestedToolInvoker, run: () => Promise<T>) =>
  invocationStorage.run(invoker, run);

export const nestedToolInvoker = (): NestedToolInvoker | undefined => invocationStorage.getStore();
