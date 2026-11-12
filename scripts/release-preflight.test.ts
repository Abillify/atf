// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
	containerScript,
	parseArgs,
	parsePinnedBun,
	QUICK_GATES,
	selectSteps,
	versionsMatch,
} from "./release-preflight.ts";

describe("parsePinnedBun", () => {
	test("reads the version from a packageManager pin", () => {
		expect(parsePinnedBun("bun@1.4.0")).toBe("1.4.0");
		expect(parsePinnedBun(" bun@1.4.0 ")).toBe("1.4.0");
		expect(parsePinnedBun("bun@v1.4.0")).toBe("1.4.0");
		expect(parsePinnedBun("bun@1.4.0+sha512.abc123")).toBe("1.4.0");
	});

	test("rejects non-Bun pins and malformed values", () => {
		expect(parsePinnedBun("npm@10.2.0")).toBeUndefined();
		expect(parsePinnedBun("pnpm@9.0.0")).toBeUndefined();
		expect(parsePinnedBun("bun@1.4")).toBeUndefined();
		expect(parsePinnedBun("bun")).toBeUndefined();
		expect(parsePinnedBun("")).toBeUndefined();
	});
});

describe("versionsMatch", () => {
	test("compares versions with and without a v prefix", () => {
		expect(versionsMatch("1.4.0", "1.4.0")).toBe(true);
		expect(versionsMatch("v1.4.0", "1.4.0")).toBe(true);
		expect(versionsMatch("1.4.3", "1.4.0")).toBe(false);
		expect(versionsMatch("1.4", "1.4.0")).toBe(false);
	});
});

describe("parseArgs", () => {
	test("defaults to no skips, no container, no workdir, full gate list", () => {
		const opts = parseArgs([]);
		expect(opts.skip.size).toBe(0);
		expect(opts.container).toBe(false);
		expect(opts.workdir).toBeUndefined();
		expect(opts.quick).toBe(false);
	});

	test("--quick selects the fast gate set", () => {
		expect(parseArgs(["--quick"]).quick).toBe(true);
		// Combinable with the other flags, and order-independent.
		const opts = parseArgs(["--quick", "--skip", "knip"]);
		expect(opts.quick).toBe(true);
		expect([...opts.skip]).toEqual(["knip"]);
	});

	test("collects repeated --skip and the container flag", () => {
		const opts = parseArgs(["--skip", "knip", "--container", "--skip", "gitleaks"]);
		expect([...opts.skip].sort()).toEqual(["gitleaks", "knip"]);
		expect(opts.container).toBe(true);
	});

	test("takes the --workdir path", () => {
		expect(parseArgs(["--workdir", "/tmp/preflight"]).workdir).toBe("/tmp/preflight");
	});

	test("rejects missing values and unknown flags", () => {
		expect(() => parseArgs(["--skip"])).toThrow("--skip requires a step name");
		expect(() => parseArgs(["--skip", "--container"])).toThrow("--skip requires a step name");
		expect(() => parseArgs(["--workdir"])).toThrow("--workdir requires a path");
		expect(() => parseArgs(["--nope"])).toThrow("unknown argument: --nope");
	});
});

describe("QUICK_GATES", () => {
	test("is the documented fast set", () => {
		expect(QUICK_GATES).toEqual([
			"verify:spdx",
			"verify:version",
			"config-reference:check",
			"flow-reference:check",
			"route-reference:check",
			"check:links",
			"lint:baseline",
			"typecheck",
			"test",
		]);
	});

	test("omits the slow, platform-specific and history-facing gates", () => {
		for (const slow of ["build", "test:contracts", "check:budgets:ci", "verify:public"]) {
			expect(QUICK_GATES).not.toContain(slow);
		}
	});
});

describe("selectSteps", () => {
	const names = (quick: boolean, skip: string[] = []): string[] =>
		selectSteps({ quick, skip: new Set(skip) }).map((s) => s.name);

	test("quick mode is exactly QUICK_GATES, in CI order", () => {
		expect(names(true)).toEqual(QUICK_GATES);
	});

	test("full mode keeps the gates quick mode drops", () => {
		const full = names(false);
		expect(full).toContain("openapi:check");
		expect(full).toContain("build");
		expect(full).toContain("check:budgets:ci");
		expect(full.length).toBeGreaterThan(QUICK_GATES.length);
		// Quick is a subset, never a different set: no invented gate names.
		for (const name of QUICK_GATES) expect(full).toContain(name);
	});

	test("--skip removes a quick gate and unknown names are ignored", () => {
		expect(names(true, ["knip"])).toEqual(QUICK_GATES);
		expect(names(true, ["typecheck"])).not.toContain("typecheck");
		expect(names(false, ["no-such-gate"])).toEqual(names(false));
	});
});

describe("containerScript", () => {
	test("installs the pinned Bun and runs the inventory check with the recipe flags", () => {
		const script = containerScript("1.4.0");
		expect(script).toContain('bash -s "bun-v1.4.0"');
		expect(script).toContain("cargo fetch --locked --manifest-path apps/outpost-desktop/src-tauri/Cargo.toml");
		expect(script).toContain(
			"--platform linux-x64 --assert-host-platform --artifact-kind workspace " +
				"--artifact-name workspace-linux-x64 --git-sha unknown --include-cargo",
		);
		expect(script).toContain("bun run supply-chain $FLAGS");
		expect(script).toContain("bun run supply-chain:check $FLAGS");
	});
});
