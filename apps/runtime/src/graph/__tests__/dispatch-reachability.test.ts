// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFlowDispatcher, loadDispatchTable } from "../flow-dispatcher.js";
import type { RequestContext } from "../../types/monitoring.js";

const dir = mkdtempSync(join(tmpdir(), "atf-dispatch-"));
writeFileSync(join(dir, "dispatch.yaml"), `rules:\n  - whenModel: '^helper(?:[-_][a-z0-9_]+)?$'\n    targetFlow: helper\n  - whenModel: '.*'\n    targetFlow: default\n`);
for (const name of ["helper", "default"]) writeFileSync(join(dir, `${name}.yaml`), `id: ${name}\nname: ${name}\nnodes:\n  - id: start\n    type: llm\nedges: []\n`);

const ctx = (): RequestContext => ({ ssoToken: "test", executionId: "test" });

describe("public dispatch fixture", () => {
  test("routes anchored names without shadowing the fallback", () => {
    const dispatcher = createFlowDispatcher(dir);
    expect(dispatcher.resolveFlow("helper", ctx())).toBe("helper");
    expect(dispatcher.resolveFlow("helper_alpha", ctx())).toBe("helper");
    expect(dispatcher.resolveFlow("helpers", ctx())).toBe("default");
    expect(dispatcher.resolveFlow("other", ctx())).toBe("default");
  });

  test("keeps the fallback last and targets available fixture flows", () => {
    const table = loadDispatchTable(dir);
    expect(table.rules.at(-1)?.whenModel).toBe(".*");
    expect(table.rules.map((rule) => rule.targetFlow).sort()).toEqual(["default", "helper"]);
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));
