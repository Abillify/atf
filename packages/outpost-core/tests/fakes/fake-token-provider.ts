// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Controllable {@link TokenProvider} for HTTP-client tests: counts calls and
 * can be scripted to fail on refresh.
 */

import type { TokenProvider } from "../../src/index.js";

export class FakeTokenProvider implements TokenProvider {
  forceRefreshCalls = 0;
  logoutCalls = 0;

  constructor(
    private token = "test-token",
    private failRefresh = false,
  ) {}

  setToken(token: string): void {
    this.token = token;
  }

  setFailRefresh(fail: boolean): void {
    this.failRefresh = fail;
  }

  async getAccessToken(_now: number): Promise<string> {
    return this.token;
  }

  async forceRefresh(): Promise<string> {
    this.forceRefreshCalls++;
    if (this.failRefresh) throw new Error("refresh failed");
    return this.token;
  }

  async logout(): Promise<void> {
    this.logoutCalls++;
  }
}
