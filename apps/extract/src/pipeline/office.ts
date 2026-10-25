// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * office.ts
 *
 * Word and spreadsheet documents to PDF, via headless LibreOffice.
 *
 * Why convert at all instead of parsing OOXML directly: a Word document has no
 * pages until something lays it out. A library like `mammoth` returns the whole
 * document as one unpaginated block, which means no page numbers, no page
 * images, and therefore no citable retrieval and no figure geometry. Routing
 * through PDF buys pagination that matches what a human sees when they open the
 * file, at the cost of a heavyweight dependency. For a spreadsheet the argument
 * is stronger still: the visual grid, merged cells and column widths *are* the
 * information, and only a layout engine knows where the page breaks fall.
 *
 * LibreOffice is the least pleasant part of this service, and two of its
 * behaviours have to be worked around explicitly:
 *
 *  1. **It is not concurrency-safe with a shared user profile.** Two
 *     simultaneous invocations sharing `$HOME` race on the profile lock and one
 *     fails, or worse, hangs. Every invocation therefore gets a private
 *     `-env:UserInstallation` directory. This is the single most common cause of
 *     "conversion works alone, fails under load".
 *
 *  2. **It reports success while producing nothing.** A non-zero exit is not
 *     guaranteed on failure, so the output file's existence is checked
 *     explicitly rather than inferred from the exit code.
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SupportedFormat } from "../formats.js";
import { conversionFailed } from "../errors.js";
import { run, type RunOptions } from "./exec.js";

/**
 * A LibreOffice user profile with macros and external content switched off
 * written as `user/registrymodifications.xcu` before the
 * first start so the very first document conversion already runs hardened.
 *
 * The settings mirror Tools ▸ Options ▸ Security, verified against the
 * LibreOffice schema (`officecfg/registry/schema/org/openoffice/Office/`):
 *
 *  - `Common/Security/Scripting/MacroSecurityLevel=3` (very high) and
 *    `DisableMacrosExecution=true`: a document-embedded macro is the classic
 *    route from "parse this file" to "run this code"; headless conversion has
 *    no user who could confirm a prompt, so execution is off outright.
 *  - `Common/Security/Scripting/BlockUntrustedRefererLinks=true`: blocks links
 *    originating from documents that are not in a trusted location — which,
 *    for this service, is every document.
 *  - `Writer/Content/Update/Link=2` and `Calc/Content/Update/Link=1`: never
 *    update linked content on load. The enum values differ per module (Writer
 *    2=Never, Calc 1=Never — verified against Writer.xcs/Calc.xcs); without
 *    this, a linked `file:///etc/passwd` text section or an external DDE-like
 *    reference is fetched and lands in the produced PDF. Impress has no such
 *    setting; its link handling is covered by the Scripting entries.
 *
 * `oor:op="fuse"` merges with the factory defaults instead of replacing the
 * whole node, so a future image's unrelated defaults survive.
 */
const HARDENED_PROFILE_XCU = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema">
 <item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
 <item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
 <item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
 <item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
 <item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>1</value></prop></item>
