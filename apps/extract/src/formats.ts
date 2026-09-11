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
  /** Word processing: converted to PDF by LibreOffice, then the PDF path. */
  | "word"
  /** Spreadsheet: converted to PDF by LibreOffice, then the PDF path. */
  | "spreadsheet"
  /** Single raster image: normalised by sharp, no text layer. */
  | "image";

export interface SupportedFormat {
  /** Canonical MIME type. */
  mimeType: string;
  /** Extensions that map to this format, lower-case, with the dot. */
  extensions: string[];
  kind: SourceKind;
  /** Human label for error messages and the UI. */
  label: string;
}

/**
 * The supported set, exactly as specified: PDF, DOCX, XLSX, PNG, JPEG, GIF.
 *
 * Legacy `.doc`/`.xls` are deliberately absent. LibreOffice can open them, but
 * the binary formats are where its parser has the worst track record, and
 * accepting them would mean a wider attack surface for a format nobody asked
 * for.
 */
export const SUPPORTED_FORMATS: readonly SupportedFormat[] = [
  { mimeType: "application/pdf", extensions: [".pdf"], kind: "pdf", label: "PDF" },
  {
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: [".docx"],
    kind: "word",
    label: "Word (DOCX)",
  },
  {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extensions: [".xlsx"],
    kind: "spreadsheet",
    label: "Excel (XLSX)",
  },
  { mimeType: "image/png", extensions: [".png"], kind: "image", label: "PNG" },
  { mimeType: "image/jpeg", extensions: [".jpg", ".jpeg"], kind: "image", label: "JPEG" },
  { mimeType: "image/gif", extensions: [".gif"], kind: "image", label: "GIF" },
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
export type SniffedFamily = "pdf" | "zip" | "png" | "jpeg" | "gif" | "unknown";

/**
 * Identify a byte signature.
 *
 * `zip` is as specific as this can get for OOXML: DOCX and XLSX are both ZIP
 * containers, and telling them apart means reading the container's content
 * types, which is the job of the converter, not of an admission check.
 */
export function sniffFamily(buffer: Uint8Array): SniffedFamily {
  const startsWith = (...bytes: number[]): boolean =>
    bytes.length <= buffer.length && bytes.every((byte, index) => buffer[index] === byte);

  if (startsWith(0x25, 0x50, 0x44, 0x46, 0x2d)) return "pdf"; // %PDF-
  if (startsWith(0x50, 0x4b, 0x03, 0x04)) return "zip"; // PK\x03\x04
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (startsWith(0xff, 0xd8, 0xff)) return "jpeg";
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return "gif"; // GIF8[79]a
  return "unknown";
}

/** Families a format's bytes may legitimately start with. */
const FAMILY_BY_KIND: Record<SourceKind, SniffedFamily> = {
  pdf: "pdf",
  word: "zip",
  spreadsheet: "zip",
  image: "unknown", // resolved per image MIME type below
};

const FAMILY_BY_IMAGE_MIME: Record<string, SniffedFamily> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
};

function expectedFamily(format: SupportedFormat): SniffedFamily {
  if (format.kind === "image") {
    return FAMILY_BY_IMAGE_MIME[format.mimeType] ?? "unknown";
  }
  return FAMILY_BY_KIND[format.kind];
}

/** Format matching a sniffed family, when the family maps to exactly one. */
function formatForFamily(family: SniffedFamily): SupportedFormat | undefined {
  switch (family) {
    case "pdf":
      return BY_MIME.get("application/pdf");
    case "png":
      return BY_MIME.get("image/png");
    case "jpeg":
      return BY_MIME.get("image/jpeg");
    case "gif":
      return BY_MIME.get("image/gif");
    default:
      // `zip` is ambiguous between DOCX and XLSX; `unknown` says nothing.
      return undefined;
  }
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

  if (sniffed === "zip") {
    // DOCX and XLSX are indistinguishable by signature; the declaration or the
    // extension picks, and both candidates are ZIP-shaped so neither can smuggle
    // something else in.
    const candidate = declaredFormat ?? extensionFormat;
    if (candidate !== undefined && expectedFamily(candidate) === "zip") {
      return { ok: true, format: candidate, sniffed };
    }
    return {
      ok: false,
      reason:
        "The file is a ZIP container but neither the Content-Type nor the filename says " +
        "whether it is DOCX or XLSX. Send one of them.",
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
