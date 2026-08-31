// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for the red-team attack library.
 *
 * Verifies that:
 *   - Every attack has a unique id
 *   - Every attack renders a non-empty string
 *   - Category and severity are within expected bounds
 *   - sampleAttacks rotates deterministically
 *   - attacksByCategory filters correctly
 */

import { describe, test, expect } from "bun:test";
import {
  ATTACK_TEMPLATES,
  sampleAttacks,
  attacksByCategory,
} from "../red-team-attacks.js";

describe("ATTACK_TEMPLATES", () => {
  test("every attack has a unique id", () => {
    const ids = ATTACK_TEMPLATES.map((a) => a.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  test("every attack renders a non-empty string", () => {
    for (const attack of ATTACK_TEMPLATES) {
      const payload = attack.render();
      expect(typeof payload).toBe("string");
      expect(payload.length).toBeGreaterThan(0);
    }
  });

  test("every attack has severity in [0,1]", () => {
    for (const attack of ATTACK_TEMPLATES) {
      expect(attack.severity).toBeGreaterThanOrEqual(0);
      expect(attack.severity).toBeLessThanOrEqual(1);
    }
  });

  test("renders with flow context without throwing", () => {
    for (const attack of ATTACK_TEMPLATES) {
      expect(() =>
        attack.render({ flowDescription: "customer support", domain: "acme" }),
      ).not.toThrow();
    }
  });

  test("covers all six expected categories", () => {
    const categories = new Set(ATTACK_TEMPLATES.map((a) => a.category));
    expect(categories.has("prompt_injection")).toBe(true);
    expect(categories.has("jailbreak")).toBe(true);
    expect(categories.has("exfiltration")).toBe(true);
    expect(categories.has("pii_extraction")).toBe(true);
    expect(categories.has("tool_abuse")).toBe(true);
    expect(categories.has("encoding_evasion")).toBe(true);
  });
});

describe("sampleAttacks", () => {
  test("returns at most the requested count", () => {
    const sample = sampleAttacks(3);
    expect(sample.length).toBe(3);
  });

  test("returns all attacks when count >= total", () => {
    const all = sampleAttacks(ATTACK_TEMPLATES.length + 100);
    expect(all.length).toBe(ATTACK_TEMPLATES.length);
  });

  test("different seed offsets produce different starting attacks", () => {
    const a = sampleAttacks(5, 0);
    const b = sampleAttacks(5, 5);
    // They can share some attacks but should not be identical when offset > 0
    // and the pool is larger than the count.
    if (ATTACK_TEMPLATES.length > 5) {
      expect(a[0]?.id).not.toBe(b[0]?.id);
    }
  });

  test("same seed always produces the same result (deterministic)", () => {
    const r1 = sampleAttacks(4, 7).map((a) => a.id);
    const r2 = sampleAttacks(4, 7).map((a) => a.id);
    expect(r1).toEqual(r2);
  });
});

describe("attacksByCategory", () => {
  test("returns only attacks from the requested category", () => {
    const injections = attacksByCategory(["prompt_injection"]);
    expect(injections.length).toBeGreaterThan(0);
    for (const a of injections) {
      expect(a.category).toBe("prompt_injection");
    }
  });

  test("returns attacks from multiple categories", () => {
    const subset = attacksByCategory(["jailbreak", "exfiltration"]);
    const cats = new Set(subset.map((a) => a.category));
    expect(cats.has("jailbreak")).toBe(true);
    expect(cats.has("exfiltration")).toBe(true);
    expect(cats.has("prompt_injection")).toBe(false);
  });

  test("returns empty array for unknown category", () => {
    const result = attacksByCategory(["unknown_cat" as never]);
    expect(result).toHaveLength(0);
  });
});
