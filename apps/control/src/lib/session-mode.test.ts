// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect, afterEach } from "vitest";

import {
  controlSessionMode,
  parseControlSessionMode,
} from "./session-mode";

describe("parseControlSessionMode", () => {
  test("defaults to token mode", () => {
    expect(parseControlSessionMode(undefined)).toBe("token");
    expect(parseControlSessionMode("")).toBe("token");
    expect(parseControlSessionMode("token")).toBe("token");
  });

  test("accepts bff", () => {
    expect(parseControlSessionMode("bff")).toBe("bff");
  });

  test("throws on any other value (fail closed)", () => {
    expect(() => parseControlSessionMode("BFF")).toThrow();
    expect(() => parseControlSessionMode("proxy")).toThrow();
    expect(() => parseControlSessionMode("bff ")).toThrow();
  });
});

describe("controlSessionMode", () => {
  afterEach(() => {
    delete process.env["CONTROL_SESSION_MODE"];
  });

  test("reads the environment", () => {
    delete process.env["CONTROL_SESSION_MODE"];
    expect(controlSessionMode()).toBe("token");
    process.env["CONTROL_SESSION_MODE"] = "bff";
    expect(controlSessionMode()).toBe("bff");
  });
});
