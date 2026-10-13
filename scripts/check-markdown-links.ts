// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Markdown link hygiene gate (Req 14.9, Task 20.8).
 *
 *   bun run check:links   # fail on dead relative links in Markdown
 *
 * Scans every tracked-looking Markdown file in the repository and verifies
 * that RELATIVE links (links and images) resolve to a file or directory that
 * exists, and that in-file anchors (#section) match a heading in the target
 * document. Absolute URLs (http/https/mailto/data) are NOT fetched — CI must
 * not depend on the network; external link rot is handled by review.
 *
 * Links inside fenced or inline code are ignored, so documentation that
 * SHOWS link syntax is not flagged.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = process.cwd();

/** Directories that never contain source documentation. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".kiro",
  "dist",
  "build",
  "coverage",
  "out",
  ".next",
  ".svelte-kit",
  "target",
  ".venv",
  "venv",
  "__snapshots__",
  ".scratch",
  ".turbo",
  ".cache",
]);

type Finding = { file: string; line: number; link: string; why: string };

function* markdownFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* markdownFiles(full);
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      yield full;
    }
  }
}

/** GitHub-style heading slug: lowercase, punctuation dropped, spaces -> '-'. */
function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

const headingCache = new Map<string, Set<string>>();

function headingsOf(file: string): Set<string> {
  let set = headingCache.get(file);
  if (!set) {
    set = new Set<string>();
    let inFence = false;
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      if (/^\s*(```|~~~)/.test(raw)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const m = /^(#{1,6})\s+(.*)$/.exec(raw);
      if (m?.[2]) set.add(slugify(m[2]));
    }
    headingCache.set(file, set);
  }
  return set;
}

/**
 * Strip fenced code blocks and inline code spans from a line, keeping line
 * numbers intact by returning the line with code content blanked.
 */
function blankCode(lines: string[]): string[] {
  const masked: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      masked.push("");
      continue;
    }
    if (inFence) {
      masked.push("");
      continue;
    }
    // Blank inline code spans: `...` (non-greedy, no newlines involved).
    masked.push(line.replace(/`[^`]*`/g, "``"));
  }
  return masked;
}

// [text](target) or ![alt](target), allowing an optional title.
const LINK_RE = /!?\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

function checkFile(file: string): Finding[] {
  const findings: Finding[] = [];
  const text = readFileSync(file, "utf8");
  const masked = blankCode(text.split("\n"));
  for (let i = 0; i < masked.length; i++) {
    const line = masked[i] ?? "";
    for (const m of line.matchAll(LINK_RE)) {
      const target = m[1] ?? "";
      if (!target || target.startsWith("<")) continue;
      if (/^(https?:|mailto:|data:|#)/i.test(target)) continue;
      const [pathPart, anchor] = splitAnchor(target);
      if (!pathPart) continue; // pure anchor handled above via '#'
      const abs = resolve(dirname(file), decodeURIComponent(pathPart));
      if (!existsSync(abs)) {
        findings.push({
          file,
          line: i + 1,
          link: target,
          why: "target does not exist",
        });
        continue;
      }
      if (anchor && /\.md$/i.test(abs) && statSync(abs).isFile()) {
        if (!headingsOf(abs).has(slugify(decodeURIComponent(anchor)))) {
          findings.push({
            file,
            line: i + 1,
            link: target,
            why: `anchor #${anchor} not found in ${pathPart}`,
          });
        }
      }
    }
  }
  return findings;
}

function splitAnchor(target: string): [string, string | undefined] {
  const idx = target.indexOf("#");
  if (idx === -1) return [target, undefined];
  return [target.slice(0, idx), target.slice(idx + 1)];
}

function main(): void {
  const findings: Finding[] = [];
  let files = 0;
  for (const file of markdownFiles(ROOT)) {
    files++;
    findings.push(...checkFile(file));
  }
  const rel = (f: string) => f.slice(ROOT.length + 1);
  if (findings.length > 0) {
    for (const f of findings) {
      console.error(
        `${rel(f.file)}:${f.line}: dead link "${f.link}" (${f.why})`,
      );
    }
    console.error(
      `\ncheck:links FAILED: ${findings.length} dead link(s) in ${files} Markdown files`,
    );
    process.exit(1);
  }
  console.log(
    `check:links passed: ${files} Markdown files, no dead relative links`,
  );
}

main();
