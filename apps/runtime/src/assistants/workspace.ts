// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Assistant workspace paths (`src/assistants/workspace.ts`)
 *
 * Every assistant owns one directory:
 *
 *   <root>/<tenant>/<user>/<assistant>/
 *
 * That directory is the ONLY filesystem region the assistant may read or write,
 * and it is the volume mounted into its code sandbox. This module owns the
 * mapping and — more importantly — the containment check.
 *
 * Why containment is checked with `realpath` and not string prefixes:
 * a lexical check (`resolved.startsWith(root)`) is defeated by a symlink inside
 * the workspace pointing outward. The assistant can create symlinks (it can run
 * code in there), so `path.resolve` alone is not a boundary — it collapses `..`
 * but knows nothing about links. The check therefore resolves the real path of
 * the deepest existing ancestor and re-attaches the not-yet-existing tail, which
 * is the only way to validate a path that is about to be created.
 *
 * macOS relevance: `os.tmpdir()` is `/var/…`, a symlink to `/private/var/…`.
 * A lexical check against an unresolved root passes on Linux and fails on macOS
 * (or vice versa), so the ROOT is canonicalised once at construction too.
 *
 * No `any` at module boundaries.
 */

import fs from "node:fs";
import path from "node:path";
import { sanitizeIdentitySegment, type AssistantScope } from "./types.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Reason a path was refused. */
export type WorkspacePathRejection =
  | "escapes-workspace"
  | "not-a-directory"
  | "unresolvable-identity"
  | "absolute-path-not-allowed"
  | "empty-path";

/**
 * Thrown when a requested path is outside the assistant's workspace.
 *
 * Carries a machine-readable `reason` so a tool result can tell the model what
 * to do differently instead of surfacing an opaque failure it will retry
 * verbatim.
 */
export class WorkspacePathError extends Error {
  constructor(
    readonly reason: WorkspacePathRejection,
    message: string,
  ) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/** Relative subdirectories every assistant workspace is provisioned with. */
export const WORKSPACE_SUBDIRS = [
  // Agent-authored scripts. Separated from `data` so a cleanup that wipes
  // scratch data cannot delete the procedures the assistant wrote.
  "scripts",
  // Inputs/outputs of script runs.
  "data",
  // Deliberately ephemeral; safe to purge between runs.
  "tmp",
] as const;

export interface AssistantWorkspaceResolverOptions {
  /**
   * Root under which every assistant directory is created. Canonicalised at
   * construction; a non-existent root is created (recursively) so first-run does
   * not require an operator step.
   */
  root: string;
  /**
   * Directory mode for created directories. Default `0o700` — an assistant
   * workspace holds user data and must not be group/world readable on a shared
   * host. Ignored on Windows.
   */
  mode?: number;
}

/**
 * Maps assistant scopes to directories and enforces containment.
 *
 * One instance is shared process-wide. `root` is resolved eagerly (constructor)
 * because a lazily-resolved root would have to be re-checked on every call,
 * which is exactly the per-request filesystem probing that makes hot paths slow.
 */
export class AssistantWorkspaceResolver {
  /** Canonical, symlink-resolved root. */
  private readonly root: string;
  private readonly mode: number;

  constructor(options: AssistantWorkspaceResolverOptions) {
    const requested = path.resolve(options.root);
    fs.mkdirSync(requested, { recursive: true, mode: options.mode ?? 0o700 });
    // Canonicalise AFTER creating: realpath fails on a non-existent path, and
    // resolving the root once here is what makes every later containment check
    // comparable on both Linux and macOS.
    // Plain `realpath` (not `.native`) here and in every other call site in this
    // module: root and candidate MUST be canonicalised by the same function, or
    // a difference between the two implementations would show up as a spurious
    // containment failure that is nearly impossible to diagnose.
    this.root = fs.realpathSync(requested);
    this.mode = options.mode ?? 0o700;
  }

  /** The canonical workspace root. */
  rootDir(): string {
    return this.root;
  }

