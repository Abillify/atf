// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * render-subprocess-count.test.ts
 *
 * The subprocess budget of the render path measured over a whole document:
 * how many poppler processes a 600 page job costs when the pages are warmed
 * in windows of eight, and what a DPI change in the middle of the document
 * does to those windows.
 *
 * The counting happens at the `PdfOps` seam, the same seam the other
 * page-renderer tests fake (see `page-renderer-window.test.ts`). Every method
 * of that seam maps to exactly one poppler process in `src/pipeline/pdf.ts`:
 * `readPdfInfo`, `readPageSize` and `readPageSizes` are one `pdfinfo` each,
 * `renderPage` and `renderPages` are one `pdftoppm` each, `extractPageText`
 * and `extractDocumentText` are one `pdftotext` each. There is no `pdfimages`
 * method on the seam and no call to `pdfimages` anywhere in `apps/extract/src`
 * (grep-verified), so the render path cannot spawn it; the text extraction is
 * the text layer of a page, not part of the image render, and is asserted to
 * stay out of the warm-up below.
 *
 * The steady state therefore costs TWO processes per window of eight pages —
 * one `pdfinfo` for the sizes of the window (which is also what picks the DPI)
 * and one `pdftoppm` for its images — instead of the sixteen a page-by-page
 * render needs. The document-level `pdfinfo` (`readPdfInfo`, page count and
 * encryption) runs exactly once while the source is prepared and is counted
 * separately. A single `pdfinfo` for the whole document is not what the
 * prefetch does, and the existing window tests pin the per-window size read
 * (`readPageSizes` is called once per warm-up), so this file pins the real
 * numbers rather than one process per window. The text layer is part of
 * every rendered page (`rawText`), so the vision path reads it once per page.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createPageRenderer,
	type PageRendererConfig,
	type PdfOps,
} from "../src/jobs/page-renderer.js";
import { createFilesystemSourceStore } from "../src/source-store.js";
import { TINY_PNG, testLogger } from "./helpers.js";

/** A4: the adaptive render DPI keeps the configured value. */
const A4 = { widthPt: 595, heightPt: 842 };
/** A0: the adaptive render DPI drops to the floor, so it is not the configured DPI. */
const A0 = { widthPt: 2384, heightPt: 3370 };

const RENDER_DPI = 200;
const PAGES = 600;
const WINDOW = 8;

interface Calls {
	readPdfInfo: number;
	readPageSize: number[];
	readPageSizes: Array<[number, number]>;
	renderPage: Array<[number, number]>;
	renderPages: Array<[number, number, number]>;
	extractPageText: number[];
	extractDocumentText: number[];
}

function freshCalls(): Calls {
	return {
		readPdfInfo: 0,
		readPageSize: [],
		readPageSizes: [],
		renderPage: [],
		renderPages: [],
		extractPageText: [],
		extractDocumentText: [],
	};
}

function stubOps(
	calls: Calls,
	options: {
		pageCount?: number;
		sizeOf?: (page: number) => { widthPt: number; heightPt: number };
	} = {},
): PdfOps {
	const sizeOf = options.sizeOf ?? (() => A4);
	return {
		async readPdfInfo() {
			calls.readPdfInfo++;
			return {
				pageCount: options.pageCount ?? PAGES,
				pageSize: sizeOf(1),
				encrypted: false,
			};
		},
		async readPageSize(_pdf, page) {
			calls.readPageSize.push(page);
			return sizeOf(page);
		},
		async readPageSizes(_pdf, first, last) {
			calls.readPageSizes.push([first, last]);
			const sizes = new Map<number, { widthPt: number; heightPt: number }>();
			for (let page = first; page <= last; page++)
				sizes.set(page, sizeOf(page));
			return sizes;
		},
		async renderPage(_pdf, page, dpi) {
			calls.renderPage.push([page, dpi]);
			return { buffer: Buffer.from(TINY_PNG), page, dpi };
		},
		async renderPages(_pdf, first, last, dpi) {
			calls.renderPages.push([first, last, dpi]);
			return Array.from({ length: last - first + 1 }, (_, i) => ({
				buffer: Buffer.from(TINY_PNG),
				page: first + i,
				dpi,
			}));
		},
		async extractPageText(_pdf, page) {
			calls.extractPageText.push(page);
			return "text";
		},
		async extractDocumentText(_pdf, lastPage) {
			calls.extractDocumentText.push(lastPage);
			return Array.from({ length: lastPage }, () => "text");
		},
		async imageSize() {
			return { width: 1, height: 1 };
		},
	};
}

