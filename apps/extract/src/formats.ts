// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * formats.ts
 *
 * The supported-input registry, and the decision about what a given upload
 * actually is.
 *
 * Three sources disagree about the type of an uploaded file, routinely:
 *
 *  - the **declared** `Content-Type`. Browsers send
 *    `application/octet-stream` for `.docx` often enough that treating the
 *    declaration as authoritative rejects valid uploads; curl users send
 *    whatever they typed.
 *  - the **filename extension**. Present and usually right, but trivially
 *    wrong or absent, and attacker-controlled.
 *  - the **magic bytes**. Authoritative for what the parser will actually see,
 *    but cannot tell `.docx` from `.xlsx` — both are ZIP containers.
 *
 * So none of the three is sufficient alone, and this module combines them with
 * an explicit precedence instead of leaving the choice to whichever code path
 * happens to run first.
 *
 * Sniffing is not decoration. Without it, a `.zip` renamed to `.pdf` reaches
 * `pdfinfo`, which fails with a message about a damaged file — sending an
 * operator to look for a converter bug instead of telling the caller their file
 * is not a PDF. Worse, handing arbitrary bytes to LibreOffice because the
 * extension said `.docx` widens a document-parser attack surface for no reason.
 */

/** How a source is turned into pages. */
export type SourceKind =
  /** Native PDF: text layer via poppler, pages rasterised by pdftoppm. */
  | "pdf"
  /**
   * Word processing: converted to PDF by LibreOffice, then the PDF path. HTML
   * belongs here too — LibreOffice Writer lays it out — after its external
   * references are stripped (pipeline/office.ts).
   */
  | "word"
  /** Spreadsheet: converted to PDF by LibreOffice, then the PDF path. */
  | "spreadsheet"
  /** Presentation (PPTX): converted to PDF by LibreOffice, then the PDF path. */
  | "presentation"
  /** Visio drawing (VSDX): converted to PDF by LibreOffice, then the PDF path. */
  | "visio"
  /**
   * BPMN 2.0 XML: parsed natively into a `process` transcription, with no
   * rendering and no model call. The original XML is kept as a
   * `native:` asset.
   */
  | "bpmn"
  /**
   * E-mail (RFC 5322 `.eml`): parsed natively into one page per message, with
   * no rendering and no model call. Attachments become their own jobs.
   */
  | "email"
  /** Single raster image: normalised by sharp, no text layer. */
  | "image";

export interface SupportedFormat {
  /** Canonical MIME type. */
  mimeType: string;
  /** Extensions that map to this format, lower-case, with the dot. */
  extensions: string[];
  kind: SourceKind;
  /** Byte-signature family required before the parser may see the upload. */
  family: Exclude<SniffedFamily, "unknown">;
  /** Human label for error messages and the UI. */
  label: string;
}

/** Formats supported by the consolidated Extract service. */
export const SUPPORTED_FORMATS: readonly SupportedFormat[] = [
  { mimeType: "application/pdf", extensions: [".pdf"], kind: "pdf", family: "pdf", label: "PDF" },
  {
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: [".docx"],
    kind: "word",
    family: "zip",
    label: "Word (DOCX)",
  },
  {
    mimeType: "text/html",
    extensions: [".html", ".htm"],
    kind: "word",
    family: "html",
    label: "HTML",
  },
  {
    mimeType: "application/msword",
    extensions: [".doc"],
    kind: "word",
    family: "ole",
    label: "Word (DOC)",
  },
  {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extensions: [".xlsx"],
    kind: "spreadsheet",
    family: "zip",
    label: "Excel (XLSX)",
  },
  {
    mimeType: "application/vnd.ms-excel",
    extensions: [".xls"],
    kind: "spreadsheet",
    family: "ole",
    label: "Excel (XLS)",
  },
  {
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extensions: [".pptx"],
    kind: "presentation",
    family: "zip",
    label: "PowerPoint (PPTX)",
  },
  {
    mimeType: "application/vnd.ms-visio.drawing",
    extensions: [".vsdx"],
    kind: "visio",
    family: "zip",
    label: "Visio (VSDX)",
  },
  {
    // BPMN 2.0 is an XML dialect; the OMG registers this type for it. The bytes
    // are an XML document, not a ZIP or OLE container, so its family is `xml`.
    mimeType: "application/bpmn+xml",
    extensions: [".bpmn"],
    kind: "bpmn",
    family: "xml",
    label: "BPMN 2.0 (XML)",
  },
  {
    // Outlook's own format: a CFB (OLE) container of MAPI properties, parsed
    // natively like an .eml (pipeline/native/msg.ts).
    mimeType: "application/vnd.ms-outlook",
    extensions: [".msg"],
    kind: "email",
    family: "ole",
    label: "Outlook (MSG)",
  },
  {
    mimeType: "message/rfc822",
    // An mbox export is sniffed as e-mail too and split into its messages.
    extensions: [".eml", ".mbox"],
    kind: "email",
    family: "email",
    label: "E-Mail (EML)",
  },
  { mimeType: "image/png", extensions: [".png"], kind: "image", family: "png", label: "PNG" },
  { mimeType: "image/jpeg", extensions: [".jpg", ".jpeg"], kind: "image", family: "jpeg", label: "JPEG" },
  { mimeType: "image/gif", extensions: [".gif"], kind: "image", family: "gif", label: "GIF" },
  { mimeType: "image/tiff", extensions: [".tif", ".tiff"], kind: "image", family: "tiff", label: "TIFF" },
  { mimeType: "image/bmp", extensions: [".bmp"], kind: "image", family: "bmp", label: "BMP" },
  { mimeType: "image/webp", extensions: [".webp"], kind: "image", family: "webp", label: "WebP" },
];

