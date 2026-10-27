// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for text tool-call detection. The Qwen-XML sample is the exact
 * shape a local-model responder emitted as its "answer" in trace 01636a1d.
 */

import { describe, expect, test } from "bun:test";
import {
  detectTextToolCall,
  looksLikeTextToolCallPrefix,
} from "../text-tool-call.js";

const QWEN_XML_FROM_TRACE =
  "<tool_call>\n<function=inspect_image>\n<parameter=image>\nimg-1\n</parameter>\n" +
  "<parameter=question>\nWas zeigt dieser Screenshot?\n</parameter>\n</function>\n</tool_call>";

describe("detectTextToolCall", () => {
  test("Qwen XML template call → qwen-xml", () => {
    expect(detectTextToolCall(QWEN_XML_FROM_TRACE)).toEqual({
      detected: true,
      format: "qwen-xml",
    });
  });

  test("Qwen XML call surrounded by prose is still detected", () => {
    expect(
      detectTextToolCall(
        `Ich sehe mir zuerst den Screenshot an.\n\n${QWEN_XML_FROM_TRACE}`,
      ),
    ).toEqual({ detected: true, format: "qwen-xml" });
  });

  test("Hermes JSON template call → hermes", () => {
    const hermes =
      '<tool_call>\n{"name": "vectorsearch__search", "arguments": {"query": "Aktionskennzeichen", "filter": {"doc": "PH"}}}\n</tool_call>';
    expect(detectTextToolCall(hermes)).toEqual({
      detected: true,
      format: "hermes",
    });
    expect(detectTextToolCall(`Suche läuft.\n${hermes}\nDanke.`)).toEqual({
      detected: true,
      format: "hermes",
    });
  });

  test("incomplete template opener → prefix", () => {
    expect(detectTextToolCall("<tool_call>\n<func")).toEqual({
      detected: true,
      format: "prefix",
    });
    expect(detectTextToolCall("  <function=search")).toEqual({
      detected: true,
      format: "prefix",
    });
  });

  test("regular German answer with citations → not detected", () => {
    const answer =
      "**Klassifikation: Neue Anforderung**\n\n" +
      "Die Spezifikation sieht für die offenen Auftragspositionen kein " +
      "Aktionskennzeichen als Filter oder Spalte vor [1]. Die Maske entspricht " +
      "damit dem vereinbarten Umfang [2].\n\n## Quellen\n\n[1] Spezifikation, Kap. 4.2\n[2] Spezifikation, Kap. 4.3";
    expect(detectTextToolCall(answer)).toEqual({ detected: false });
  });

  test("sentence mentioning `tool_call` in backticks → not detected", () => {
    expect(
      detectTextToolCall(
        "Das Feld `tool_call` bzw. `<tool_call>` taucht nur im Rohformat des Modells auf.",
      ),
    ).toEqual({ detected: false });
    expect(
      detectTextToolCall(
        "Beispiel:\n```xml\n<tool_call>\n<function=search>\n<parameter=q>\nx\n</parameter>\n</function>\n</tool_call>\n```",
      ),
    ).toEqual({ detected: false });
  });

  test("empty text → not detected", () => {
    expect(detectTextToolCall("   ")).toEqual({ detected: false });
  });
});

describe("looksLikeTextToolCallPrefix", () => {
  test("possible template openers keep the buffer armed", () => {
    for (const buf of ["", "<", "<tool", "<function=x", "  <tool_call>\n"]) {
      expect(looksLikeTextToolCallPrefix(buf)).toBe(true);
    }
  });

  test("ordinary prose releases the buffer", () => {
    for (const buf of ["Das", "<b>Hinweis</b>", "Ich prüfe <tool_call>"]) {
      expect(looksLikeTextToolCallPrefix(buf)).toBe(false);
    }
  });
});
