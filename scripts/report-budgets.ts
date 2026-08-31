// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { stat } from "node:fs/promises";
import { resolve } from "node:path";

interface ArtifactBudget { path: string; warningBytes: number }
interface BudgetFile { version: number; artifacts: Record<string, ArtifactBudget> }

const root = resolve(import.meta.dir, "..");
const enforce = process.argv.includes("--enforce");
const budgetFile = process.env.ATF_BUDGET_FILE ?? "budgets/default.json";
const budget = await Bun.file(resolve(root, budgetFile)).json() as BudgetFile;

async function directoryBytes(path: string): Promise<number | undefined> {
  try {
    const info = await stat(path);
    if (info.isFile()) return info.size;
  } catch {
    return undefined;
  }
  let total = 0;
  const glob = new Bun.Glob("**/*");
  for await (const relative of glob.scan({ cwd: path, onlyFiles: true, dot: true })) {
    total += (await stat(resolve(path, relative))).size;
  }
  return total;
}

let violations = 0;
console.log(`Artifact budgets from ${budgetFile} (${enforce ? "enforce" : "report"})`);
for (const [name, entry] of Object.entries(budget.artifacts)) {
  const bytes = await directoryBytes(resolve(root, entry.path));
  if (bytes === undefined) {
    console.log(`- ${name}: not built (${entry.path})`);
    if (enforce) violations++;
    continue;
  }
  const exceeded = bytes > entry.warningBytes;
  if (exceeded) violations++;
  console.log(`- ${name}: ${bytes} / ${entry.warningBytes} bytes${exceeded ? " [OVER]" : " [OK]"}`);
}
if (enforce && violations > 0) {
  console.error(`${violations} artifact budget violation(s)`);
  process.exitCode = 1;
} else if (!enforce && violations > 0) {
  console.warn(`${violations} artifact budget warning(s); report mode does not fail the build`);
}
