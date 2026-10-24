// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { containerScript, parseArgs, parsePinnedBun, versionsMatch } from "./release-preflight.ts";

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
	test("defaults to no skips, no container, no workdir", () => {
		const opts = parseArgs([]);
		expect(opts.skip.size).toBe(0);
		expect(opts.container).toBe(false);
		expect(opts.workdir).toBeUndefined();
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
