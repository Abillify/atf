// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Workspace-count hygiene gate (Req 14.2, Task 20.2).
 *
 *   bun run check:workspace-counts   # fail when README/ARCHITECTURE drift
 *
 * README.md and ARCHITECTURE.md state how many applications and shared packages
 * the monorepo contains and must name every workspace. Hand-written counts go
 * stale the moment a workspace is added or removed (they did: the Outpost apps
 * and the security/observability packages were missing from both documents).
 * This gate enumerates the real workspaces from the filesystem and asserts the
 * documents agree, so a future `apps/<new>` fails CI until the docs catch up.
 *
 * Checked:
 *   - the spelled-out counts ("Seven applications", "ten shared packages")
 *     match the number of workspace directories under apps/ and packages/;
 *   - every app directory is named in README.md and ARCHITECTURE.md;
 *   - every package name is named in ARCHITECTURE.md;
 *   - the Outpost appears in the README introduction (it is a product surface,
 *     not a footnote).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

const NUM_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

/** Word form used by the documents, capitalised for sentence position. */
function word(count: number): string {
  const w = NUM_WORDS[count];
  if (!w) throw new Error(`No word form for count ${count} — extend NUM_WORDS.`);
  return w;
}

function workspaceDirs(group: string): string[] {
  const dir = join(root, group);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "package.json")))
    .map((entry) => entry.name)
    .sort();
}

const apps = workspaceDirs("apps");
const packages = workspaceDirs("packages");
const integrations = workspaceDirs("integration");

const readme = readFileSync(join(root, "README.md"), "utf8");
const architecture = readFileSync(join(root, "ARCHITECTURE.md"), "utf8");

const failures: string[] = [];

function expect(haystack: string, needle: string, file: string, what: string): void {
  if (!haystack.includes(needle)) {
    failures.push(`${file}: ${what} — expected to find "${needle}"`);
  }
}

// The spelled-out application count must match apps/ on disk. Both documents
// phrase it as "<N> ... applications"; check the word in each.
expect(readme, `${word(apps.length)} applications`, "README.md", "application count is stale");
expect(
  architecture,
  `${word(apps.length)} independently deployable applications`,
  "ARCHITECTURE.md",
  "application count is stale",
);
expect(
  architecture,
  `${word(packages.length)} shared packages`,
  "ARCHITECTURE.md",
  "shared package count is stale",
);

// Every application must be named in both documents (directory reference form).
for (const app of apps) {
  expect(readme, `apps/${app}`, "README.md", `application "${app}" is not listed`);
  expect(architecture, `apps/${app}`, "ARCHITECTURE.md", `application "${app}" is not listed`);
}

// Every shared package must be named in ARCHITECTURE.md (package name form).
for (const pkg of packages) {
  expect(architecture, `@atf/${pkg}`, "ARCHITECTURE.md", `package "${pkg}" is not listed`);
}

// The integration suite is part of the published layout and is referenced by
// name in both documents.
for (const integration of integrations) {
  expect(readme, `integration/${integration}`, "README.md", `integration "${integration}" is not listed`);
  expect(
    architecture,
    `integration/${integration}`,
    "ARCHITECTURE.md",
    `integration "${integration}" is not listed`,
  );
}

// Req 14.2: the Outpost belongs in the README introduction, not only in a
// table row. Check the paragraph block before the Architecture heading.
const intro = readme.slice(0, readme.indexOf("## Architecture"));
if (!intro.includes("Outpost")) {
  failures.push("README.md: introduction does not mention the Outpost (Req 14.2)");
}

if (failures.length > 0) {
  console.error("Workspace-count check failed:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  console.error(
    `\nWorkspaces on disk: ${apps.length} apps, ${packages.length} packages, ${integrations.length} integrations.`,
  );
  console.error("Update README.md / ARCHITECTURE.md (or this script if the layout changed).");
  process.exit(1);
}

console.log(
  `Workspace counts OK: ${apps.length} apps, ${packages.length} packages, ${integrations.length} integrations — README.md and ARCHITECTURE.md agree.`,
);
