// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
import { describe, expect, test } from "bun:test";
import { trimTrailingSlashes } from "../src/index.js";

describe("trimTrailingSlashes", () => {
	test("removes every trailing slash and nothing else", () => {
		expect(trimTrailingSlashes("https://idp.example/realm///")).toBe("https://idp.example/realm");
		expect(trimTrailingSlashes("https://idp.example/realm")).toBe("https://idp.example/realm");
		expect(trimTrailingSlashes("a//b/")).toBe("a//b");
		expect(trimTrailingSlashes("///")).toBe("");
		expect(trimTrailingSlashes("")).toBe("");
	});

	test("stays linear on a long run of slashes that is not at the end", () => {
		const hostile = `${"/".repeat(200_000)}x`;
		const started = performance.now();
		expect(trimTrailingSlashes(hostile)).toBe(hostile);
		expect(performance.now() - started).toBeLessThan(200);
	});
});
