// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Flow files that fail to load (P1-R3).
 *
 * A broken flow file used to leave one line on stderr: readiness stayed green,
 * no metric moved, and a file that was deleted from disk stayed registered (and
 * executable) until the next restart. These tests pin the ledger that the
 * `/health/ready` hint and the `aiperator_flow_load_failures` gauge read, and
 * the removal of a deleted flow file.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Hono } from "hono";
import { createFlowParserService } from "../flow-parser.js";
import {
  clearFlowLoadFailure,
  getFlowLoadFailures,
  recordFlowLoadFailure,
  resetFlowLoadFailures,
} from "../flow-parser/validate.js";
import { createHealthRouter, type ReadinessResponse } from "../../routes/health.js";
import { createMetrics } from "../../observability/metrics.js";

let dir: string;

const flow = (id: string) =>
  JSON.stringify({ id, name: id, nodes: [{ id: "n", type: "llm" }], edges: [] });

beforeEach(() => {
  resetFlowLoadFailures();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-load-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetFlowLoadFailures();
});

describe("load-failure ledger", () => {
  test("a file that does not validate is recorded with file name, reason and first-seen time", async () => {
    fs.writeFileSync(path.join(dir, "good.json"), flow("good"));
    fs.writeFileSync(path.join(dir, "broken.json"), '{ "id": "broken", "nodes": "not-an-array" }');
    const service = createFlowParserService(dir);
    await service.start();
    await service.stop();
    const failures = getFlowLoadFailures();
    expect(failures.map((f) => f.file)).toEqual(["broken.json"]);
    expect(failures[0]?.reason.length).toBeGreaterThan(0);
    expect(Date.parse(failures[0]?.since ?? "")).not.toBeNaN();
    expect(service.getRegistry().get("good")).toBeDefined();
  });

  test("unparseable JSON is recorded too", async () => {
    fs.writeFileSync(path.join(dir, "garbage.json"), "{ not json");
    const service = createFlowParserService(dir);
    await service.start();
    await service.stop();
    expect(getFlowLoadFailures().map((f) => f.file)).toEqual(["garbage.json"]);
  });

  test("a duplicate flow id is a failure of the second file, and the first stays served", async () => {
    fs.writeFileSync(path.join(dir, "a.json"), flow("same"));
    fs.writeFileSync(path.join(dir, "b.json"), flow("same"));
    const service = createFlowParserService(dir);
    await service.start();
    await service.stop();
    const failures = getFlowLoadFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toContain("Duplicate flow ID 'same'");
    expect(service.getRegistry().get("same")).toBeDefined();
  });

  test("a clean directory has no failures", async () => {
    fs.writeFileSync(path.join(dir, "ok.json"), flow("ok"));
    const service = createFlowParserService(dir);
    await service.start();
    await service.stop();
    expect(getFlowLoadFailures()).toEqual([]);
  });

  test("recording again keeps the first-seen time; clearing removes the entry", () => {
    recordFlowLoadFailure("x.json", "first");
    const since = getFlowLoadFailures()[0]?.since;
    recordFlowLoadFailure("x.json", "second");
    expect(getFlowLoadFailures()[0]).toMatchObject({ reason: "second", since });
    clearFlowLoadFailure("x.json");
    expect(getFlowLoadFailures()).toEqual([]);
  });
});

describe("deleted flow files", () => {
  // chokidar scans the directory asynchronously after start(); a change made
  // before that scan finished is invisible to it (no "ready" hook is exposed).
  const settle = () => new Promise((r) => setTimeout(r, 1000));

  async function waitFor(check: () => boolean, ms = 6000): Promise<void> {
    const until = Date.now() + ms;
    while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  }

  test("deleting a flow file removes the flow from the registry", async () => {
    fs.writeFileSync(path.join(dir, "keep.json"), flow("keep"));
    fs.writeFileSync(path.join(dir, "gone.json"), flow("gone"));
    const service = createFlowParserService(dir);
    await service.start();
    try {
      const registry = service.getRegistry();
      expect(registry.get("gone")).toBeDefined();
      await settle();
      fs.rmSync(path.join(dir, "gone.json"));
      await waitFor(() => registry.get("gone") === undefined);
      expect(registry.get("gone")).toBeUndefined();
      expect(registry.get("keep")).toBeDefined();
    } finally {
      await service.stop();
    }
  }, 15_000);

  test("deleting a file that failed to load clears its failure", async () => {
    fs.writeFileSync(path.join(dir, "broken.json"), "{ not json");
    const service = createFlowParserService(dir);
    await service.start();
    try {
      expect(getFlowLoadFailures()).toHaveLength(1);
      await settle();
      fs.rmSync(path.join(dir, "broken.json"));
      await waitFor(() => getFlowLoadFailures().length === 0);
      expect(getFlowLoadFailures()).toEqual([]);
    } finally {
      await service.stop();
    }
  }, 15_000);

  test("fixing a broken file clears its failure", async () => {
    fs.writeFileSync(path.join(dir, "fixme.json"), "{ not json");
    const service = createFlowParserService(dir);
    await service.start();
    try {
      expect(getFlowLoadFailures()).toHaveLength(1);
      await settle();
      fs.writeFileSync(path.join(dir, "fixme.json"), flow("fixme"));
      await waitFor(() => getFlowLoadFailures().length === 0);
      expect(getFlowLoadFailures()).toEqual([]);
      expect(service.getRegistry().get("fixme")).toBeDefined();
    } finally {
      await service.stop();
    }
  }, 15_000);
});

describe("readiness hint and metric", () => {
  const registry = {
    list: () => [{ id: "f", name: "f", nodes: [], edges: [] } as never],
    get: () => undefined,
  } as never;

  async function ready(failures: ReturnType<typeof getFlowLoadFailures>) {
    const app = new Hono();
    app.route("/", createHealthRouter(registry, { flowLoad: () => failures }));
    const res = await app.request("/health/ready");
    return { status: res.status, body: (await res.json()) as ReadinessResponse };
  }

  test("a broken file is a degraded flow_load check but never a 503", async () => {
    const { status, body } = await ready([
      { file: "broken.json", reason: "x", since: new Date().toISOString() },
    ]);
    expect(status).toBe(200);
    expect(body.status).toBe("ready");
    expect(body.checks.flow_load?.status).toBe("degraded");
    expect(body.checks.flow_load?.reason).toContain("broken.json");
  });

  test("no failures: the check is ok", async () => {
    const { body } = await ready([]);
    expect(body.checks.flow_load?.status).toBe("ok");
  });

  test("without a ledger wired there is no flow_load check at all", async () => {
    const app = new Hono();
    app.route("/", createHealthRouter(registry));
    const res = await app.request("/health/ready");
    const body = (await res.json()) as ReadinessResponse;
    expect(body.checks.flow_load).toBeUndefined();
  });

  test("the gauge follows the ledger on every render", () => {
    const metrics = createMetrics(true);
    let count = 0;
    metrics.setFlowLoadFailureProbe?.(() => count);
    expect(metrics.render()).toContain("aiperator_flow_load_failures 0");
    count = 3;
    expect(metrics.render()).toContain("aiperator_flow_load_failures 3");
  });
});