const BY_MIME = new Map(SUPPORTED_FORMATS.map((format) => [format.mimeType, format]));
const BY_EXTENSION = new Map(
  SUPPORTED_FORMATS.flatMap((format) =>
    format.extensions.map((extension) => [extension, format] as const),
  ),
);

/** Accepted MIME types, for an `Accept`-style listing and the upload widget. */
export function supportedMimeTypes(): string[] {
  return SUPPORTED_FORMATS.map((format) => format.mimeType);
}

/** Accepted extensions, for the file picker's `accept` attribute. */
export function supportedExtensions(): string[] {
  return SUPPORTED_FORMATS.flatMap((format) => format.extensions);
}

/** Human-readable list for error messages. */
export function supportedFormatsLabel(): string {
  return SUPPORTED_FORMATS.map((format) => format.label).join(", ");
}

/** Coarse family a byte signature identifies. */
export type SniffedFamily =
  | "pdf"
  | "zip"
  | "ole"
  | "xml"
  | "html"
  | "email"
  | "png"
  | "jpeg"
  | "gif"
  | "tiff"
  | "bmp"
  | "webp"
  | "unknown";

/** Identify a byte signature without trusting caller-controlled metadata. */
export function sniffFamily(buffer: Uint8Array): SniffedFamily {
  const startsWith = (...bytes: number[]): boolean =>
    bytes.length <= buffer.length && bytes.every((byte, index) => buffer[index] === byte);

  if (startsWith(0x25, 0x50, 0x44, 0x46, 0x2d)) return "pdf"; // %PDF-
  if (startsWith(0x50, 0x4b, 0x03, 0x04)) return "zip"; // PK\x03\x04, OOXML
  if (startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return "ole";
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (startsWith(0xff, 0xd8, 0xff)) return "jpeg";
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return "gif"; // GIF8[79]a
  if (startsWith(0x49, 0x49, 0x2a, 0x00) || startsWith(0x4d, 0x4d, 0x00, 0x2a)) return "tiff";
  if (startsWith(0x42, 0x4d)) return "bmp";
  if (
    startsWith(0x52, 0x49, 0x46, 0x46) &&
    buffer.length >= 12 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) return "webp";
  // Before the XML check: `<html` would otherwise pass as an XML root element.
  if (looksLikeHtml(buffer)) return "html";
  if (looksLikeXml(buffer)) return "xml"; // BPMN 2.0 and other plain-XML dialects
  if (looksLikeEmail(buffer)) return "email";
  return "unknown";
}

/** Header fields that mark an RFC 5322 message; two of them must appear. */
const EMAIL_HEADER_NAMES = new Set([
  "from", "to", "cc", "subject", "date", "message-id", "received", "return-path",
  "mime-version", "delivered-to", "reply-to", "in-reply-to", "references", "sender",
  "thread-index", "thread-topic", "content-type",
]);

/**
 * Recognise an RFC 5322 message: its head is a block of `Name: value` header
 * fields (with folded continuation lines) that includes at least two of the
 * usual message headers, one of them `From`, `Date`, `Subject` or
 * `Message-ID`. Only the first 16 KiB are read, and any line that is not a
 * header field before the blank line ends the check negatively.
 */
function looksLikeEmail(buffer: Uint8Array): boolean {
  const head = Buffer.from(buffer.buffer, buffer.byteOffset, Math.min(buffer.byteLength, 16_384))
    .toString("latin1")
    .replace(/^\uFEFF|^\xEF\xBB\xBF/, "");
  const lines = head.split(/\r?\n/);
  let known = 0;
  let core = false;
  let fields = 0;
  for (const line of lines) {
    if (line === "") break; // end of the header block
    if (/^[ \t]/.test(line)) {
      if (fields === 0) return false;
      continue; // folded continuation
    }
    // mbox "From " separator line before the first header.
    if (fields === 0 && line.startsWith("From ")) continue;
    const match = /^([!-9;-~]+):/.exec(line);
    if (match === null) return false;
    fields++;
    const name = (match[1] ?? "").toLowerCase();
    if (EMAIL_HEADER_NAMES.has(name)) known++;
    if (name === "from" || name === "date" || name === "subject" || name === "message-id") core = true;
    if (fields > 400) break;
  }
  return known >= 2 && core;
}

/**
 * Recognise an HTML page: after a BOM, whitespace and comments the document
 * opens with `<!DOCTYPE html` or `<html`, or it is XHTML (`<?xml …?>` followed
 * by an `<html` root). Only the first 4 KiB are read. Checked after every
 * binary signature, so no container format reaches it.
 */
function looksLikeHtml(buffer: Uint8Array): boolean {
  let head = Buffer.from(buffer.buffer, buffer.byteOffset, Math.min(buffer.byteLength, 4096))
    .toString("latin1")
    .replace(/^\xEF\xBB\xBF/, "")
    .toLowerCase();
  // Leading whitespace and comments.
  for (;;) {
    const trimmed = head.replace(/^\s+/, "");
    if (!trimmed.startsWith("<!--")) {
      head = trimmed;
      break;
    }
    const end = trimmed.indexOf("-->");
    if (end < 0) return false;
    head = trimmed.slice(end + 3);
  }
  if (head.startsWith("<!doctype html") || /^<html[\s>]/.test(head)) return true;
  // XHTML: an XML declaration, then (possibly after a doctype) the html root.
  return head.startsWith("<?xml") && /<html[\s>]/.test(head) && !/<(bpmn|definitions)[\s:>]/.test(head);
}

/**
 * Recognise a plain-XML document (no ZIP/OLE container). Checked last, after
 * every binary container signature, so a `.docx`/`.xlsx`/`.pptx` ZIP never
 * reaches it. An XML file may lead with a UTF-8/UTF-16 BOM and any amount of
 * whitespace before `<?xml …` or a root element `<name`, so the leading bytes
 * are skipped before the marker is checked. Only the head is inspected.
 */
function looksLikeXml(buffer: Uint8Array): boolean {
  let index = 0;
  // Skip a UTF-8 BOM. (UTF-16 BOMs would put NUL bytes between characters,
  // which the ASCII marker check below tolerates via the same skip.)
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) index = 3;
  else if (buffer[0] === 0xff && buffer[1] === 0xfe) index = 2;
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) index = 2;
  // Skip leading whitespace and any interleaved NUL from a UTF-16 encoding.
  const isSkippable = (byte: number | undefined): boolean =>
    byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x00;
  while (index < buffer.length && index < 64 && isSkippable(buffer[index])) index++;
  const at = (offset: number): number | undefined => buffer[index + offset];
  // `<?xml` — an XML declaration.
  if (at(0) === 0x3c && at(1) === 0x3f) return true; // "<?"
  // A root element `<name` or `<ns:name`: `<` followed by a name-start char.
  if (at(0) === 0x3c) {
    const next = at(1);
    if (next === undefined) return false;
    const isNameStart =
      (next >= 0x41 && next <= 0x5a) || // A-Z
      (next >= 0x61 && next <= 0x7a) || // a-z
      next === 0x5f; // _
    return isNameStart;
  }
  return false;
}