  /**
   * Directory for one assistant. Pure — does not touch the filesystem, so it is
   * safe to call on hot paths (the sandbox needs the mount source per run).
   *
   * Throws {@link WorkspacePathError} when an identity cannot be reduced to a
   * safe path segment. It fails rather than substituting a placeholder: two
   * users whose identities both degraded to the same placeholder would share a
   * workspace, which is the isolation failure this whole module exists to
   * prevent.
   */
  workspaceDir(scope: AssistantScope): string {
    const tenantSegment = sanitizeIdentitySegment(scope.tenantId) ?? "_";
    const userSegment = sanitizeIdentitySegment(scope.userId);
    if (userSegment === undefined) {
      throw new WorkspacePathError(
        "unresolvable-identity",
        `User identity ${JSON.stringify(scope.userId)} cannot be reduced to a safe path segment.`,
      );
    }
    const assistantSegment = sanitizeIdentitySegment(scope.assistantId);
    if (assistantSegment === undefined) {
      throw new WorkspacePathError(
        "unresolvable-identity",
        `Assistant id ${JSON.stringify(scope.assistantId)} cannot be reduced to a safe path segment.`,
      );
    }
    return path.join(this.root, tenantSegment, userSegment, assistantSegment);
  }

  /**
   * Creates the assistant's directory tree and returns its canonical path.
   * Idempotent — safe to call on every provisioning attempt.
   */
  async ensureWorkspace(scope: AssistantScope): Promise<string> {
    const dir = this.workspaceDir(scope);
    await fs.promises.mkdir(dir, { recursive: true, mode: this.mode });
    await Promise.all(
      WORKSPACE_SUBDIRS.map((sub) =>
        fs.promises.mkdir(path.join(dir, sub), {
          recursive: true,
          mode: this.mode,
        }),
      ),
    );
    return fs.promises.realpath(dir);
  }

  /**
   * Resolves a workspace-relative path and proves it stays inside the workspace.
   *
   * `relativePath` must be relative. An absolute path is refused rather than
   * silently re-rooted: a model that emitted `/etc/passwd` asked for something
   * specific, and quietly turning that into `<workspace>/etc/passwd` hides the
   * mistake instead of correcting the model.
   *
   * Containment is proven against the real path of the deepest EXISTING ancestor,
   * so a path that is about to be created is validated correctly while a symlink
   * anywhere along the existing prefix is followed and caught.
   */
  async resolveInWorkspace(scope: AssistantScope, relativePath: string): Promise<string> {
    const trimmed = relativePath.trim();
    if (trimmed.length === 0) {
      throw new WorkspacePathError(
        "empty-path",
        "A workspace-relative path is required; received an empty string.",
      );
    }
    if (path.isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
      throw new WorkspacePathError(
        "absolute-path-not-allowed",
        `Paths must be relative to the assistant workspace; received the absolute path ${JSON.stringify(trimmed)}. ` +
          `Use a path like "scripts/report.py".`,
      );
    }

    const workspace = await this.ensureWorkspace(scope);
    const candidate = path.resolve(workspace, trimmed);
    const canonical = await canonicalizeAllowingMissingTail(candidate);

    if (!isInside(workspace, canonical)) {
      throw new WorkspacePathError(
        "escapes-workspace",
        `Path ${JSON.stringify(trimmed)} resolves outside the assistant workspace. ` +
          `Every read and write must stay within the workspace; symlinks pointing outside it are not followed.`,
      );
    }
    return canonical;
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Canonicalises `target`, tolerating a tail that does not exist yet.
 *
 * Walks up to the deepest existing ancestor, canonicalises THAT (following any
 * symlink), then re-attaches the remaining segments. A plain `realpath` would
 * throw `ENOENT` for a file about to be created, and skipping canonicalisation
 * in that case is precisely the hole a symlinked parent directory exploits.
 */
export async function canonicalizeAllowingMissingTail(target: string): Promise<string> {
  const absolute = path.resolve(target);
  const tail: string[] = [];
  let current = absolute;

  for (;;) {
    try {
      const real = await fs.promises.realpath(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const parent = path.dirname(current);
      // Reached the filesystem root without finding an existing ancestor. Only
      // possible for a nonsensical path; return the lexical form so the caller's
      // containment check rejects it rather than looping forever.
      if (parent === current) return absolute;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * True when `child` is `parent` itself or lies beneath it.
 *
 * Both arguments must already be canonical. Uses `path.relative` rather than a
 * string prefix so `/data/work` is not treated as being inside `/data/wo`.
 */
export function isInside(parent: string, child: string): boolean {
  if (parent === child) return true;
  const rel = path.relative(parent, child);
  if (rel.length === 0) return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}
