// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
  InMemoryTransparencyLog,
  type ReceiptLogSink,
  type SignedTreeHead,
} from "../transparency-log.js";
import { createTreeHeadSealer } from "../tree-head-sealer.js";

async function makeLog(heads: SignedTreeHead[]) {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const sink: ReceiptLogSink = {
    async append() {},
    async saveTreeHead(head) {
      heads.push(head);
    },
  };
  return new InMemoryTransparencyLog(pair.privateKey, "kid-seal", sink);
}

const bytes = (n: number) => new TextEncoder().encode(`receipt-${n}`);

describe("tree-head sealer (Req 15.3 periodic signed tree heads)", () => {
  test("seals and persists only when the log grew since the latest head", async () => {
    const heads: SignedTreeHead[] = [];
    const log = await makeLog(heads);
    const sealer = createTreeHeadSealer(log, 60_000);
    expect(await sealer.sealIfGrown()).toBe(false); // empty log
    await log.append("r-0", bytes(0));
    await log.append("r-1", bytes(1));
    expect(await sealer.sealIfGrown()).toBe(true);
    expect(await sealer.sealIfGrown()).toBe(false); // nothing new
    await log.append("r-2", bytes(2));
    expect(await sealer.sealIfGrown()).toBe(true);
    expect(heads.map((h) => h.treeSize)).toEqual([2, 3]);
  });

  test("the timer seals on its interval and stops cleanly", async () => {
    const heads: SignedTreeHead[] = [];
    const log = await makeLog(heads);
    await log.append("r-0", bytes(0));
    // The interval must stay well above the time one seal takes (async
    // signing plus the sink). With a few milliseconds, a loaded machine lets a
    // second tick start before the first seal has recorded its head, and the
    // same tree size is sealed twice.
    const sealer = createTreeHeadSealer(log, 50);
    sealer.start();
    sealer.start(); // idempotent
    // Wait for the first seal instead of sleeping a fixed time, then stop
    // before the next tick.
    const deadline = Date.now() + 5_000;
    while (heads.length === 0 && Date.now() < deadline) await Bun.sleep(2);
    sealer.stop();
    expect(heads.map((h) => h.treeSize)).toEqual([1]);
    await log.append("r-1", bytes(1));
    await Bun.sleep(20);
    expect(heads.length).toBe(1); // stopped: no further seals
  });
});