</oor:items>
`;

/**
 * Write the hardened profile settings into a fresh profile directory.
 * Exported for tests; {@link convertToPdf} calls it for every private profile.
 */
export async function writeHardenedProfile(profileDir: string): Promise<void> {
  await mkdir(join(profileDir, "user"), { recursive: true });
  await writeFile(
    join(profileDir, "user", "registrymodifications.xcu"),
    HARDENED_PROFILE_XCU,
    "utf8",
  );
}

export interface OfficeConverterOptions {
  /** LIBREOFFICE_BIN. */
  binary: string;
  /** Writable scratch root. */
  workDir: string;
}

/**
 * Convert an office document to PDF and return the path of the result.
 *
 * The input keeps its original extension because LibreOffice selects its import
 * filter from it; handing it an extensionless temporary file makes it guess, and
 * it guesses wrong on XLSX.
 */
export async function convertToPdf(
  source: { buffer: Uint8Array; extension: string },
  options: OfficeConverterOptions & RunOptions,
): Promise<string> {
  const { binary, workDir } = options;
  const inputDir = join(workDir, "office-in");
  const outputDir = join(workDir, "office-out");
  // A private profile per invocation. LibreOffice locks it, so sharing one
  // across concurrent conversions is what makes them fail intermittently.
  const profileDir = join(workDir, `lo-profile-${randomUUID()}`);
  await mkdir(inputDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  // Macros and linked content off before the first document touches this
  // profile.
  await writeHardenedProfile(profileDir);

  // The filename is generated, never taken from the upload: it reaches a process
  // boundary and ends up in an output path.
  const inputPath = join(inputDir, `source${source.extension}`);
  const isHtml = source.extension === ".html" || source.extension === ".htm";
  await writeFile(
    inputPath,
    isHtml ? neutralizeHtmlReferences(source.buffer) : source.buffer,
  );

  await run(
    binary,
    [
      "--headless",
      "--norestore",
      "--invisible",
      "--nolockcheck",
      "--nodefault",
      "--nofirststartwizard",
      `-env:UserInstallation=file://${profileDir}`,
      "--convert-to",
      "pdf",
      "--outdir",
      outputDir,
      inputPath,
    ],
    // HOME is the private profile directory, so nothing is shared between runs.
    profileDir,
    options,
  );

  // Exit code 0 does not imply output, so look for the file.
  const produced = (await readdir(outputDir)).filter((name) =>
    name.toLowerCase().endsWith(".pdf"),
  );
  const first = produced[0];
  if (first === undefined) {
    throw conversionFailed(
      "LibreOffice reported success but produced no PDF. The document is most likely " +
        "password-protected or corrupt.",
      { extension: source.extension },
    );
  }
  return join(outputDir, first);
}

/**
 * Revision of {@link neutralizeHtmlReferences}' output. Part of the derived-PDF
 * cache key for HTML sources: bump it whenever the sanitizer starts producing
 * different bytes, so a PDF rendered from the previous (weaker) rewrite is not
 * served again.
 */
export const HTML_SANITIZER_REVISION = 4;

/**
 * The LibreOffice build identity: the trimmed `--version` line, or `null` when
 * the probe fails or answers nothing (sidecar not up, timeout, empty output).
 * Goes through the configured exec transport, so it works in isolated mode too.
 * Used for the derived-PDF cache key and for the pipeline hash that decides
 * whether a resumed job may mix pages converted by another build.
 */
export async function probeLibreOfficeIdentity(
  binary: string,
  cwd: string,
  options: RunOptions,
): Promise<string | null> {
  try {
    const result = await run(binary, ["--version"], cwd, options);
    const identity = result.stdout.trim();
    return identity === "" ? null : identity;
  } catch {
    return null;
  }
}

/** Attributes whose value LibreOffice may resolve as a resource to load. */
const URL_ATTRIBUTES = new Set([
  "src", "srcset", "href", "background", "poster", "data", "action", "formaction",
  "xlink:href", "lowsrc", "dynsrc", "longdesc", "codebase", "archive", "profile",
  "manifest", "usemap", "cite", "ping",
]);

/** Elements that only exist to embed or load something else; dropped whole. */
const EMBEDDING_ELEMENTS = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "link",
  "base",
  "portal",
  "noscript",
  "noembed",
  "noframes",
  "xmp",
]);

/** Of those, the void ones: no content follows, so nothing to skip to. */
const VOID_EMBEDDING = new Set(["link", "base", "embed"]);

/**
 * Characters that end a token while the sanitizer reads a tag. Deliberately
 * WIDER than the HTML spec's five whitespace characters (TAB, LF, FF, CR,
 * SPACE): all C0 controls, DEL, NEL and NBSP also split here, so a character
 * the sanitizer does not treat as a separator but the renderer's own parser
 * might can never glue two tokens together on our side. Splitting more only
 * ever makes the sanitizer drop more.
 */
