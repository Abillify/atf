// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "vitest";
import {
  createStdioBridge,
  KeychainBridgeStore,
  LineJsonCodec,
  type BridgeRequest,
} from "./keychain-bridge.js";

describe("Keychain bridge", () => {
  test("decodes split JSON lines and ignores malformed lines", () => {
    const codec = new LineJsonCodec();
    expect(codec.push('{"id":1,"ok":true')).toEqual([]);
    expect(codec.push("}\nnot-json\n{" + '"id":2,"ok":false}\n')).toEqual([
      { id: 1, ok: true },
      { id: 2, ok: false },
    ]);
  });

  test("round-trips a request over the stdio transport", async () => {
    let handler: ((line: string) => void) | undefined;
    const writes: string[] = [];
    const bridge = createStdioBridge(
      (line) => {
        writes.push(line);
        const request = JSON.parse(line) as BridgeRequest;
        handler?.(JSON.stringify({ id: request.id, ok: true, value: "stored" }));
      },
      (next) => {
        handler = next;
        return () => {
          handler = undefined;
        };
      },
    );

    const response = await bridge({ id: 0, op: "get", key: "source:test" });
    expect(response).toEqual({ id: 1, ok: true, value: "stored" });
    expect(JSON.parse(writes[0] as string)).toMatchObject({ id: 1, op: "get", key: "source:test" });
  });

  test("does not fall back when the host rejects a credential operation", async () => {
    const store = new KeychainBridgeStore(async () => ({ id: 1, ok: false, error: "denied" }));
    await expect(store.get("auth:extract:refresh")).rejects.toThrow("denied");
  });
});
