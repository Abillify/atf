// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the composite flow registry (file + online DB overlay).
 */

import { describe, test, expect } from "bun:test";
import {
  createCompositeRegistry,
  createDbFlowSource,
  findShadowedFlowIds,
} from "../flow-registry-composite.js";
import { InMemoryFlowStore } from "../flow-store.js";
import type { FlowRegistry } from "../flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";

const def = (id: string, name = id): FlowDefinition => ({
  id,
  name,
  nodes: [{ id: "n", type: "router" }],
  edges: [],
});

function fileRegistry(...flows: FlowDefinition[]): FlowRegistry {
  const m = new Map(flows.map((f) => [f.id, f]));
  return { get: (id) => m.get(id), list: () => [...m.values()] };
}

describe("createCompositeRegistry", () => {
  test("file-only when DB source is empty", () => {
    const store = new InMemoryFlowStore();
    const src = createDbFlowSource(store);
    const reg = createCompositeRegistry(fileRegistry(def("file-flow")), src);
    expect(reg.get("file-flow")?.name).toBe("file-flow");
    expect(reg.list()).toHaveLength(1);
  });

  test("DB-published flow is served and overrides a same-id file flow", async () => {
    const store = new InMemoryFlowStore();
    await store.saveDraft("shared", def("shared", "online-version"));
    await store.publish("shared");
    const src = createDbFlowSource(store);
    await src.refresh();

    const reg = createCompositeRegistry(
      fileRegistry(def("shared", "file-version")),
      src,
    );
    expect(reg.get("shared")?.name).toBe("online-version");
    expect(reg.list()).toHaveLength(1); // merged by id
  });

  test("fully online: file registry empty, flows from DB", async () => {
    const store = new InMemoryFlowStore();
    await store.saveDraft("a", def("a"));
    await store.publish("a");
    await store.saveDraft("b", def("b"));
    await store.publish("b");
    const src = createDbFlowSource(store);
    await src.refresh();

    const reg = createCompositeRegistry(fileRegistry(), src);
    expect(
      reg
        .list()
        .map((f) => f.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  test("drafts are not served (only published)", async () => {
    const store = new InMemoryFlowStore();
    await store.saveDraft("draft-only", def("draft-only"));
    const src = createDbFlowSource(store);
    await src.refresh();
    const reg = createCompositeRegistry(fileRegistry(), src);
    expect(reg.get("draft-only")).toBeUndefined();
  });

  test("refresh picks up newly published flows", async () => {
    const store = new InMemoryFlowStore();
    const src = createDbFlowSource(store);
    const reg = createCompositeRegistry(fileRegistry(), src);
    expect(reg.list()).toHaveLength(0);

    await store.saveDraft("new", def("new"));
    await store.publish("new");
    await src.refresh();
    expect(reg.get("new")?.id).toBe("new");
  });
});

describe("findShadowedFlowIds", () => {
  test("returns the sorted intersection of file and DB flow ids", async () => {
    const store = new InMemoryFlowStore();
    await store.saveDraft("z-shared", def("z-shared"));
    await store.publish("z-shared");
    await store.saveDraft("a-shared", def("a-shared"));
    await store.publish("a-shared");
    const src = createDbFlowSource(store);
    await src.refresh();

    const ids = findShadowedFlowIds(
      fileRegistry(def("a-shared"), def("b-file-only"), def("z-shared")),
      src,
    );
    expect(ids).toEqual(["a-shared", "z-shared"]);
  });

  test("empty when no file flow has a DB twin", async () => {
    const store = new InMemoryFlowStore();
    await store.saveDraft("db-only", def("db-only"));
    await store.publish("db-only");
    const src = createDbFlowSource(store);
    await src.refresh();

    expect(findShadowedFlowIds(fileRegistry(def("file-only")), src)).toEqual(
      [],
    );
  });

  test("empty when the DB has no published flows", () => {
    const src = createDbFlowSource(new InMemoryFlowStore());
    expect(findShadowedFlowIds(fileRegistry(def("a")), src)).toEqual([]);
  });
});
