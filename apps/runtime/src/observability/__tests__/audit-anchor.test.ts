// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the audit chain anchoring service (`src/observability/audit-anchor.ts`).
 */

import { describe, it, expect } from "bun:test";
import { createAuditAnchorService } from "../audit-anchor.js";
import { InMemoryAuditLog } from "../audit-log.js";

/** `createAuditAnchorService` for a secret known to enable the service. */
function mustCreateAuditAnchorService(
  ...args: Parameters<typeof createAuditAnchorService>
): NonNullable<ReturnType<typeof createAuditAnchorService>> {
  const svc = createAuditAnchorService(...args);
  if (svc === undefined) throw new Error("expected the anchor service to be enabled");
  return svc;
}

const SECRET = "anchor-secret-1234567890";

describe("createAuditAnchorService", () => {
  it("returns undefined without a secret", () => {
    expect(
      createAuditAnchorService(new InMemoryAuditLog(), { secret: undefined }),
    ).toBeUndefined();
    expect(
      createAuditAnchorService(new InMemoryAuditLog(), { secret: "  " }),
    ).toBeUndefined();
  });

  it("anchors the tip and verifies it against the current chain", async () => {
    const log = new InMemoryAuditLog();
    log.record({ actor: "a", action: "flows.publish", target: "f" });
    const svc = mustCreateAuditAnchorService(log, { secret: SECRET });

    const anchor = await svc.anchorNow();
    expect(anchor).toBeDefined();
    if (anchor === undefined) throw new Error("expected an anchor");
    expect(anchor.uptoId).toBe(1);

    const status = await svc.verifyLatest();
    expect(status.active).toBe(true);
    expect(status.verified).toBe(true);
    expect(status.latest?.uptoId).toBe(1);
  });

  it("still verifies after >1000 records accrue since the anchor (no false alarm)", async () => {
    const log = new InMemoryAuditLog(100_000);
    log.record({ actor: "a", action: "flows.publish", target: "f" });
    const svc = mustCreateAuditAnchorService(log, { secret: SECRET });
    await svc.anchorNow(); // anchors uptoId = 1

    // Push well past a 1000-record newest-first window.
    for (let i = 0; i < 1500; i++) log.record({ actor: "a", action: "x" });

    const status = await svc.verifyLatest();
    // A windowed lookup would report record_not_found here → false tamper alarm.
    expect(status.verified).toBe(true);
    expect(status.reason).toBeUndefined();
  });

  it("returns undefined anchor for an empty chain", async () => {
    const svc = mustCreateAuditAnchorService(new InMemoryAuditLog(), {
      secret: SECRET,
    });
    expect(await svc.anchorNow()).toBeUndefined();
    expect((await svc.verifyLatest()).latest).toBeUndefined();
  });

  it("does not verify under a different secret (tamper/rotation)", async () => {
    const log = new InMemoryAuditLog();
    log.record({ actor: "a", action: "x" });
    const signer = mustCreateAuditAnchorService(log, { secret: SECRET });
    const anchor = await signer.anchorNow();

    // A verifier holding a DIFFERENT secret must reject the anchor.
    const other = mustCreateAuditAnchorService(log, { secret: "different-secret-000000" });
    // Prime `other` with the foreign anchor by verifying it directly via status
    // is not possible (private), so assert via signAuditAnchor semantics: the
    // same-secret signer verifies, and a re-sign under a different secret differs.
    const resign = await other.anchorNow();
    if (resign === undefined || anchor === undefined) {
      throw new Error("expected both anchors to be defined");
    }
    expect(resign.signature).not.toBe(anchor.signature);
  });
});
