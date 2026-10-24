// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Guard against shipping a desktop release build whose Tauri updater still
 * carries the placeholder signing key or no update endpoints.
 *
 * Only a release build (OUTPOST_DESKTOP_RELEASE=1) fails; development builds
 * print a hint and exit 0.
 */

import { readFileSync } from "node:fs";

const CONFIG_PATH = new URL("../apps/outpost-desktop/src-tauri/tauri.conf.json", import.meta.url).pathname;

export interface UpdaterConfig {
  pubkey?: unknown;
  endpoints?: unknown;
}

export function extractUpdater(raw: string): UpdaterConfig {
  const parsed = JSON.parse(raw) as { plugins?: { updater?: UpdaterConfig } };
  return parsed.plugins?.updater ?? {};
}

export function isPlaceholderPubkey(pubkey: unknown): boolean {
  return typeof pubkey !== "string" || pubkey.trim() === "" || pubkey.startsWith("REPLACE_WITH");
}

export function hasEndpoints(endpoints: unknown): boolean {
  return Array.isArray(endpoints) && endpoints.length > 0;
}

export function main(env: Record<string, string | undefined> = process.env): number {
  const updater = extractUpdater(readFileSync(CONFIG_PATH, "utf8"));
  const missingKey = isPlaceholderPubkey(updater.pubkey);
  const missingEndpoints = !hasEndpoints(updater.endpoints);
  const release = env.OUTPOST_DESKTOP_RELEASE === "1";

  if (!missingKey && !missingEndpoints) {
    console.log("check:desktop-updater passed: the updater key and endpoints are configured.");
    return 0;
  }
  if (release) {
    console.error(
      "updater is not configured: set plugins.updater.pubkey and endpoints before a release build",
    );
    return 1;
  }
  console.warn(
    "check:desktop-updater: the updater still uses the placeholder key or has no endpoints; " +
      "this is fine for development but a release build will fail. " +
      "See apps/outpost-desktop/README.md, section \"Release builds\".",
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
