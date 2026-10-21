// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Resolution of `config.toolArgs` into the forced arguments for ONE tool ref.
 *
 * Keys may be an exact tool ref (`vectorsearch/search`), a server wildcard
 * (`vectorsearch/*`, every tool of that server) or the global wildcard `*`
 * (every tool of the node). A flow that pins the same argument on 74 tools
 * writes one `"*"` block instead. The merge order is fixed and flat per
 * argument name: `"*"`, then `"<server>/*"`, then the exact ref — later wins.
 *
 * Wildcard entries are applied only to arguments the tool's input schema
 * declares: a global `collection` pin must not leak an unknown parameter into
 * a tool that has none (e.g. `get_time`). Exact entries keep the previous
 * behaviour and always apply, declared or not.
 */

export type ToolArgsConfig = Record<string, Record<string, unknown>>;

/** A model-supplied value that counts as "set" (not omitted, null or blank). */
function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/**
 * Sticky arguments (`config.stickyArgs`): an argument the model sets once —
 * e.g. `valid_at` — is remembered for the rest of the execution and enforced on
 * every later call of a tool whose input schema declares it. The FIRST value
 * set sticks; a later different value from the model is overridden, so a
 * model that drifts cannot silently change the point in time or the scope a
 * whole run was asked about.
 *
 * `store` is the per-execution memory (shared by the nodes that list the same
 * name). Returns the sticky values to merge into this call: after the model's
 * arguments and before `toolArgs`, which always win. Only names the tool
 * declares are recorded and applied.
 */
export function applyStickyArgs(
  names: readonly string[] | undefined,
  store: Map<string, unknown>,
  modelArgs: Record<string, unknown>,
  declaredProps: ReadonlySet<string> | undefined,
): Record<string, unknown> {
  const sticky: Record<string, unknown> = {};
  if (names === undefined || declaredProps === undefined) return sticky;
  for (const name of names) {
    if (!declaredProps.has(name)) continue;
    if (!store.has(name) && isSet(modelArgs[name])) store.set(name, modelArgs[name]);
    if (store.has(name)) sticky[name] = store.get(name);
  }
  return sticky;
}

/** Server part of a tool ref, mirroring `agent-tools.ts` (`server/tool` → `server`). */
function serverOf(toolRef: string): string {
  const parts = toolRef.split("/");
  return parts.length >= 2 ? (parts[0] ?? toolRef) : toolRef;
}

/**
 * Merge the `"*"`, `"<server>/*"` and exact entries of `toolArgsCfg` for
 * `toolRef`. `declaredProps` is the property set of the tool's (filtered)
 * input schema; `undefined` means the schema declares none, so wildcard
 * arguments are dropped. `substitute` resolves templates in every value of
 * every level. Returns `undefined` when nothing is configured.
 */
export function resolveForcedToolArgs(
  toolArgsCfg: ToolArgsConfig | undefined,
  toolRef: string,
  declaredProps: ReadonlySet<string> | undefined,
  substitute: (value: unknown) => unknown,
): Record<string, unknown> | undefined {
  if (toolArgsCfg === undefined) return undefined;
  const merged: Record<string, unknown> = {};
  let any = false;
  const apply = (
    args: Record<string, unknown> | undefined,
    declaredOnly: boolean,
  ): void => {
    if (args === undefined) return;
    for (const [name, value] of Object.entries(args)) {
      if (declaredOnly && declaredProps?.has(name) !== true) continue;
      merged[name] = substitute(value);
      any = true;
    }
  };
  apply(toolArgsCfg["*"], true);
  apply(toolArgsCfg[`${serverOf(toolRef)}/*`], true);
  apply(toolArgsCfg[toolRef], false);
  return any ? merged : undefined;
}