let scratch: string;
const PDF_BYTES = Buffer.from(
	"%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "atf-render-count-"));
});
afterEach(async () => {
	await rm(scratch, { recursive: true, force: true });
});

async function prepare(ops: PdfOps) {
	const store = createFilesystemSourceStore(join(scratch, "sources"));
	const { sha256 } = await store.putStream(Readable.from([PDF_BYTES]));
	const config: PageRendererConfig = {
		renderDpi: RENDER_DPI,
		figureDpi: 300,
		tempDir: scratch,
		libreofficeBin: "soffice",
		popplerBinDir: null,
		subprocessTimeoutMs: 30_000,
	};
	const renderer = createPageRenderer({
		config,
		sourceStore: store,
		logger: testLogger,
		pdfOps: ops,
	});
	return renderer.prepare({ sourceSha256: sha256, filename: "doc.pdf" });
}

/** The windows the scheduler hands to `prefetch` for a document of `pages` pages. */
function windows(pages: number, size = WINDOW): number[][] {
	const result: number[][] = [];
	for (let first = 1; first <= pages; first += size) {
		const window: number[] = [];
		for (let page = first; page < first + size && page <= pages; page++)
			window.push(page);
		result.push(window);
	}
	return result;
}

describe("render path subprocess budget — 600 pages at one DPI", () => {
	it("costs one pdfinfo for the document and one pdftoppm per window of eight", async () => {
		const calls = freshCalls();
		const prepared = await prepare(stubOps(calls, { pageCount: PAGES }));
		try {
			// The document-level pdfinfo (page count, encryption) is a single call
			// while the source is prepared, before any page is touched.
			expect(calls.readPdfInfo).toBe(1);
			expect(calls.readPageSizes).toEqual([]);
			expect(calls.renderPages).toEqual([]);

			// The scheduler warms a window and the pages are consumed before the
			// next window arrives, which is the steady state of a running job.
			for (const window of windows(PAGES)) {
				await prepared.prefetch?.(window);
				for (const page of window) {
					const rendered = await prepared.render(page);
					expect(rendered.dpi).toBe(RENDER_DPI);
				}
			}

			// 600 pages / 8 = 75 windows, each rendered by exactly one pdftoppm.
			expect(calls.renderPages).toHaveLength(75);
			expect(calls.renderPages[0]).toEqual([1, 8, RENDER_DPI]);
			expect(calls.renderPages[74]).toEqual([593, 600, RENDER_DPI]);
			expect(calls.renderPages.map((entry) => entry.join("-"))).toEqual(
				windows(PAGES).map(
					(window) => `${window[0]}-${window[window.length - 1]}-${RENDER_DPI}`,
				),
			);
			// One pdfinfo per window reads the sizes that pick the DPI; no page is
			// sized or rendered on its own, and no page count is re-read.
			expect(calls.readPageSizes).toHaveLength(75);
			expect(calls.renderPage).toEqual([]);
			expect(calls.readPageSize).toEqual([]);
			expect(calls.readPdfInfo).toBe(1);
			// The text layer is read once per rendered page and never during the
			// image warm-up; the document-wide read belongs to the text path.
			expect(calls.extractPageText).toHaveLength(PAGES);
			expect(calls.extractDocumentText).toEqual([]);
		} finally {
			await prepared.close();
		}
	});

	it("warms a window without touching the text layer at all", async () => {
		const calls = freshCalls();
		const prepared = await prepare(stubOps(calls, { pageCount: PAGES }));
		try {
			await prepared.prefetch?.([1, 2, 3, 4, 5, 6, 7, 8]);
			await prepared.prefetch?.([9, 10, 11, 12, 13, 14, 15, 16]);
			expect(calls.renderPages).toEqual([
				[1, 8, RENDER_DPI],
				[9, 16, RENDER_DPI],
			]);
			// No pdftotext in the vision path: the warm-up only spawns pdfinfo and
			// pdftoppm. (pdfimages is not on the PdfOps seam at all.)
			expect(calls.extractPageText).toEqual([]);
			expect(calls.extractDocumentText).toEqual([]);
		} finally {
			await prepared.close();
		}
	});
});

