// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * derived-pdf-cache-key.test.ts
 *
 * The derived-PDF cache key covers the converter identity and the HTML
 * sanitizer revision.
 *
 * `derivedPdfName` (page-renderer.ts) hashes
 * `extension \u0000 converterIdentity [\u0000 html-sanitizer-<revision>]` into
 * the cache file name `<sourceSha256>-<identity>.pdf`. Two properties are
 * pinned here:
 *
 *  (a) the same source digest under a DIFFERENT converter identity (another
 *      `soffice --version`) is a cache miss — the old PDF was produced by a
 *      converter that no longer exists;
 *  (b) the sanitizer revision enters the digest only for `.html`/`.htm`
 *      sources (verified in `derivedPdfName`), so a revision bump misses for
 *      HTML and still hits for DOCX, which is never sanitized.
 *
 * The conversion is mocked (partial vi.mock of the office module); poppler is
 * stubbed through the injectable PdfOps, so the test is hermetic. The
 * SourceStore is the real filesystem one because the point is WHERE the
 * prepared PDF lives.
 */

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Shared mock state (hoisted so the factory can see it): conversion count and
 * the sanitizer revision the mocked module reports. page-renderer reads
 * `HTML_SANITIZER_REVISION` as a live binding inside `derivedPdfName`, so the
 * getter below lets a test bump it between prepares without re-mocking.
 */
const officeState = vi.hoisted(() => ({
	convertCount: 0,
	sanitizerRevision: 3,
}));

vi.mock("../src/pipeline/office.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/pipeline/office.js")>();
	// Dynamic imports: the hoisted factory must not touch the test module's own
	// top-level imports (TDZ).
	const { join } = await import("node:path");
	const { mkdir, writeFile } = await import("node:fs/promises");
	return {
		...actual,
		get HTML_SANITIZER_REVISION() {
			return officeState.sanitizerRevision;
		},
		convertToPdf: async (
			_source: { buffer: Uint8Array; extension: string },
			options: { workDir: string },
		): Promise<string> => {
			officeState.convertCount += 1;
			const outDir = join(options.workDir, "office-out");
			await mkdir(outDir, { recursive: true });
			const outPath = join(outDir, `converted-${officeState.convertCount}.pdf`);
			await writeFile(outPath, Buffer.from("%PDF-1.4\n%stub\n%%EOF\n"));
			return outPath;
		},
	};
});

import {
	createPageRenderer,
	type PageRendererConfig,
	type PdfOps,
} from "../src/jobs/page-renderer.js";
import { createFilesystemSourceStore } from "../src/source-store.js";
import { TINY_PNG, testLogger } from "./helpers.js";

/** The prepared PDF path, or a hard failure — a converted source always has one. */
function pdfPathOf(prepared: { pdfPath: string | null }): string {
	if (prepared.pdfPath === null)
		throw new Error("expected the prepared source to expose a PDF path");
	return prepared.pdfPath;
}

/** A real (tiny) ZIP with a DOCX part — the extension makes it a DOCX. */
const DOCX_BYTES = Buffer.from(
	zipSync({ "word/document.xml": strToU8("<x/>") }),
);

/** An HTML source — the only family the sanitizer revision covers. */
const HTML_BYTES = Buffer.from("<html><body><p>Bericht</p></body></html>\n");

/** Poppler stubbed: no binary is ever spawned through PdfOps. */
const stubPdfOps: PdfOps = {
	async readPdfInfo() {
		return {
			pageCount: 2,
			pageSize: { widthPt: 595, heightPt: 842 },
			encrypted: false,
		};
	},
	async readPageSize() {
		return { widthPt: 595, heightPt: 842 };
	},
	async renderPage(pdfPath, page, dpi) {
		void pdfPath;
		return { buffer: Buffer.from(TINY_PNG), page, dpi };
	},
	async extractPageText() {
		return "stub text";
	},
	async extractDocumentText(_pdfPath, lastPage) {
		return Array.from({ length: lastPage }, (_, i) => `page ${i + 1}`);
	},
	async imageSize() {
		return { width: 1, height: 1 };
	},
};

let scratchRoot: string;
let versionStubPath: string;
const cleanups: Array<() => Promise<void>> = [];

/** Store bytes in a filesystem store at `dir` and return {sha256, store}. */
async function storeBytes(dir: string, bytes: Buffer) {
	const store = createFilesystemSourceStore(dir);
	const { sha256 } = await store.putStream(Readable.from([bytes]));
	return { sha256, store };
}

/**
 * A stand-in `soffice` that answers `--version` — the only call the renderer
 * itself makes, since the conversion is mocked. Its output IS the converter
 * identity, so two different version strings are two different identities.
 */
async function writeVersionStub(
	name: string,
	version: string,
): Promise<string> {
	const path = join(scratchRoot, name);
	await writeFile(path, `#!/bin/sh\necho "${version}"\n`, "utf8");
	await chmod(path, 0o755);
	return path;
}

