// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * bench-render-window.ts — before/after numbers for the render window.
 *
 * The page renderer used to spawn `pdfinfo` (page size) and `pdftoppm` (raster)
 * once PER PAGE, each re-reading the PDF's cross-reference table. With the
 * render window (`PreparedSource.prefetch`) it spawns one of each per run of
 * pages. This script measures exactly those calls, with the same poppler
 * wrappers the renderer uses, on a generated PDF — no fixture, no model, no
 * network:
 *
 *   per page   readPageSize + renderPage              2 subprocesses per page
 *   window W   readPageSizes + renderPages            2 subprocesses per W pages
 *
 * Usage
 * -----
 *   bun run scripts/bench-render-window.ts [--pages 300] [--windows 4,8,16]
 *       [--dpi 200] [--repeat 3] [--text-lines 40] [--out report.md]
 *
 * Wall-clock numbers depend on the machine, the poppler build and the page
 * content; compare runs on the SAME machine. The subprocess counts do not.
 * Exit code 0 on success; non-zero when poppler is missing.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { readPageSize, readPageSizes, renderPage, renderPages } from "../src/pipeline/pdf.js";
import { buildSyntheticPdf } from "./lib/synthetic-pdf.js";

interface Args {
  pages: number;
  windows: number[];
  dpi: number;
  repeat: number;
  textLines: number;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { pages: 300, windows: [4, 8, 16], dpi: 200, repeat: 3, textLines: 40 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    const number = (): number => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} needs a positive integer`);
      i++;
      return parsed;
    };
    if (flag === "--pages") args.pages = number();
    else if (flag === "--dpi") args.dpi = number();
    else if (flag === "--repeat") args.repeat = number();
    else if (flag === "--text-lines") args.textLines = number();
    else if (flag === "--windows") {
      if (value === undefined) throw new Error("--windows needs a list such as 4,8,16");
      args.windows = value.split(",").map((part) => Number(part.trim()));
      if (args.windows.some((w) => !Number.isInteger(w) || w < 2)) throw new Error("--windows needs integers >= 2");
      i++;
    } else if (flag === "--out") {
      if (value === undefined) throw new Error("--out needs a path");
      args.out = value;
      i++;
    } else throw new Error(`unknown argument ${flag}`);
  }
  return args;
}

interface Row {
  label: string;
  subprocesses: number;
  ms: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dir = await mkdtemp(join(tmpdir(), "atf-bench-render-"));
  try {
    const pdf = join(dir, "bench.pdf");
    await writeFile(pdf, buildSyntheticPdf({ pages: args.pages, lines: args.textLines }));
    const tools = { binDir: null, home: dir };
    // Fail early (and clearly) when poppler is not installed.
    await readPageSize(pdf, 1, tools).then((size) => {
      if (size === null) throw new Error("pdfinfo is not available (install poppler-utils)");
    });

    const runPerPage = async (): Promise<void> => {
      for (let page = 1; page <= args.pages; page++) {
        await readPageSize(pdf, page, tools);
        await renderPage(pdf, page, args.dpi, join(dir, "single"), tools);
      }
    };
    const runWindow = (width: number) => async (): Promise<void> => {
      for (let first = 1; first <= args.pages; first += width) {
        const last = Math.min(args.pages, first + width - 1);
        await readPageSizes(pdf, first, last, tools);
        const rendered = await renderPages(pdf, first, last, args.dpi, join(dir, "window"), tools);
        if (rendered.length !== last - first + 1) {
          throw new Error(`window ${first}-${last} returned ${rendered.length} images`);
        }
      }
    };

    const measure = async (run: () => Promise<void>): Promise<number> => {
      await run(); // warm-up: file cache, dynamic linker
      const samples: number[] = [];
      for (let i = 0; i < args.repeat; i++) {
        const started = performance.now();
        await run();
        samples.push(performance.now() - started);
      }
      return median(samples);
    };

    const rows: Row[] = [{ label: "per page (before)", subprocesses: 2 * args.pages, ms: await measure(runPerPage) }];
    for (const width of args.windows) {
      rows.push({
        label: `window of ${width}`,
        subprocesses: 2 * Math.ceil(args.pages / width),
        ms: await measure(runWindow(width)),
      });
    }

    const base = rows[0]?.ms ?? 1;
    const lines = [
      `Render window benchmark: ${args.pages} pages, ${args.dpi} DPI, ${args.textLines} text lines/page, median of ${args.repeat} run(s)`,
      "",
      "| mode | subprocesses | wall ms | ms/page | vs. per page |",
      "| --- | ---: | ---: | ---: | ---: |",
      ...rows.map(
        (row) =>
          `| ${row.label} | ${row.subprocesses} | ${row.ms.toFixed(0)} | ${(row.ms / args.pages).toFixed(1)} | ${(base / row.ms).toFixed(2)}x |`,
      ),
      "",
    ];
    const report = lines.join("\n");
    process.stdout.write(`${report}\n`);
    if (args.out !== undefined) await writeFile(args.out, report, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
