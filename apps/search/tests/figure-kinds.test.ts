// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import { figureKindSchema } from "@atf/extract-contract";
import { FIGURE_KINDS, resolveFigureKinds, unknownFigureKindMessage } from "../src/figure-kinds.js";

describe("figure-kind filter vocabulary", () => {
  it("accepts every stored contract kind as itself", () => {
    for (const kind of figureKindSchema.options) expect(resolveFigureKinds(kind)).toEqual([kind]);
    expect(FIGURE_KINDS).toEqual(figureKindSchema.options);
  });

  it("maps the transcription-format words the tools used to advertise", () => {
    expect(resolveFigureKinds("process")).toEqual(["bpmn", "flowchart"]);
    expect(resolveFigureKinds("drawing")).toEqual(["technical_drawing"]);
    expect(resolveFigureKinds("data")).toEqual(["chart"]);
    expect(resolveFigureKinds("fields")).toEqual(["ui_mask"]);
  });

  it("ignores case, spaces and hyphens", () => {
    expect(resolveFigureKinds(" UI-Mask ")).toEqual(["ui_mask"]);
    expect(resolveFigureKinds("Technical Drawing")).toEqual(["technical_drawing"]);
    expect(resolveFigureKinds("Maske")).toEqual(["ui_mask"]);
  });

  it("rejects a value that names no kind, listing the vocabulary", () => {
    expect(resolveFigureKinds("blueprintz")).toBeNull();
    expect(unknownFigureKindMessage("blueprintz")).toContain("bpmn");
  });
});
