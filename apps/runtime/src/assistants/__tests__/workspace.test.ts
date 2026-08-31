// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Workspace containment — the isolation boundary of the sandbox.
 *
 * The symlink cases are the reason this module exists. An assistant can create
 * symlinks (it runs code in its own workspace), so a lexical `startsWith` check on
 * the resolved path is not a boundary. These tests create real symlinks pointing
 * outward and assert they are refused.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AssistantWorkspaceResolver,
  WorkspacePathError,
  canonicalizeAllowingMissingTail,
  isInside,
} from "../workspace.js";
import type { AssistantScope } from "../types.js";

const SCOPE: AssistantScope = {
  tenantId: "_",
  userId: "user@example.com",
  assistantId: "molty",
};

let root: string;
let outside: string;
let resolver: AssistantWorkspaceResolver;

beforeEach(() => {
  // realpath the temp root: on macOS os.tmpdir() is /var/... which is a symlink to
  // /private/var/..., so an unresolved root makes every containment comparison
  // fail there while passing on Linux.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aip-ws-")));
  root = path.join(base, "workspaces");
  outside = path.join(base, "outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "not yours", "utf8");
  resolver = new AssistantWorkspaceResolver({ root });
});

afterEach(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

describe("workspace layout", () => {
  test("the directory is derived from the scope triple", () => {
    const dir = resolver.workspaceDir(SCOPE);
    // The email is sanitised into a safe single path segment.
    expect(dir).toBe(path.join(resolver.rootDir(), "_", "user-example-com", "molty"));
  });

  test("provisioning creates the standard subdirectories", async () => {
    const dir = await resolver.ensureWorkspace(SCOPE);
    for (const sub of ["scripts", "data", "tmp"]) {
      expect(fs.existsSync(path.join(dir, sub))).toBe(true);
    }
  });

  test("provisioning is idempotent", async () => {
    const first = await resolver.ensureWorkspace(SCOPE);
    const second = await resolver.ensureWorkspace(SCOPE);
    expect(second).toBe(first);
  });

  test("two assistants of one user do not share a directory", () => {
    const a = resolver.workspaceDir(SCOPE);
    const b = resolver.workspaceDir({ ...SCOPE, assistantId: "other" });
    expect(a).not.toBe(b);
  });

  test("two users do not share a directory", () => {
    const a = resolver.workspaceDir(SCOPE);
    const b = resolver.workspaceDir({ ...SCOPE, userId: "other@example.com" });
    expect(a).not.toBe(b);
  });

  test("an unusable identity fails rather than falling back to a placeholder", () => {
    // Two users whose identities both degraded to the same placeholder would share
    // a workspace, which is the exact isolation failure this module prevents.
    expect(() => resolver.workspaceDir({ ...SCOPE, userId: "!!!" })).toThrow(WorkspacePathError);
  });
});

describe("path containment", () => {
  test("a normal relative path resolves inside", async () => {
    const resolved = await resolver.resolveInWorkspace(SCOPE, "scripts/report.py");
    expect(isInside(await resolver.ensureWorkspace(SCOPE), resolved)).toBe(true);
  });

  test("a path that does not exist yet still resolves", async () => {
    // Writing a new file must work; a plain realpath would throw ENOENT here.
    const resolved = await resolver.resolveInWorkspace(SCOPE, "data/new/deep/file.json");
    expect(resolved).toContain(path.join("data", "new", "deep"));
  });

  test.each(["../../etc/passwd", "..", "scripts/../../../outside/secret.txt"])(
    "traversal %p is refused",
    async (relativePath) => {
      await expect(resolver.resolveInWorkspace(SCOPE, relativePath)).rejects.toThrow(
        WorkspacePathError,
      );
    },
  );

  test("an absolute path is refused", async () => {
    await expect(resolver.resolveInWorkspace(SCOPE, "/etc/passwd")).rejects.toThrow(
      WorkspacePathError,
    );
  });

  test("an empty path is refused", async () => {
    await expect(resolver.resolveInWorkspace(SCOPE, "  ")).rejects.toThrow(WorkspacePathError);
  });
});

describe("symlink escapes", () => {
  test("a symlinked directory pointing outward is refused", async () => {
    const workspace = await resolver.ensureWorkspace(SCOPE);
    fs.symlinkSync(outside, path.join(workspace, "escape"), "dir");
    // A lexical startsWith check on the resolved path would pass this: the string
    // does begin with the workspace root. Only realpath catches it.
    await expect(resolver.resolveInWorkspace(SCOPE, "escape/secret.txt")).rejects.toThrow(
      WorkspacePathError,
    );
  });

  test("a symlinked file pointing outward is refused", async () => {
    const workspace = await resolver.ensureWorkspace(SCOPE);
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "link.txt"), "file");
    await expect(resolver.resolveInWorkspace(SCOPE, "link.txt")).rejects.toThrow(
      WorkspacePathError,
    );
  });

  test("a symlink into a SIBLING assistant's workspace is refused", async () => {
    const mine = await resolver.ensureWorkspace(SCOPE);
    const theirs = await resolver.ensureWorkspace({
      ...SCOPE,
      assistantId: "sibling",
    });
    fs.writeFileSync(path.join(theirs, "notes.txt"), "sibling data", "utf8");
    fs.symlinkSync(theirs, path.join(mine, "peer"), "dir");
    // Both are under the same root, so a root-level containment check would allow
    // this. Containment is per assistant, not per deployment.
    await expect(resolver.resolveInWorkspace(SCOPE, "peer/notes.txt")).rejects.toThrow(
      WorkspacePathError,
    );
  });

  test("a not-yet-existing file under a symlinked directory is refused", async () => {
    const workspace = await resolver.ensureWorkspace(SCOPE);
    fs.symlinkSync(outside, path.join(workspace, "escape"), "dir");
    // The tail does not exist, so the check must canonicalise the deepest existing
    // ancestor. Skipping canonicalisation for missing tails is precisely the hole a
    // symlinked parent exploits.
    await expect(resolver.resolveInWorkspace(SCOPE, "escape/new-file.txt")).rejects.toThrow(
      WorkspacePathError,
    );
  });

  test("a symlink pointing inward is allowed", async () => {
    const workspace = await resolver.ensureWorkspace(SCOPE);
    fs.symlinkSync(path.join(workspace, "data"), path.join(workspace, "shortcut"), "dir");
    const resolved = await resolver.resolveInWorkspace(SCOPE, "shortcut/out.json");
    // Legitimate convenience, not an escape — refusing it would be over-blocking.
    expect(isInside(workspace, resolved)).toBe(true);
  });
});

describe("canonicalisation helper", () => {
  test("an existing path resolves through symlinks", async () => {
    const link = path.join(path.dirname(root), "link-to-outside");
    fs.symlinkSync(outside, link, "dir");
    expect(await canonicalizeAllowingMissingTail(link)).toBe(outside);
  });

  test("a missing tail is re-attached to the canonical ancestor", async () => {
    const target = path.join(outside, "a", "b", "c.txt");
    expect(await canonicalizeAllowingMissingTail(target)).toBe(target);
  });
});

describe("isInside", () => {
  test("a path is inside itself", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
  });

  test("a sibling with a shared prefix is not inside", () => {
    // A string prefix check would wrongly say yes here.
    expect(isInside("/data/wo", "/data/work")).toBe(false);
  });

  test("a child is inside", () => {
    expect(isInside("/data/work", "/data/work/sub/file")).toBe(true);
  });

  test("a parent is not inside its child", () => {
    expect(isInside("/data/work/sub", "/data/work")).toBe(false);
  });
});