function isTokenSpace(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code <= 0x20 || code === 0x7f || code === 0x85 || code === 0xa0;
}

/** A start/end tag name we are willing to re-emit. Anything else is dropped. */
const SAFE_TAG_NAME = /^[a-zA-Z][a-zA-Z0-9:_-]*$/;
/** An attribute name we are willing to re-emit. Anything else is dropped. */
const SAFE_ATTR_NAME = /^[a-zA-Z_:][a-zA-Z0-9_.:-]*$/;

/**
 * Raster image types an inline `data:` URL may carry. SVG is deliberately NOT
 * here: an SVG document can itself reference `file://` / `http://` resources,
 * so `data:image/svg+xml,…` is a nested document, not an inline picture.
 */
const RASTER_DATA_URL = /^data:image\/(?:png|jpe?g|gif|webp|bmp|tiff?)[;,]/i;

/** True where a tag name ends: a token separator, `/` or `>`. */
function isNameEnd(ch: string): boolean {
  return isTokenSpace(ch) || ch === "/" || ch === ">";
}

/** One parsed attribute: the name, and the raw value between the quotes (if any). */
interface HtmlAttr {
  name: string;
  /** The value exactly as written, without its quotes; null for a bare attribute. */
  raw: string | null;
}

/**
 * Parse one start tag from `start` (the `<`). A real tokenizer, not a regex:
 * a quoted attribute value may contain `>` (`<img alt=">" src=…>`), `/` may
 * separate the name from its first attribute (`<img/src=…>`), and a value may
 * be unquoted — a tag regex gets all three wrong, and each mistake was a
 * proven way to smuggle a URL past the old sanitizer.
 */
function parseStartTag(
  html: string,
  start: number,
): { name: string; attrs: HtmlAttr[]; end: number } {
  let i = start + 1;
  const nameStart = i;
  while (i < html.length && !isNameEnd(html.charAt(i))) i += 1;
  const name = html.slice(nameStart, i);
  const attrs: HtmlAttr[] = [];
  for (;;) {
    // Attribute separator: whitespace and stray slashes (`<img/src=…>`).
    while (i < html.length && (isTokenSpace(html.charAt(i)) || html.charAt(i) === "/"))
      i += 1;
    if (i >= html.length) break;
    const c = html.charAt(i);
    if (c === ">") {
      i += 1;
      break;
    }
    const attrStart = i;
    while (
      i < html.length &&
      !isTokenSpace(html.charAt(i)) &&
      !"/>=".includes(html.charAt(i))
    )
      i += 1;
    const attrName = html.slice(attrStart, i);
    if (attrName === "") {
      i += 1; // a stray '=' or similar: skip it, never spin
      continue;
    }
    let j = i;
    while (j < html.length && isTokenSpace(html.charAt(j))) j += 1;
    if (html.charAt(j) === "=") {
      j += 1;
      while (j < html.length && isTokenSpace(html.charAt(j))) j += 1;
      const quote = html.charAt(j);
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, j + 1);
        attrs.push({
          name: attrName,
          raw: html.slice(j + 1, close === -1 ? html.length : close),
        });
        i = close === -1 ? html.length : close + 1;
      } else {
        const valueStart = j;
        while (
          j < html.length &&
          !isTokenSpace(html.charAt(j)) &&
          html.charAt(j) !== ">"
        )
          j += 1;
        attrs.push({ name: attrName, raw: html.slice(valueStart, j) });
        i = j;
      }
    } else {
      attrs.push({ name: attrName, raw: null });
      i = j;
    }
  }
  return { name, attrs, end: i };
}

/** Named character references that matter inside a CSS-carrying attribute. */
const CSS_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Decode the character references an HTML parser resolves in an attribute
 * value BEFORE the CSS parser sees it — `url&#40;http://evil&#41;` is a fetch
 * to LibreOffice even though the raw text has no `url(`.
 */
