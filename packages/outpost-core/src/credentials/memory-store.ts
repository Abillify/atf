// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * In-memory {@link CredentialStore} for tests and short-lived commands.
 * Values live only for the process lifetime; nothing is written to disk.
 */

import type { CredentialStore } from "./store.js";

export class MemoryCredentialStore implements CredentialStore {
  private readonly map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  /** Test helper: snapshot of all stored keys (never the values). */
  keys(): string[] {
    return [...this.map.keys()];
  }
}