/**
 * Follow the CFB FAT and directory chains and return every stream name.
 *
 * DOC, XLS, MSI, MSG and legacy PPT share the same OLE signature. Requiring the
 * primary Word/Excel stream prevents a renamed arbitrary compound file from
 * reaching LibreOffice. Directory entries may span several non-contiguous
 * sectors, so checking only the first directory sector rejects valid files.
 */
function oleDirectoryStreams(buffer: Uint8Array): Set<string> {
  const streams = new Set<string>();
  if (buffer.byteLength < 512) return streams;
  const view = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.readUInt16LE(28) !== 0xfffe) return streams;
  const sectorShift = view.readUInt16LE(30);
  if (sectorShift !== 9 && sectorShift !== 12) return streams;

  const sectorSize = 2 ** sectorShift;
  const sectorCount = Math.floor(view.byteLength / sectorSize) - 1;
  const sectorOffset = (sector: number): number => (sector + 1) * sectorSize;
  const isRegularSector = (sector: number): boolean => sector >= 0 && sector < sectorCount;
  const readSector = (sector: number): Buffer | undefined => {
    if (!isRegularSector(sector)) return undefined;
    const offset = sectorOffset(sector);
    if (offset + sectorSize > view.byteLength) return undefined;
    return view.subarray(offset, offset + sectorSize);
  };

  const endOfChain = 0xfffffffe;
  const fatSectorMarker = 0xfffffffd;
  const difatSectorMarker = 0xfffffffc;
  const fatSectorIds: number[] = [];
  const seenFatSectors = new Set<number>();
  let invalidFatReference = false;
  const addFatSector = (sector: number): void => {
    if (!isRegularSector(sector)) return;
    if (seenFatSectors.has(sector)) {
      invalidFatReference = true;
      return;
    }
    seenFatSectors.add(sector);
    fatSectorIds.push(sector);
  };
  for (let offset = 76; offset < 512; offset += 4) addFatSector(view.readInt32LE(offset));

  let difatSector = view.readInt32LE(68);
  const difatSectorCount = view.readUInt32LE(72);
  const seenDifat = new Set<number>();
  for (let index = 0; index < difatSectorCount; index++) {
    if (!isRegularSector(difatSector) || seenDifat.has(difatSector)) return streams;
    seenDifat.add(difatSector);
    const sector = readSector(difatSector);
    if (sector === undefined) return streams;
    for (let offset = 0; offset < sectorSize - 4; offset += 4) {
      addFatSector(sector.readInt32LE(offset));
    }
    difatSector = sector.readInt32LE(sectorSize - 4);
  }
  if ((difatSector >>> 0) !== endOfChain || invalidFatReference) return streams;

  const declaredFatSectors = view.readUInt32LE(44);
  if (declaredFatSectors === 0 || fatSectorIds.length !== declaredFatSectors) return streams;
  const fat: number[] = [];
  for (const fatSectorId of fatSectorIds) {
    const sector = readSector(fatSectorId);
    if (sector === undefined) return streams;
    for (let offset = 0; offset < sectorSize; offset += 4) fat.push(sector.readUInt32LE(offset));
  }
  if (fatSectorIds.some((sector) => fat[sector] !== fatSectorMarker)) return streams;
  if ([...seenDifat].some((sector) => fat[sector] !== difatSectorMarker)) return streams;

  let directorySector = view.readInt32LE(48);
  const seenDirectory = new Set<number>();
  for (;;) {
    if (!isRegularSector(directorySector) || seenDirectory.has(directorySector)) return new Set();
    seenDirectory.add(directorySector);
    const sector = readSector(directorySector);
    if (sector === undefined) return new Set();
    for (let offset = 0; offset + 128 <= sectorSize; offset += 128) {
      const nameBytes = sector.readUInt16LE(offset + 64);
      const objectType = sector[offset + 66];
      if (objectType !== 2 || nameBytes < 2 || nameBytes > 64 || nameBytes % 2 !== 0) continue;
      const name = sector.subarray(offset, offset + nameBytes - 2).toString("utf16le");
      if (name !== "") streams.add(name);
    }
    const next = fat[directorySector];
    if (next === endOfChain) return streams;
    if (next === undefined || !isRegularSector(next)) return new Set();
    directorySector = next;
  }
}

