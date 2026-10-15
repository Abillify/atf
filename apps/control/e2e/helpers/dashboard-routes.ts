// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DASHBOARD_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "app",
  "(dashboard)",
);

/**
 * Every dashboard page, read from the app directory so a spec cannot drift
 * from the routes that actually ship (a hard-coded list kept scanning a
 * removed page — its 404 also has a <main>, so the check passed silently).
 */
export const DASHBOARD_ROUTES: string[] = readdirSync(DASHBOARD_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(DASHBOARD_DIR, entry.name, "page.tsx")))
  .map((entry) => `/${entry.name}`)
  .sort();
