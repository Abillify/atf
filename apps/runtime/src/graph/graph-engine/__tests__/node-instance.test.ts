// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
  NODE_INSTANCE_KEY,
  nodeInstanceOf,
  nodeStateKey,
} from "../node-instance.js";

describe("nodeStateKey", () => {
  test("is the plain node id without an instance", () => {
    expect(nodeStateKey("n", undefined)).toBe("n");
  });

  test("appends the instance after a hash separator", () => {
    expect(nodeStateKey("n", "t3")).toBe("n#t3");
  });
});

describe("nodeInstanceOf", () => {
  test("reads the instance from the configurable bag", () => {
    expect(
      nodeInstanceOf({ configurable: { [NODE_INSTANCE_KEY]: "t1" } }),
    ).toBe("t1");
  });

  test("treats empty strings as no instance", () => {
    expect(nodeInstanceOf({ configurable: { [NODE_INSTANCE_KEY]: "" } })).toBe(
      undefined,
    );
  });

  test("returns undefined for missing or malformed configs", () => {
    expect(nodeInstanceOf(undefined)).toBe(undefined);
    expect(nodeInstanceOf(null)).toBe(undefined);
    expect(nodeInstanceOf({})).toBe(undefined);
    expect(nodeInstanceOf({ configurable: null })).toBe(undefined);
    expect(nodeInstanceOf({ configurable: { atfNodeInstance: 7 } })).toBe(
      undefined,
    );
  });
});
