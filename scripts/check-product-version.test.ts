// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HELM_OCCURRENCES,
	syncOccurrences,
	type Occurrence,
} from "./check-product-version.ts";

/**
 * The Helm part of the product-version guard: `version:`, `appVersion: "…"`
 * and the four-space-indented dependency constraints in every `Chart.yaml`
 * must follow the product version, in sync mode and in check mode.
 */

const umbrellaChart = (version: string) => `apiVersion: v2
name: atf
description: ATF production stack.
type: application
version: ${version}
appVersion: "${version}"
dependencies:
  - name: atf-common
    version: ${version}
  - name: runtime
    version: ${version}
  - name: gate
    version: ${version}
  - name: search
    version: ${version}
  - name: extract
    version: ${version}
  - name: control
    version: ${version}
`;

const subchart = (name: string, version: string) => `apiVersion: v2
name: ${name}
description: ATF ${name}.
type: application
version: ${version}
appVersion: "${version}"
dependencies:
  - name: atf-common
    version: ${version}
`;

const libraryChart = (version: string) => `apiVersion: v2
name: atf-common
description: ATF shared library chart.
type: library
version: ${version}
appVersion: "${version}"
`;

describe("syncOccurrences on Helm charts", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "atf-helm-version-"));
		mkdirSync(join(dir, "deploy/helm/atf/charts/runtime"), { recursive: true });
		mkdirSync(join(dir, "deploy/helm/atf/charts/atf-common"), { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const writeTree = (oldVersion: string) => {
		writeFileSync(join(dir, "deploy/helm/atf/Chart.yaml"), umbrellaChart(oldVersion));
		writeFileSync(
			join(dir, "deploy/helm/atf/charts/runtime/Chart.yaml"),
			subchart("runtime", oldVersion),
		);
		writeFileSync(
			join(dir, "deploy/helm/atf/charts/atf-common/Chart.yaml"),
			libraryChart(oldVersion),
		);
	};

	// The declared list covers seven chart files; the fixture only has three,
	// so the test replays the occurrences that apply to those files. The
	// fixture umbrella declares all six dependencies and the fixture service
	// subchart exactly one, matching the declared expected counts.
	const occurrencesForFixture = (): Occurrence[] =>
		HELM_OCCURRENCES.filter((occurrence) =>
			[
				"deploy/helm/atf/Chart.yaml",
				"deploy/helm/atf/charts/runtime/Chart.yaml",
				"deploy/helm/atf/charts/atf-common/Chart.yaml",
			].includes(occurrence.file),
		);

	test("sync mode rewrites chart version, appVersion and dependency constraints", async () => {
		writeTree("0.1.0");
		const { problems, rewritten } = await syncOccurrences(
			occurrencesForFixture(),
			"0.20.0",
			dir,
			false,
		);
		expect(problems).toEqual([]);
		expect(rewritten.length).toBeGreaterThan(0);

		const umbrella = readFileSync(join(dir, "deploy/helm/atf/Chart.yaml"), "utf8");
		expect(umbrella).toBe(umbrellaChart("0.20.0"));
		const runtime = readFileSync(
			join(dir, "deploy/helm/atf/charts/runtime/Chart.yaml"),
			"utf8",
		);
		expect(runtime).toBe(subchart("runtime", "0.20.0"));
		const common = readFileSync(
			join(dir, "deploy/helm/atf/charts/atf-common/Chart.yaml"),
			"utf8",
		);
		expect(common).toBe(libraryChart("0.20.0"));
	});

	test("check mode reports drift without writing", async () => {
		writeTree("0.19.3");
		// Drift only the umbrella chart version, leaving appVersion correct.
		const drifted = umbrellaChart("0.19.3").replace("version: 0.19.3", "version: 0.1.0");
		writeFileSync(join(dir, "deploy/helm/atf/Chart.yaml"), drifted);

		const { problems, rewritten } = await syncOccurrences(
			occurrencesForFixture(),
			"0.19.3",
			dir,
			true,
		);
		expect(rewritten).toEqual([]);
		expect(problems.some((p) => p.includes("Helm chart version declares 0.1.0"))).toBe(true);
		// Nothing was written: the file still holds the drifted version.
		expect(readFileSync(join(dir, "deploy/helm/atf/Chart.yaml"), "utf8")).toBe(drifted);
	});

	test("a restructured dependency block fails loudly instead of passing", async () => {
		writeTree("0.19.3");
		// Drop one dependency from the umbrella chart: the declared count of
		// six no longer matches, which must be reported rather than ignored.
		const shrunk = umbrellaChart("0.19.3").replace(
			/ {2}- name: control\n {4}version: 0\.19\.3\n/,
			"",
		);
		writeFileSync(join(dir, "deploy/helm/atf/Chart.yaml"), shrunk);

		const { problems } = await syncOccurrences(
			occurrencesForFixture(),
			"0.19.3",
			dir,
			true,
		);
		expect(
			problems.some((p) =>
				p.includes("expected 6 occurrence(s) of Helm umbrella dependency version"),
			),
		).toBe(true);
	});
});