function decodeHtmlEntities(
  value: string,
  extraNamed: Record<string, string> = {},
): string {
  // Numeric references need no ";" (an HTML parser ends them at the first
  // non-digit, so `&#106avascript:` is `javascript:`); named ones keep it.
  return value.replace(
    /&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31})(;?)/g,
    (all, entity: string, semicolon: string) => {
      if (!entity.startsWith("#") && semicolon !== ";") return all;
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const code = Number.parseInt(entity.slice(2), 16);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
      }
      if (entity.startsWith("#")) {
        const code = Number.parseInt(entity.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
      }
      return extraNamed[entity] ?? CSS_ENTITIES[entity] ?? all;
    },
  );
}

/**
 * Decode CSS escape sequences: `\72` and `\72 ` (hex, optional trailing
 * whitespace) are `r`, so `u\72l(` is `url(` to the CSS parser. Checking for
 * `url(` before this step is the escape hatch the old sanitizer had.
 */
function decodeCssEscapes(css: string): string {
  return css.replace(
    /\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|(.))/g,
    (_all, hex: string | undefined, ch: string | undefined) => {
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
      }
      return ch ?? "";
    },
  );
}

/**
 * CSS functions that load a resource through a URL or string argument without
 * being `url(…)`: `image-set("http://…" 1x)`, `src("…")`, `image("…")`,
 * `cross-fade(…)` and `element(…)` (plus vendor-prefixed spellings). Matched
 * only at an identifier boundary so `background-image(` style property names
 * and custom idents are not touched.
 */
