// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Built-in node-type aggregator.
 *
 * Each built-in node type lives in its own module in this folder and exports a
 * `nodeType: NodeHandlerRegistration`. This index collects them and registers
 * them into a registry. The graph engine calls {@link registerBuiltins} at
 * module load so `createGraphEngine` is self-sufficient (no startup loader
 * needed for the built-ins, which keeps unit tests that construct the engine
 * directly working). External plugins use the SAME registration contract but
 * are discovered dynamically from a directory by the handler loader.
 */
import type {
  NodeHandlerRegistry,
  NodeHandlerRegistration,
} from "../node-handler-registry.js";
import { nodeType as llm } from "./llm.js";
import { nodeType as classifier } from "./classifier.js";
import { nodeType as tool } from "./tool.js";
import { nodeType as retrieval } from "./retrieval.js";
import { nodeType as memory } from "./memory.js";
import { nodeType as parallel } from "./parallel.js";
import { nodeType as router } from "./router.js";
import { nodeType as agentHarness } from "./agent-harness.js";
import { nodeType as transform } from "./transform.js";
import { nodeType as trigger } from "./trigger.js";
import { nodeType as assistantContext } from "./assistant-context.js";
import { nodeType as assistantLearn } from "./assistant-learn.js";

/** Every built-in node-type registration, in a stable order. */
export const builtinNodeTypes: readonly NodeHandlerRegistration[] = [
  llm,
  classifier,
  tool,
  retrieval,
  memory,
  parallel,
  router,
  agentHarness,
  transform,
  trigger,
  // Per-user assistant nodes. Both pass their turn through unchanged when the
  // assistant subsystem is not wired on the runtime, so registering them
  // unconditionally does not affect deployments that do not run assistants.
  assistantContext,
  assistantLearn,
];

/**
 * Registers all built-in node types into `registry`. Registration throws on a
 * duplicate type, so a plugin attempting to shadow a built-in fails loudly.
 */
export function registerBuiltins(registry: NodeHandlerRegistry): void {
  for (const nt of builtinNodeTypes) registry.register(nt);
}
