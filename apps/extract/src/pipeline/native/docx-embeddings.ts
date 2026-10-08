// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pipeline/native/docx-embeddings.ts
 *
 * The objects a Word document embeds — a Visio process, an Excel table, a
 * BPMN file, another Word document — read out of `word/embeddings/` so each
 * can be ingested as a document of its own with its native parser. The render
 * path only sees their preview picture; the child document carries the real
 * process graph, cell values and texts.
 *
 * An embedding is either
 *  - a raw OOXML package (`*.xlsx`, `*.vsdx`, `*.docx`, `*.pptx`), taken as is;
 *  - an OLE object (`oleObject*.bin`, a CFB container) holding
 *     · an `\x01Ole10Native` stream — a "Package" object wrapping any file
 *       (a `.bpmn`, a `.pdf`, …) with its original file name;
 *     · a `Package` stream — an OOXML package embedded through OLE;
 *     · a legacy Word/Excel storage (`WordDocument` / `Workbook`) — the
 *       container itself is the `.doc` / `.xls`.
 * Anything else (an equation, a legacy `.vsd`) is skipped. Preview images in
 * `word/media/` are never children: the render path already has them.
 */

import { unzipSync } from "fflate";
import { ExtractError } from "../../errors.js";
import { assertZipWithinLimits, type ZipLimits } from "./zip-guard.js";
import { readCfb, type CfbEntry } from "./cfb.js";

/** One embedded file, ready to become a child job. */
export interface EmbeddedSource {
	filename: string;
	mimeType: string;
	content: Uint8Array;
	/** Always false; the shape matches an e-mail attachment. */
	inline: false;
}

/** An embedding larger than this is skipped (a child job has its own limits too). */
const MAX_EMBEDDING_BYTES = 200 * 1024 * 1024;

const OOXML_TYPES: Record<string, string> = {
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".xlsm": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".vsdx": "application/vnd.ms-visio.drawing",
};

const BY_EXTENSION: Record<string, string> = {
	...OOXML_TYPES,
	".bpmn": "application/bpmn+xml",
	".pdf": "application/pdf",
	".doc": "application/msword",
	".xls": "application/vnd.ms-excel",
	".eml": "message/rfc822",
	".msg": "application/vnd.ms-outlook",
};