const URL_LOADING_CSS_FUNCTION =
  /(?<![\w-])(?:-(?:webkit|moz|o|ms)-)?(?:image-set|image|cross-fade|src|element)\s*\(/gi;

/**
 * Replace every call of a {@link URL_LOADING_CSS_FUNCTION} with `none`,
 * including nested parentheses and quoted `)` inside strings. An unbalanced
 * call swallows the rest of the run (dropping more is the safe direction).
 */
function stripUrlLoadingCssFunctions(css: string): string {
  let out = "";
  let last = 0;
  for (const match of css.matchAll(URL_LOADING_CSS_FUNCTION)) {
    const start = match.index ?? 0;
    if (start < last) continue; // inside a call already removed
    let depth = 1;
    let quote = "";
    let i = start + match[0].length;
    for (; i < css.length && depth > 0; i += 1) {
      const c = css.charAt(i);
      if (quote !== "") {
        if (c === "\\") i += 1;
        else if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
    }
    out += css.slice(last, start) + "none";
    last = i;
  }
  return out + css.slice(last);
}

/** Neutralise everything in a CSS run that makes the renderer load something. */
function cssSafe(css: string): string {
  // Comments first: they can split a token from its lookahead (`url/*x*/(`),
  // and escapes before the scan: they can spell any character (`u\72l(`).
  const decoded = decodeCssEscapes(css.replace(/\/\*[\s\S]*?\*\//g, " "));
  return stripUrlLoadingCssFunctions(decoded)
    .replace(/@import\b[^;}]*/gi, "")
    .replace(
      /url\s*\(\s*(["']?)(?!data:image\/(?:png|jpe?g|gif|webp|bmp|tiff?)[;,])[^)]*\)/gi,
      "none",
    );
}

/** Re-emit an attribute value inside double quotes. */
function serializeAttr(name: string, raw: string | null): string {
  // `<` and `>` are escaped as well: inside a quoted value they are legal, but
  // a renderer whose tag scanner stops at the first `>` would otherwise see
  // the rest of the value as markup. Escaping is lossless for any parser that
  // decodes character references in attribute values.
  return raw === null
    ? ` ${name}`
    : ` ${name}="${raw.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}"`;
}

/** Escape a rewritten (decoded) value for a double-quoted attribute. */
function escapeAttrValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Split a `srcset` into its URL candidates the way the HTML spec parses it:
 * a URL ends at whitespace or a comma, descriptors run to the next comma. A
 * plain split on `,` would cut every data URI in half at `base64,` and reject
 * an inline image that is perfectly fine.
 */
function srcsetCandidates(value: string): string[] {
  const urls: string[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value.charAt(i))) i += 1;
    let url = "";
    while (i < value.length && !/\s/.test(value.charAt(i))) {
      if (value.charAt(i) === ",") {
        i += 1;
        break;
      }
      url += value.charAt(i);
      i += 1;
    }
    if (url !== "") urls.push(url);
    while (i < value.length && value.charAt(i) !== ",") i += 1;
  }
  return urls;
}

/**
 * Named character references that a link target can hide a scheme behind.
 * `&colon;` writes the `:` and `&Tab;` / `&NewLine;` write whitespace inside
 * `java&#32;script:`; none of them are CSS-relevant, so they are not in
 * `CSS_ENTITIES` and have to be resolved for this check separately.
 */
const LINK_TARGET_ENTITIES: Record<string, string> = {
  colon: ":",
  Tab: "\t",
  NewLine: "\n",
};

/** Schemes that execute or load a document instead of linking to one. */
const SCRIPT_LINK_SCHEMES = ["javascript:", "vbscript:", "data:"];

/**
 * True when an `<a href>` is not a document link but an instruction: the
 * value, after the character references a renderer would resolve and with the
 * control and whitespace characters a URL parser ignores removed, begins with
 * a scripting scheme or `data:`. `jav&#x61;script:` and `java&Tab;script:`
 * reach the browser as `javascript:` even though the raw text looks inert.
 */
function isScriptLinkTarget(raw: string | null): boolean {
  if (raw === null) return false;
  const target = decodeHtmlEntities(raw, LINK_TARGET_ENTITIES)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL and whitespace inside a scheme are stripped by every URL parser, so they must be stripped here too
    .replace(/[\s\x00-\x20]+/g, "")
    .toLowerCase();
  return SCRIPT_LINK_SCHEMES.some((scheme) => target.startsWith(scheme));
}

/** True when every candidate of a `src`/`srcset` value is an inline image. */
function isInlineImageData(key: string, raw: string): boolean {
  const candidates = key === "srcset" ? srcsetCandidates(raw) : [raw];
  return (
    candidates.length > 0 &&
    candidates.every((candidate) =>
      // biome-ignore lint/suspicious/noControlCharactersInRegex: whitespace and NUL can be inserted into a URL to dodge a prefix check and are stripped by every URL parser
      RASTER_DATA_URL.test(candidate.replace(/[\x00-\x20]+/g, "")),
    )
  );
}

/**
 * Remove every reference in an HTML page that LibreOffice could follow while
 * laying it out.
 *
 * LibreOffice's HTML import loads linked images, frames and stylesheets —
 * `http(s)://` as well as `file://`. On a server that is a request forgery
 * (the page decides which internal URL Extract calls) and a local file read
 * (a `file:///etc/…` image or frame lands in the PDF). So before the page
 * reaches LibreOffice:
 *
 *  - script/frame/object/embed/link/base elements are dropped whole, content
 *    included (a `<script>` body is skipped as raw text, exactly as an HTML
 *    parser reads it, so markup inside it never reaches the rewriter);
 *  - every URL-bearing attribute is removed, except a link target on `<a>`
 *    (never fetched, kept as the document's link) and a `data:` image;
 *  - CSS `url(…)` and `@import` are neutralised, in `<style>` and `style=`,
 *    after CSS comments, escape sequences and HTML character references are
 *    resolved — each of those was a proven bypass of a plain text scan.
 *
 * The page is parsed with a tag/attribute tokenizer rather than rewritten
 * with tag regexes: `>` inside a quoted attribute value, `/` as an attribute
 * separator (`<img/src=…>`) and unquoted values all defeat a regex, and each
 * mistake smuggled a URL through. Kept markup is re-serialised from the
 * parsed parts, so what LibreOffice sees is what the sanitizer decided.
 *
 * Beyond the three structural bypasses above, the output is constrained so
 * the renderer's own tokenizer cannot disagree with ours: tag and attribute
 * names must be plain names (anything else drops the element or attribute),
 * the doctype is re-emitted as the bare `<!DOCTYPE html>` (no internal
 * subset, no external identifier), only RASTER `data:` images survive (an SVG
 * document can reference files itself), `image-set()` / `src()` / `image()`
 * style CSS functions are removed along with `url()`, and `<` / `>` inside
 * kept attribute values are escaped.
 *
 * This is a deny-list: an attribute or element the renderer learns to load
 * that is not listed above would pass. It narrows the surface; it is not a
 * substitute for running the converter in `isolated` mode in production.
 *
 * External images therefore do not appear; inline raster `data:` images do. The
 * rewrite is byte-preserving outside the touched markup (latin1 round trip),
 * so a page in any charset keeps its text.
 */
export function neutralizeHtmlReferences(source: Uint8Array): Uint8Array {
  const html = Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString("latin1");
  const out: string[] = [];
  const len = html.length;
  let i = 0;

  /**
   * Locate the end tag `name` at or after `i`, the way an HTML parser reads a
   * raw-text element. `start` is the `<` of `</name`, `end` the index just
   * past its `>`. Null when the document ends first.
   */
  const findCloseTag = (
    name: string,
  ): { start: number; end: number } | null => {
    const pattern = new RegExp(
      `</${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s/>]|$)`,
      "i",
    );
    const match = pattern.exec(html.slice(i));
    if (match === null) return null;
    const start = i + match.index;
    const close = html.indexOf(">", start);
    return { start, end: close === -1 ? len : close + 1 };
  };

  while (i < len) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    if (lt > i) out.push(html.slice(i, lt));

    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      i = close === -1 ? len : close + 3;
      continue;
    }
    if (html.startsWith("<!", lt)) {
      const close = html.indexOf(">", lt);
      const end = close === -1 ? len : close + 1;
      // A doctype is re-emitted as the bare `<!DOCTYPE html>`, never as
      // written: a legacy one can carry an internal subset
      // (`<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>`) or an
      // external identifier, and the first `>` of such a declaration is not
      // its end. The tail of a subset is then ordinary text and harmless.
      if (/^<!doctype\b/i.test(html.slice(lt, end))) out.push("<!DOCTYPE html>");
      i = end;
      continue;
    }
    if (html.startsWith("<?", lt)) {
      const close = html.indexOf(">", lt);
      i = close === -1 ? len : close + 1;
      continue;
    }
    if (html.startsWith("</", lt)) {
      const match = /^<\/([a-zA-Z][^\s/>]*)/.exec(html.slice(lt));
      if (match === null) {
        out.push("<");
        i = lt + 1;
        continue;
      }
      const close = html.indexOf(">", lt);
      i = close === -1 ? len : close + 1;
      const name = (match[1] ?? "").toLowerCase();
      if (EMBEDDING_ELEMENTS.has(name) || name === "style") continue;
      // An end tag whose name is not a plain element name is dropped.
      if (!SAFE_TAG_NAME.test(name)) continue;
      out.push(`</${name}>`);
      continue;
    }
    if (!/[a-zA-Z]/.test(html.charAt(lt + 1))) {
      out.push("<");
      i = lt + 1;
      continue;
    }

    // ── start tag ───────────────────────────────────────────────────────────
    const tag = parseStartTag(html, lt);
    i = tag.end;
    const lower = tag.name.toLowerCase();
    // A tag name with quotes, `=` or other punctuation (`<img"src=http://x>`)
    // is read as one name by an HTML5 tokenizer but may be split differently
    // by the renderer's own parser. The element is dropped, not re-emitted.
    if (!SAFE_TAG_NAME.test(tag.name)) continue;

    if (EMBEDDING_ELEMENTS.has(lower)) {
      // Drop the element; its content is dropped too, up to the matching end
      // tag — a `<script/>` still swallows to `</script>` for a real parser.
      if (!VOID_EMBEDDING.has(lower)) {
        const close = findCloseTag(lower);
        if (close !== null) i = close.end;
        else i = len;
      }
      continue;
    }
    if (lower === "style") {
      // The CSS body runs to `</style>` as raw text; keep the rules, drop the
      // loads. Self-closing or not, a real parser reads raw text here.
      const close = findCloseTag("style");
      const css = html.slice(i, close === null ? len : close.start);
      // cssSafe decodes CSS escapes, which can conjure a `<` out of `\3c`;
      // `<style>` is raw text, so an unescaped `</style` there would end the
      // element early and hand the rest of the body back to the tag parser.
      out.push(
        `<style${filterAttributes(tag, lower)}>${cssSafe(css).replace(/</g, "&lt;")}</style>`,
      );
      i = close === null ? len : close.end;
      continue;
    }
    if (
      lower === "meta" &&
      tag.attrs.some((a) => a.name.toLowerCase() === "http-equiv")
    ) {
      continue; // a refresh is a redirect
    }
    out.push(`<${lower}${filterAttributes(tag, lower)}>`);
  }
  return Buffer.from(out.join(""), "latin1");

  /** The sanitized attribute serialization of a kept tag. */
  function filterAttributes(
    tag: { name: string; attrs: HtmlAttr[] },
    lower: string,
  ): string {
    let s = "";
    for (const attr of tag.attrs) {
      const key = attr.name.toLowerCase();
      // `a"src="…"`-style names would be re-emitted as written; only plain
      // attribute names survive, the attribute (and its value) is dropped
      // otherwise.
      if (!SAFE_ATTR_NAME.test(attr.name)) continue;
      if (key === "style") {
        s += ` style="${escapeAttrValue(cssSafe(decodeHtmlEntities(attr.raw ?? "")))}"`;
        continue;
      }
      if (URL_ATTRIBUTES.has(key)) {
        if (lower === "a" && key === "href") {
          // A link target is kept (it is the document's link, never fetched),
          // unless it is a scripting scheme rather than a link.
          if (!isScriptLinkTarget(attr.raw)) s += serializeAttr(key, attr.raw);
          continue;
        }
        if (
          (key === "src" || key === "srcset") &&
          attr.raw !== null &&
          isInlineImageData(key, attr.raw)
        ) {
          s += serializeAttr(key, attr.raw);
          continue;
        }
        continue;
      }
      s += serializeAttr(key, attr.raw);
    }
    return s;
  }
}

/** The source kinds LibreOffice lays out to PDF before the normal PDF path. */
const LIBREOFFICE_KINDS = new Set<SupportedFormat["kind"]>([
  "word",
  "spreadsheet",
  "presentation",
  "visio",
]);

/** True when a format is converted to PDF by LibreOffice. */
export function isLibreOfficeKind(format: SupportedFormat): boolean {
  return LIBREOFFICE_KINDS.has(format.kind);
}

/**
 * Extension LibreOffice needs to pick the exact import filter.
 *
 * PPTX and VSDX join Word/Excel here: LibreOffice lays each out to PDF and the
 * normal PDF pipeline takes over, so a presentation gets page images and a
 * Visio drawing gets its shape text with no bespoke renderer.
 */
export function officeExtensionFor(format: SupportedFormat): string {
  if (!isLibreOfficeKind(format)) {
    throw new Error(`No Office extension for ${format.label}`);
  }
  const extension = format.extensions[0];
  if (extension === undefined) throw new Error(`No extension registered for ${format.label}`);
  return extension;
}