function oleMatchesFormat(buffer: Uint8Array, format: SupportedFormat): boolean {
  const streams = oleDirectoryStreams(buffer);
  if (format.mimeType === "application/msword") return streams.has("WordDocument");
  if (format.mimeType === "application/vnd.ms-excel") {
    return streams.has("Workbook") || streams.has("Book");
  }
  if (format.mimeType === "application/vnd.ms-outlook") return isMsgStreams(streams);
  return false;
}

/** An Outlook message: the MAPI property stream plus `__substg1.0_` property streams. */
function isMsgStreams(streams: Set<string>): boolean {
  return streams.has("__properties_version1.0") && [...streams].some((s) => s.startsWith("__substg1.0_"));
}

/** Format matching a sniffed family, when the family maps to exactly one. */
function formatForFamily(family: SniffedFamily): SupportedFormat | undefined {
  const matches = SUPPORTED_FORMATS.filter((format) => format.family === family);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Normalise a filename to a lower-case extension including the dot. */
export function extensionOf(filename: string): string {
  const match = /(\.[A-Za-z0-9]+)$/.exec(filename.trim());
  return match?.[1]?.toLowerCase() ?? "";
}

export interface ResolveFormatInput {
  /** Declared `Content-Type` of the upload, when present. */
  declaredMimeType?: string | undefined;
  /** Original filename, when present. */
  filename?: string | undefined;
  /** First bytes of the upload. The whole buffer is fine; only the head is read. */
  buffer: Uint8Array;
}

export type ResolveFormatResult =
  | { ok: true; format: SupportedFormat; sniffed: SniffedFamily }
  | { ok: false; reason: string };

/**
 * Decide what an upload is.
 *
 * Precedence, and the reasoning behind it:
 *
 *  1. If the bytes identify an unambiguous format, that wins outright. It is the
 *     only source that describes what the converter will actually parse.
 *  2. Otherwise (a ZIP container), fall back to the declared type, then the
 *     extension, to choose between DOCX and XLSX — and require that the choice
 *     is ZIP-shaped, so a declaration cannot route arbitrary bytes into
 *     LibreOffice.
 *  3. A declared type that contradicts unambiguous bytes is reported as a
 *     mismatch rather than silently overridden, because a caller who declared
 *     PDF and sent PNG has a bug worth hearing about.
 */
export function resolveFormat(input: ResolveFormatInput): ResolveFormatResult {
  const sniffed = sniffFamily(input.buffer);
  const declared = input.declaredMimeType?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
  const declaredFormat = declared !== undefined ? BY_MIME.get(declared) : undefined;
  const extension = input.filename !== undefined ? extensionOf(input.filename) : "";
  const extensionFormat = extension !== "" ? BY_EXTENSION.get(extension) : undefined;

  const unambiguous = formatForFamily(sniffed);
  if (unambiguous !== undefined) {
    if (declaredFormat !== undefined && declaredFormat.mimeType !== unambiguous.mimeType) {
      return {
        ok: false,
        reason:
          `Content-Type declares ${declaredFormat.label} but the file content is ` +
          `${unambiguous.label}. Send the correct Content-Type or the correct file.`,
      };
    }
    return { ok: true, format: unambiguous, sniffed };
  }

  if (sniffed === "zip" || sniffed === "ole") {
    // OOXML ZIP and legacy OLE containers are each ambiguous between Word and
    // Excel. A supported declaration or extension resolves the ambiguity, but
    // only within the family proven by the bytes.
    const candidate = declaredFormat ?? extensionFormat;
    if (candidate !== undefined && candidate.family === sniffed) {
      if (sniffed === "ole" && !oleMatchesFormat(input.buffer, candidate)) {
        return {
          ok: false,
          reason:
            `The OLE container does not contain the primary stream required for ${candidate.label}.`,
        };
      }
      return { ok: true, format: candidate, sniffed };
    }
    // An Outlook message is recognisable by its streams alone, so a .msg
    // sent without a name or type still resolves.
    if (sniffed === "ole" && candidate === undefined && isMsgStreams(oleDirectoryStreams(input.buffer))) {
      const msg = BY_MIME.get("application/vnd.ms-outlook");
      if (msg !== undefined) return { ok: true, format: msg, sniffed };
    }
    const names = sniffed === "zip" ? "DOCX or XLSX" : "DOC, XLS or MSG";
    return {
      ok: false,
      reason:
        `The file is a ${sniffed === "zip" ? "ZIP" : "legacy Office OLE"} container but ` +
        `neither the Content-Type nor the filename says whether it is ${names}. Send one of them.`,
    };
  }

  const guess = declaredFormat ?? extensionFormat;
  if (guess !== undefined) {
    return {
      ok: false,
      reason:
        `The file was declared as ${guess.label}, but its content does not match that format.`,
    };
  }
  return {
    ok: false,
    reason: `Unsupported file type. Supported formats: ${supportedFormatsLabel()}.`,
  };
}

/** Look up a supported format by canonical MIME type. */
export function formatByMimeType(mimeType: string): SupportedFormat | undefined {
  return BY_MIME.get(mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "");
}
