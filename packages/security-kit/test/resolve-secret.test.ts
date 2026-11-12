// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySecrets,
  materializeSecrets,
  resolveSecret,
  SecretConfigError,
} from "../src/index.ts";

let dir: string;

function secretFile(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atf-secret-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of [
    "TEST_SECRET",
    "TEST_SECRET_FILE",
    "OTHER_SECRET",
    "OTHER_SECRET_FILE",
  ]) {
    delete process.env[k];
  }
});

describe("resolveSecret", () => {
  test("reads the file when only NAME_FILE is set", () => {
    const p = secretFile("s", "file-value");
    expect(resolveSecret({ TEST_SECRET_FILE: p }, "TEST_SECRET")).toBe(
      "file-value",
    );
  });

  test("strips exactly one trailing newline", () => {
    const p = secretFile("s", "file-value\n");
    expect(resolveSecret({ TEST_SECRET_FILE: p }, "TEST_SECRET")).toBe(
      "file-value",
    );
  });

  test("strips exactly one trailing CRLF", () => {
    const p = secretFile("s", "file-value\r\n");
    expect(resolveSecret({ TEST_SECRET_FILE: p }, "TEST_SECRET")).toBe(
      "file-value",
    );
  });

  test("keeps interior newlines and a second trailing newline", () => {
    const p = secretFile("s", "line1\nline2\n\n");
    expect(resolveSecret({ TEST_SECRET_FILE: p }, "TEST_SECRET")).toBe(
      "line1\nline2\n",
    );
  });

  test("returns NAME verbatim when only NAME is set (never trimmed)", () => {
    expect(resolveSecret({ TEST_SECRET: "  spaced  " }, "TEST_SECRET")).toBe(
      "  spaced  ",
    );
  });

  test("throws naming both variables when both are set", () => {
    const p = secretFile("s", "file-value");
    expect(() =>
      resolveSecret({ TEST_SECRET_FILE: p, TEST_SECRET: "direct" }, "TEST_SECRET"),
    ).toThrow(SecretConfigError);
    expect(() =>
      resolveSecret({ TEST_SECRET_FILE: p, TEST_SECRET: "direct" }, "TEST_SECRET"),
    ).toThrow(/TEST_SECRET and TEST_SECRET_FILE are both set/);
  });

  test("an empty NAME does not count as set against NAME_FILE", () => {
    const p = secretFile("s", "file-value");
    expect(
      resolveSecret({ TEST_SECRET_FILE: p, TEST_SECRET: "" }, "TEST_SECRET"),
    ).toBe("file-value");
  });

  test("returns undefined when neither is set", () => {
    expect(resolveSecret({}, "TEST_SECRET")).toBeUndefined();
    expect(
      resolveSecret({ TEST_SECRET: "", TEST_SECRET_FILE: "" }, "TEST_SECRET"),
    ).toBeUndefined();
  });

  test("throws with the path when the file cannot be read", () => {
    const missing = join(dir, "does-not-exist");
    expect(() =>
      resolveSecret({ TEST_SECRET_FILE: missing }, "TEST_SECRET"),
    ).toThrow(SecretConfigError);
    expect(() =>
      resolveSecret({ TEST_SECRET_FILE: missing }, "TEST_SECRET"),
    ).toThrow(new RegExp(missing.replace(/[/\-]/g, "\\$&")));
  });

  test("throws when the file is empty", () => {
    const p = secretFile("empty", "");
    expect(() => resolveSecret({ TEST_SECRET_FILE: p }, "TEST_SECRET")).toThrow(
      /is empty/,
    );
  });

  test("throws when the file holds only a newline", () => {
    const p = secretFile("nl", "\n");
    expect(() => resolveSecret({ TEST_SECRET_FILE: p }, "TEST_SECRET")).toThrow(
      /is empty/,
    );
  });

  test("the NAME in NAME_FILE is never trimmed as a path", () => {
    // A path with a trailing space is a different (broken) path, not the same
    // file — the name must be used exactly as given.
    const p = secretFile("sp", "v");
    expect(() =>
      resolveSecret({ TEST_SECRET_FILE: `${p} ` }, "TEST_SECRET"),
    ).toThrow(SecretConfigError);
  });
});

describe("applySecrets", () => {
  test("resolves listed names and drops the _FILE entries", () => {
    const p = secretFile("s", "from-file");
    const out = applySecrets(
      {
        TEST_SECRET_FILE: p,
        OTHER_SECRET: "plain",
        UNRELATED: "keep",
      },
      ["TEST_SECRET", "OTHER_SECRET"],
    );
    expect(out["TEST_SECRET"]).toBe("from-file");
    expect(out["TEST_SECRET_FILE"]).toBeUndefined();
    expect(out["OTHER_SECRET"]).toBe("plain");
    expect(out["UNRELATED"]).toBe("keep");
  });

  test("deletes the name when neither variant is set", () => {
    const out = applySecrets({ OTHER_SECRET: "" }, ["OTHER_SECRET"]);
    expect(out["OTHER_SECRET"]).toBeUndefined();
  });

  test("does not touch unlisted secrets", () => {
    const out = applySecrets({ UNRELATED_FILE: "/tmp/x" }, ["TEST_SECRET"]);
    expect(out["UNRELATED_FILE"]).toBe("/tmp/x");
  });
});

describe("materializeSecrets", () => {
  test("rewrites process.env in place and removes _FILE", () => {
    const p = secretFile("s", "materialized\n");
    process.env["TEST_SECRET_FILE"] = p;
    materializeSecrets(["TEST_SECRET"]);
    expect(process.env["TEST_SECRET"]).toBe("materialized");
    expect(process.env["TEST_SECRET_FILE"]).toBeUndefined();
  });

  test("collects every error before throwing", () => {
    const missing = join(dir, "nope");
    process.env["TEST_SECRET_FILE"] = missing;
    process.env["OTHER_SECRET"] = "direct";
    process.env["OTHER_SECRET_FILE"] = missing;
    let message = "";
    try {
      materializeSecrets(["TEST_SECRET", "OTHER_SECRET"]);
    } catch (err) {
      expect(err).toBeInstanceOf(SecretConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain("TEST_SECRET_FILE");
    expect(message).toContain("OTHER_SECRET and OTHER_SECRET_FILE");
    // Nothing is written when any variable failed.
    expect(process.env["TEST_SECRET"]).toBeUndefined();
    expect(process.env["OTHER_SECRET"]).toBe("direct");
  });

  test("unset names stay unset", () => {
    materializeSecrets(["TEST_SECRET"]);
    expect(process.env["TEST_SECRET"]).toBeUndefined();
    expect(process.env["TEST_SECRET_FILE"]).toBeUndefined();
  });
});
