// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { DbProvider, QueryRunner } from "../../src/db/manager.ts";

export interface RecordedCall {
  database: string;
  sql: string;
  bindings: unknown;
}

/**
 * A DbProvider that records every query and returns canned rows (pg-style
 * `{ rows }`). Lets integration tests exercise the full tool/MCP/router paths
 * without a real database driver.
 */
export class FakeDb implements DbProvider {
  readonly calls: RecordedCall[] = [];

  constructor(private readonly rowsByDb: Record<string, unknown[]> = {}) {}

  get(name: string): QueryRunner {
    return {
      raw: async (sql: string, bindings?: unknown) => {
        this.calls.push({ database: name, sql, bindings });
        return { rows: this.rowsByDb[name] ?? [] };
      },
    };
  }

  names(): string[] {
    return Object.keys(this.rowsByDb);
  }

  clientName(): string | undefined {
    return "pg";
  }

  async healthcheck(): Promise<boolean> {
    return true;
  }

  async destroyAll(): Promise<void> {}

  /** Last recorded query for a database (or overall). */
  last(database?: string): RecordedCall | undefined {
    const list = database ? this.calls.filter((c) => c.database === database) : this.calls;
    return list[list.length - 1];
  }
}