describe("render path subprocess budget — DPI change after page 100", () => {
	// Pages 1-100 are A4 and render at the configured DPI; pages 101-600 are A0
	// sheets, whose adaptive DPI sits at the floor. A window renders with a
	// single -r, so the windows split at the boundary: 13 windows cover pages
	// 1-100 (12 full ones plus the short tail 97-100) and 63 windows cover the
	// sheets at their adaptive DPI (62 full ones plus 593-600, the boundary
	// window 97-104 being split into 97-100 and 101-104) — ⌈100/8⌉ + ⌈500/8⌉ =
	// 76 pdftoppm calls. The adaptive DPI bounds the pixels of every sheet, so
	// a window of sheets holds no more than a window of ordinary pages would.
	// The sizes a window's pdfinfo read are reused: no sheet is sized again.
	const sizeOf = (page: number) => (page <= 100 ? A4 : A0);

	it("splits the windows at the boundary and windows the oversized sheets at their own DPI", async () => {
		const calls = freshCalls();
		const prepared = await prepare(
			stubOps(calls, { pageCount: PAGES, sizeOf }),
		);
		try {
			// Prefetch and consume window by window, as a running job does: the
			// warm cache holds sixteen pages, so a window is read before the next
			// one pushes it out.
			for (const window of windows(PAGES)) {
				await prepared.prefetch?.(window);
				for (const page of window) {
					const rendered = await prepared.render(page);
					if (page <= 100) expect(rendered.dpi).toBe(RENDER_DPI);
					else expect(rendered.dpi).toBeLessThan(RENDER_DPI);
				}
			}

			const a4Windows = calls.renderPages.filter(([, , dpi]) => dpi === RENDER_DPI);
			const sheetWindows = calls.renderPages.filter(([, , dpi]) => dpi !== RENDER_DPI);
			expect(calls.renderPages).toHaveLength(76);
			expect(a4Windows).toHaveLength(13);
			expect(a4Windows.at(-1)).toEqual([97, 100, RENDER_DPI]);
			expect(sheetWindows).toHaveLength(63);
			expect(sheetWindows[0]).toEqual([101, 104, 72]);
			expect(sheetWindows.at(-1)).toEqual([593, 600, 72]);
			expect(a4Windows.some(([, to]) => to > 100)).toBe(false);
			expect(sheetWindows.some(([from]) => from <= 100)).toBe(false);
			// Every window still reads its sizes once — that read is what finds the
			// boundary — and no page is sized or rendered on its own.
			expect(calls.readPageSizes).toHaveLength(75);
			expect(calls.readPdfInfo).toBe(1);
			expect(calls.readPageSize).toEqual([]);
			expect(calls.renderPage).toEqual([]);
			expect(calls.extractPageText).toHaveLength(PAGES);
			expect(calls.extractDocumentText).toEqual([]);
		} finally {
			await prepared.close();
		}
	});

	it("still renders a single sheet between ordinary pages on its own, without a second pdfinfo", async () => {
		const calls = freshCalls();
		const prepared = await prepare(
			stubOps(calls, { pageCount: 16, sizeOf: (page) => (page === 5 ? A0 : A4) }),
		);
		try {
			await prepared.prefetch?.([1, 2, 3, 4, 5, 6, 7, 8]);
			const sheet = await prepared.render(5);
			expect(sheet.dpi).toBeLessThan(RENDER_DPI);
			expect(calls.renderPage).toEqual([[5, 72]]);
			expect(calls.readPageSize).toEqual([]);
			expect(await prepared.pageSizePt(5)).toEqual(A0);
			expect(calls.readPageSize).toEqual([]);
		} finally {
			await prepared.close();
		}
	});
});
