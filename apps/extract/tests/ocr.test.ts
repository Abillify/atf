// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pipeline/ocr.ts: the Tesseract fallback client.
 * The spawn itself goes through the mocked `exec.run`, so these tests cover the
 * client contract — the disabled switch, the file handoff, the size ceiling —
 * without a Tesseract binary on the machine.
 */

import { access, writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOcrClient, OCR_MAX_IMAGE_BYTES, type OcrConfig } from "../src/pipeline/ocr.js";

vi.mock("../src/pipeline/exec.js", () => ({
  run: vi.fn(async () => ({ stdout: "", stderr: "" })),
}));

import { run } from "../src/pipeline/exec.js";

const runMock = vi.mocked(run);

function ocrConfig(overrides: Partial<OcrConfig> = {}): OcrConfig {
  return {
    ocrFallback: "tesseract",
    tesseractBin: "tesseract",
    ocrLang: "deu",
    ...overrides,
  };
}

/** Make the mocked `run` behave like Tesseract: write `<output>.txt`. */
function tesseractWrites(text: string): void {
  runMock.mockImplementation(async (_command, args) => {
    const outputPath = args[1];
    if (outputPath === undefined) throw new Error("no output path in args");
    await writeFile(`${outputPath}.txt`, `${text}\n`, "utf8");
    return { stdout: "", stderr: "" };
  });
}

describe("createOcrClient (task 7.10, requirement 5.11)", () => {
  beforeEach(() => {
    runMock.mockClear();
  });

  it("is disabled by default and refuses to recognise", async () => {
    const client = createOcrClient(ocrConfig({ ocrFallback: "off" }));
    expect(client.enabled).toBe(false);
    await expect(client.recognize(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /OCR_FALLBACK=off/,
    );
    expect(runMock).not.toHaveBeenCalled();
  });

  it("recognises a page image through the tesseract binary", async () => {
    tesseractWrites("Erkannter Seitentext");
    const client = createOcrClient(ocrConfig());
    expect(client.enabled).toBe(true);
    const text = await client.recognize(new Uint8Array([9, 9, 9]));
    expect(text).toBe("Erkannter Seitentext");

    expect(runMock).toHaveBeenCalledTimes(1);
    const [command, args, home, options] = runMock.mock.calls[0] ?? [];
    expect(command).toBe("tesseract");
    // <image> <output-base> -l <lang> --psm 3 — the page PNG in, a text file out.
    expect(args?.[0]).toMatch(/page\.png$/);
    expect(args?.[1]).toMatch(/text$/);
    expect(args?.slice(2)).toEqual(["-l", "deu", "--psm", "3"]);
    // The scratch dir is the HOME, and the OCR-specific timeout applies.
    expect(home).toMatch(/ocr-/);
    expect(options?.timeoutMs).toBe(60_000);
  });

  it("passes the configured binary and language spec through", async () => {
    tesseractWrites("text");
    const client = createOcrClient(
      ocrConfig({ tesseractBin: "/opt/bin/tesseract", ocrLang: "deu+eng" }),
    );
    await client.recognize(new Uint8Array([1]));
    const [command, args] = runMock.mock.calls[0] ?? [];
    expect(command).toBe("/opt/bin/tesseract");
    expect(args).toContain("deu+eng");
  });

  it("forwards the abort signal so a lost lease cancels the OCR run", async () => {
    tesseractWrites("text");
    const controller = new AbortController();
    await createOcrClient(ocrConfig()).recognize(new Uint8Array([1]), {
      signal: controller.signal,
    });
    expect(runMock.mock.calls[0]?.[3]?.signal).toBe(controller.signal);
  });

  it("refuses an image past the size ceiling without spawning", async () => {
    const client = createOcrClient(ocrConfig());
    const huge = new Uint8Array(OCR_MAX_IMAGE_BYTES + 1);
    await expect(client.recognize(huge)).rejects.toThrow(/above the/);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("rejects when the binary fails, leaving the caller the vision error", async () => {
    runMock.mockRejectedValue(new Error("tesseract: not installed"));
    await expect(
      createOcrClient(ocrConfig()).recognize(new Uint8Array([1])),
    ).rejects.toThrow(/not installed/);
  });

  it("removes its scratch dir even when the run fails", async () => {
    runMock.mockRejectedValue(new Error("boom"));
    await expect(
      createOcrClient(ocrConfig()).recognize(new Uint8Array([1])),
    ).rejects.toThrow("boom");
    const workDir = runMock.mock.calls[0]?.[2] ?? "";
    expect(workDir).toMatch(/ocr-/);
    await expect(access(workDir)).rejects.toThrow();
  });
});
