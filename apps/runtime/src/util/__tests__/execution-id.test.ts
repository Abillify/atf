// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for execution-id normalisation (`src/util/execution-id.ts`).
 */

import { describe, it, expect } from "bun:test";
import { normalizeExecutionId } from "../execution-id.js";

describe("normalizeExecutionId", () => {
  it("strips the chatcmpl- response-id prefix", () => {
    expect(normalizeExecutionId("chatcmpl-abc-123")).toBe("abc-123");
  });

  it("strips the longer chatcmpl-replay- prefix first", () => {
    expect(normalizeExecutionId("chatcmpl-replay-abc-123")).toBe("abc-123");
  });

  it("passes a bare execution id through unchanged", () => {
    expect(normalizeExecutionId("exec-1")).toBe("exec-1");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeExecutionId("  chatcmpl-abc  ")).toBe("abc");
    expect(normalizeExecutionId("  exec-1  ")).toBe("exec-1");
  });

  it("leaves unrelated prefixed ids untouched", () => {
    expect(normalizeExecutionId("resp-abc-123")).toBe("resp-abc-123");
    expect(normalizeExecutionId("chatcmpl")).toBe("chatcmpl");
  });
});