function extensionOf(name: string): string {
	return /(\.[A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
}

function baseName(path: string): string {
	return path.split(/[\\/]/).pop()?.trim() ?? "";
}

/**
 * The OOXML kind of a ZIP package, from its content types. The ZIP guard runs
 * first (requirement 5.1): an embedding that exceeds a limit — a PPTX with no
 * native reader of its own, an XLSX whose child job would only reject later —
 * is rejected here rather than passed on. A buffer that is not a package at
 * all still yields `undefined` so the caller keeps its skip-with-warning path.
 */
function ooxmlExtension(zip: Uint8Array, limits?: ZipLimits): string | undefined {
	let files: Record<string, Uint8Array>;
	try {
    assertZipWithinLimits(zip, limits);
    files = unzipSync(zip, { filter: (f) => f.name === "[Content_Types].xml" });
  } catch (error) {
    if (error instanceof ExtractError) throw error;
    // not a readable package
    return undefined;
  }
  const types = new TextDecoder().decode(
    files["[Content_Types].xml"] ?? new Uint8Array(),
  );
  if (types.includes("spreadsheetml")) return ".xlsx";
  if (types.includes("wordprocessingml")) return ".docx";
  if (types.includes("presentationml")) return ".pptx";
  if (types.includes("ms-visio")) return ".vsdx";
	return undefined;
}

/**
 * Unwrap an `\x01Ole10Native` stream: u32 size, u16 flags, label\0,
 * original path\0, u32 reserved, u32 len + temp path, u32 len + data.
 */
function unwrapOle10Native(bytes: Uint8Array): { filename: string; data: Uint8Array } | null {
	const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let o = 4 + 2;
	const cstr = (): string | null => {
		const end = buf.indexOf(0, o);
		if (end < 0) return null;
		const s = buf.subarray(o, end).toString("latin1");
		o = end + 1;
		return s;
	};
	const label = cstr();
	const original = cstr();
	if (label === null || original === null || o + 8 > buf.length) return null;
	o += 4; // reserved (0x00030000)
	const tempLen = buf.readUInt32LE(o);
	o += 4 + tempLen;
	if (o + 4 > buf.length) return null;
	const dataLen = buf.readUInt32LE(o);
	o += 4;
	if (o + dataLen > buf.length) return null;
	const filename = baseName(label) || baseName(original);
	return { filename, data: buf.subarray(o, o + dataLen) };
}

function fromOle(
  bin: Uint8Array,
  partName: string,
  limits?: ZipLimits,
): EmbeddedSource | null {
  const root: CfbEntry | null = readCfb(bin);
  if (root === null) return null;
  const stem = baseName(partName).replace(/\.[^.]+$/, "");
  const native = root.child("\u0001Ole10Native");
  if (native !== undefined) {
    const unwrapped = unwrapOle10Native(native.read());
    if (unwrapped === null) return null;
    const ext = extensionOf(unwrapped.filename);
    const mimeType = BY_EXTENSION[ext];
    if (mimeType === undefined) return null;
    return {
      filename: unwrapped.filename,
      mimeType,
      content: unwrapped.data,
      inline: false,
    };
  }
  const pkg = root.child("Package");
  if (pkg !== undefined) {
    const data = pkg.read();
    const ext = ooxmlExtension(data, limits);
    if (ext === undefined) return null;
    const mimeType = OOXML_TYPES[ext];
    if (mimeType === undefined) return null;
    return {
      filename: `${stem}${ext}`,
      mimeType,
      content: data,
      inline: false,
    };
  }
  if (root.child("WordDocument") !== undefined) {
    return {
      filename: `${stem}.doc`,
      mimeType: "application/msword",
      content: bin,
      inline: false,
    };
  }
  if (
    root.child("Workbook") !== undefined ||
    root.child("Book") !== undefined
  ) {
    return {
      filename: `${stem}.xls`,
      mimeType: "application/vnd.ms-excel",
      content: bin,
      inline: false,
    };
  }
  return null;
}

/**
 * The embedded files of a DOCX, in part-name order, with warnings for skipped
 * ones. A ZIP-guard violation (`DOCUMENT_TOO_COMPLEX`, requirement 5.1) — in
 * the outer package or in an OOXML embedding, which has no native reader of
 * its own for PPTX — rejects instead of degrading to a warning.
 */
export function extractDocxEmbeddings(
	buffer: Uint8Array,
	limits?: ZipLimits,
): { sources: EmbeddedSource[]; warnings: string[] } {
	const warnings: string[] = [];
	let parts: Record<string, Uint8Array>;
	try {
    // Checked before any inflation (requirement 5.1); a limit violation
    // throws ExtractError and is re-thrown below, never downgraded.
    assertZipWithinLimits(buffer, limits);
    parts = unzipSync(buffer, {
      filter: (f) =>
        f.name.startsWith("word/embeddings/") &&
        f.originalSize <= MAX_EMBEDDING_BYTES,
    });
  } catch (error) {
    if (error instanceof ExtractError) throw error;
    return {
      sources: [],
      warnings: ["the DOCX package could not be read for embedded objects"],
    };
  }
	const sources: EmbeddedSource[] = [];
	for (const name of Object.keys(parts).sort()) {
		const data = parts[name];
		if (data === undefined || data.length === 0) continue;
		const ext = extensionOf(name);
		const ooxml = OOXML_TYPES[ext];
		if (ooxml !== undefined) {
      // A raw OOXML embedding (an embedded PPTX has no native reader of its
      // own; the child job would only guard it later) is checked here so a
      // bomb never becomes a child job (requirement 5.1).
      assertZipWithinLimits(data, limits);
      sources.push({
        filename: baseName(name),
        mimeType: ooxml,
        content: data,
        inline: false,
      });
      continue;
    }
		if (ext === ".bin") {
			const source = fromOle(data, name, limits);
			if (source !== null) sources.push(source);
			else warnings.push(`Embedded object ${baseName(name)} has no readable content; only its preview is indexed`);
			continue;
		}
		const mimeType = BY_EXTENSION[ext];
		if (mimeType !== undefined) sources.push({ filename: baseName(name), mimeType, content: data, inline: false });
	}
	return { sources, warnings };
}