function rendererFor(
	store: ReturnType<typeof createFilesystemSourceStore>,
	libreofficeBin: string = versionStubPath,
) {
	const config: PageRendererConfig = {
		renderDpi: 200,
		figureDpi: 300,
		tempDir: scratchRoot,
		// The conversion is mocked; only `--version` is really spawned.
		libreofficeBin,
		popplerBinDir: null,
		subprocessTimeoutMs: 30_000,
		derivedPdfCache: true,
	};
	return createPageRenderer({
		config,
		sourceStore: store,
		logger: testLogger,
		pdfOps: stubPdfOps,
	});
}

beforeEach(async () => {
	officeState.convertCount = 0;
	officeState.sanitizerRevision = 3;
	scratchRoot = await mkdtemp(join(tmpdir(), "atf-derived-pdf-key-scratch-"));
	versionStubPath = await writeVersionStub(
		"soffice-stub",
		"LibreOffice 24.8.1.2",
	);
	cleanups.push(() => rm(scratchRoot, { recursive: true, force: true }));
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("derived-PDF cache key", () => {
	it("misses for the same source digest under a different converter identity", async () => {
		const storeDir = join(scratchRoot, "sources");
		const { sha256, store } = await storeBytes(storeDir, DOCX_BYTES);

		const first = await rendererFor(store).prepare({
			sourceSha256: sha256,
			filename: "quelle.docx",
		});
		expect(officeState.convertCount).toBe(1);
		const cachePath = pdfPathOf(first);
		expect(cachePath.startsWith(join(scratchRoot, "derived-pdf"))).toBe(true);
		expect(basename(cachePath)).toContain(sha256);
		await first.close();

		// Same converter, same source: the on-disk cache is reused, no conversion.
		const same = await rendererFor(store).prepare({
			sourceSha256: sha256,
			filename: "quelle.docx",
		});
		expect(pdfPathOf(same)).toBe(cachePath);
		expect(officeState.convertCount).toBe(1);
		await same.close();

		// A newer soffice is a different converter identity: the key changes, so
		// the same source digest converts again into a different cache file.
		const newerStub = await writeVersionStub(
			"soffice-newer",
			"LibreOffice 25.2.0.1",
		);
		const changed = await rendererFor(store, newerStub).prepare({
			sourceSha256: sha256,
			filename: "quelle.docx",
		});
		try {
			expect(officeState.convertCount).toBe(2);
			const changedPath = pdfPathOf(changed);
			expect(changedPath).not.toBe(cachePath);
			expect(changedPath.startsWith(join(scratchRoot, "derived-pdf"))).toBe(
				true,
			);
			// Same source digest, different identity suffix.
			expect(basename(changedPath).startsWith(`${sha256}-`)).toBe(true);
			expect(basename(changedPath)).not.toBe(basename(cachePath));
		} finally {
			await changed.close();
		}
	});

	it("misses for an HTML source when the sanitizer revision is bumped", async () => {
		const storeDir = join(scratchRoot, "sources");
		const { sha256, store } = await storeBytes(storeDir, HTML_BYTES);

		const before = await rendererFor(store).prepare({
			sourceSha256: sha256,
			filename: "bericht.html",
		});
		expect(officeState.convertCount).toBe(1);
		const cachePath = pdfPathOf(before);
		await before.close();

		// The sanitizer changed: a cached HTML derivative must not be reused,
		// because its text was produced by the old sanitizer.
		officeState.sanitizerRevision = 4;
		const after = await rendererFor(store).prepare({
			sourceSha256: sha256,
			filename: "bericht.html",
		});
		try {
			expect(officeState.convertCount).toBe(2);
			expect(pdfPathOf(after)).not.toBe(cachePath);
			expect(
				pdfPathOf(after).startsWith(join(scratchRoot, "derived-pdf")),
			).toBe(true);
		} finally {
			await after.close();
		}
	});

	it("keeps the cache hit for a DOCX source when the sanitizer revision is bumped", async () => {
		// Verified in code: `derivedPdfName` appends the sanitizer suffix only for
		// `.html`/`.htm`. DOCX is never sanitized, so its key is revision-
		// independent — the expectation is a HIT, not a miss.
		const storeDir = join(scratchRoot, "sources");
		const { sha256, store } = await storeBytes(storeDir, DOCX_BYTES);

		const before = await rendererFor(store).prepare({
			sourceSha256: sha256,
			filename: "bericht.docx",
		});
		expect(officeState.convertCount).toBe(1);
		const cachePath = pdfPathOf(before);
		await before.close();

		officeState.sanitizerRevision = 4;
		const after = await rendererFor(store).prepare({
			sourceSha256: sha256,
			filename: "bericht.docx",
		});
		try {
			expect(pdfPathOf(after)).toBe(cachePath);
			expect(officeState.convertCount).toBe(1);
		} finally {
			await after.close();
		}
	});
});
