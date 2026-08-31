// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for `detectRepeatedTail` (handlers/llm.ts) — the worker-side
 * repetition guard.
 *
 * The guard exists because small local models (e.g. qwen via LM Studio, with
 * enable_thinking + low temperature) can fall into a degenerate loop, emitting
 * the same block thousands of times, never calling a tool. In a synthetic
 * long-running research trace this both wasted ~20 min of generation and — via the
 * harness carryForward — exploded the shared context until the synthesizer
 * overflowed its (100k) context window and returned an empty response.
 *
 * `detectRepeatedTail` flags such a loop mid-stream so the caller can abort the
 * generation and truncate to the first (non-repeated) block.
 */

import { describe, test, expect } from "bun:test";
import { detectRepeatedTail } from "../repetition-guard.js";

describe("detectRepeatedTail", () => {
  test("does not flag short text below the scan threshold", () => {
    const { loop } = detectRepeatedTail("kurzer, normaler Text.");
    expect(loop).toBe(false);
  });

  test("does not flag ordinary non-repeating prose", () => {
    const prose =
      "Die Fachabteilung reagierte auf die Datenanfrage. Das Prüfteam beanstandete " +
      "die unvollstaendige Antwort. Die Kontrollstelle forderte eine " +
      "Stellungnahme an. Der Sachverhalt betrifft synthetische Beispiel- und " +
      "Testdaten. Es folgten mehrere Nachrichten ueber zwei Jahre. ".repeat(
        3,
      );
    const { loop } = detectRepeatedTail(prose);
    expect(loop).toBe(false);
  });

  test("flags a degenerate loop of an identical block", () => {
    const block =
      "ABGEDECKT: LfDI-Beschluss (Volltext [85] und [88]). Bussgeld 50.000 " +
      "Euro. Ich werde nun die Dokumente [85] und [88] im Volltext lesen.\n\n";
    const text = block.repeat(30);
    const { loop, safeLen } = detectRepeatedTail(text);
    expect(loop).toBe(true);
    // Truncates to the first block region, dropping the runaway tail.
    expect(safeLen).toBeLessThan(text.length);
    expect(safeLen).toBeGreaterThan(0);
  });

  test("truncation point keeps only the initial content", () => {
    const block = `${"Y".repeat(300)}\n`;
    const text = block.repeat(10);
    const { loop, safeLen } = detectRepeatedTail(text);
    expect(loop).toBe(true);
    // Keeping <= ~2 blocks worth is a large reduction from 10x.
    expect(safeLen).toBeLessThan(block.length * 3);
  });

  test("ignores a whitespace-only tail (no false positive on newline runs)", () => {
    const text = `Echter Inhalt am Anfang. ${"\n".repeat(1000)}`;
    const { loop } = detectRepeatedTail(text);
    expect(loop).toBe(false);
  });
});
