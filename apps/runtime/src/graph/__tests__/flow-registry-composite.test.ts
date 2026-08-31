// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the composite flow registry (file + online DB overlay).
 */

import { describe, test, expect } from "bun:test";
import {
  createCompositeRegistry,
  createDbFlowSource,
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
