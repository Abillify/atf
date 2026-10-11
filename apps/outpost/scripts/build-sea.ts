// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/** Builds the Node SEA sidecar for the three desktop targets (13.1, 14.1). */

import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = join(import.meta.dirname, "..");
const entry = join(root, "dist-node", "main.js");
const outputDir = join(root, "..", "outpost-desktop", "src-tauri", "binaries");
const nodeCommand = process.env.NODE_BIN ?? "node";
const postject = process.env.POSTJECT_BIN ?? join(root, "node_modules", ".bin", "postject");
const sentinelFuse = process.env.SEA_FUSE ?? "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const targets = {
  "x86_64-pc-windows-msvc": { ext: ".exe" },
  "aarch64-apple-darwin": { ext: "" },
  "x86_64-apple-darwin": { ext: "" },
} as const;

function localTarget(): keyof typeof targets {
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.platform === "darwin" && process.arch === "x64") return "x86_64-apple-darwin";
  if (process.platform === "win32" && process.arch === "x64") return "x86_64-pc-windows-msvc";
  throw new Error("Kein Standard-SEA-Ziel fuer diese Plattform; SEA_TARGET setzen");
}

async function main(): Promise<void> {
  await run("bun", ["build", "./src/main.ts", "--outdir", "./dist-node", "--target", "node"], { cwd: root });
  await mkdir(outputDir, { recursive: true });
  const nodeBinary = process.env.NODE_BIN ?? (await run("which", [nodeCommand])).stdout.trim();
  if (nodeBinary === "") throw new Error("Node-Binary konnte nicht gefunden werden");

  const triple = process.env.SEA_TARGET ?? localTarget();
  const target = targets[triple as keyof typeof targets];
  if (target === undefined) throw new Error(`Unbekanntes SEA_TARGET: ${triple}`);
  const work = await mkdtemp(join(tmpdir(), "atf-outpost-sea-"));
  const blob = join(work, "sea-prep.blob");
  const config = join(work, "sea-config.json");
  const staged = join(work, `node${target.ext}`);
  const destination = join(outputDir, `atf-outpost-${triple}${target.ext}`);
  await writeFile(config, JSON.stringify({ main: entry, output: blob, disableExperimentalSEAWarning: true }));
  await run(nodeBinary, ["--experimental-sea-config", config]);
  await copyFile(nodeBinary, staged);

  if (triple.includes("apple-darwin")) {
    await run("codesign", ["--remove-signature", staged]);
  }
  await run(postject, [staged, "NODE_SEA_BLOB", blob, "--sentinel-fuse", sentinelFuse]);

  if (triple.includes("apple-darwin")) {
    const entitlements = join(root, "..", "outpost-desktop", "src-tauri", "entitlements.plist");
    await run("codesign", ["--force", "--sign", "-", "--options", "runtime", "--entitlements", entitlements, staged]);
  }
  await chmod(staged, 0o755);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(staged, destination);
  await rm(work, { recursive: true, force: true });
  console.log(`SEA erstellt: ${destination}`);
}

await main();
