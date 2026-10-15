// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import pino from "pino";
import { pinoLogRedaction, withMaskedChildBindings } from "@atf/security-kit";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.c2lnbmF0dXJlX2J5dGVz";

describe("Search logger redaction (same options as src/index.ts)", () => {
  it("redacts entries, child bindings, messages and errors", () => {
    const lines: string[] = [];
    const root = withMaskedChildBindings(
      pino({ level: "info", ...pinoLogRedaction() }, { write: (l: string) => void lines.push(l) }),
    );
    const req = root.child({ authorization: `Bearer ${JWT}`, reqId: "r-1" });
    req.info({ headers: { cookie: "sid=abc" }, prompt_tokens: 7 }, `upstream rejected ${JWT}`);
    req.error({ err: new Error(`bad token ${JWT}`) }, "failed");

    const out = lines.join("");
    expect(out).not.toContain(JWT);
    expect(out).not.toContain("sid=abc");
    const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(first.authorization).toBe("[redacted]");
    expect(first.reqId).toBe("r-1");
    expect(first.prompt_tokens).toBe(7);
  });
});
