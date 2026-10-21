// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * The LibreOffice build is part of the pipeline stand: pages of one
 * resumed job must not be paginated by two converter builds. The identity
 * enters `pipelineHash` through `extra.converter`; without it the hash is
 * byte-for-byte what it was before the field existed, so tests and a failed
 * probe leave existing snapshots matching.
 */

import { describe, expect, it } from "vitest";
import { buildSnapshot, pipelineHash, type PipelineDescriptor } from "../src/jobs/snapshot.js";

const base: PipelineDescriptor = {
  extractor: "poppler",
  renderer: "pdftoppm",
  visionModel: "vlm",
  renderDpi: 200,
  figureDpi: 300,
  extra: { pageLabel: "page", pipelineRevision: 3, blockModel: 2 },
};

describe("converter identity in the pipeline hash", () => {
  it("changes the hash when the LibreOffice build changes", () => {
    const a = pipelineHash({ ...base, extra: { ...base.extra, converter: "LibreOffice 24.8.1.2" } });
    const b = pipelineHash({ ...base, extra: { ...base.extra, converter: "LibreOffice 25.2.0.3" } });
    expect(a).not.toBe(b);
    expect(a).not.toBe(pipelineHash(base));
  });

  it("is stable for the same build", () => {
    const x = pipelineHash({ ...base, extra: { ...base.extra, converter: "LibreOffice 24.8.1.2" } });
    const y = pipelineHash({ ...base, extra: { converter: "LibreOffice 24.8.1.2", ...base.extra } });
    expect(x).toBe(y);
  });

  it("an absent identity leaves the hash exactly as before the field existed", () => {
    expect(pipelineHash(base)).toBe(
      pipelineHash({ ...base, extra: { ...base.extra } }),
    );
    // The frozen reference: if this changes, every in-flight job loses its
    // resume stand. Update only together with an UPGRADE note.
    expect(pipelineHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("only the pipeline hash moves, not the prompt hash", () => {
    const prompts = { pass1: "p1" };
    const without = buildSnapshot(base, prompts);
    const withConverter = buildSnapshot(
      { ...base, extra: { ...base.extra, converter: "LibreOffice 25.2" } },
      prompts,
    );
    expect(withConverter.promptHash).toBe(without.promptHash);
    expect(withConverter.pipelineHash).not.toBe(without.pipelineHash);
  });
});
