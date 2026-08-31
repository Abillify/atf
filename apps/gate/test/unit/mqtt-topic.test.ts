// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { topicMatches } from "../../src/mqtt/manager.ts";

describe("topicMatches", () => {
  it("matches an exact topic", () => {
    expect(topicMatches("a/b/c", "a/b/c")).toBe(true);
    expect(topicMatches("a/b/c", "a/b/d")).toBe(false);
  });

  it("matches a single-level wildcard (+)", () => {
    expect(topicMatches("a/+/c", "a/b/c")).toBe(true);
    expect(topicMatches("a/+/c", "a/x/c")).toBe(true);
    expect(topicMatches("a/+/c", "a/b/c/d")).toBe(false);
    expect(topicMatches("a/+/c", "a/c")).toBe(false);
  });

  it("matches a multi-level wildcard (#)", () => {
    expect(topicMatches("a/#", "a/b")).toBe(true);
    expect(topicMatches("a/#", "a/b/c/d")).toBe(true);
    expect(topicMatches("sensors/#", "sensors/temp/1")).toBe(true);
    expect(topicMatches("a/#", "b/c")).toBe(false);
  });

  it("requires equal length without wildcards", () => {
    expect(topicMatches("a/b", "a/b/c")).toBe(false);
    expect(topicMatches("a/b/c", "a/b")).toBe(false);
  });

  it("combines + and # in one filter", () => {
    expect(topicMatches("a/+/#", "a/b/c/d")).toBe(true);
    // Per MQTT spec, '#' also matches zero trailing levels, so a/+/# matches a/b.
    expect(topicMatches("a/+/#", "a/b")).toBe(true);
    // But '+' still requires its one level to be present.
    expect(topicMatches("a/+/#", "a")).toBe(false);
  });
});
