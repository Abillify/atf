// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pipeline/safe-xml.ts
 *
 * One place to configure every `fast-xml-parser` instance in the service
 * (requirement 5.3): entity processing is switched off, so a user document
 * cannot expand internal entities while parsing — the XXE and Billion-Laughs
 * class of attacks. Every parser in `pipeline/` and `pipeline/native/` is
 * built through {@link safeXmlParser}; a bare `new XMLParser` outside this
 * module is a review finding.
 *
 * ## Why the predefined entities are decoded by hand
 *
 * `processEntities: false` also stops the five *predefined* XML entities
 * (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`) from being decoded — and those
 * are not a risk: they reference nothing, cannot expand recursively, and
 * cannot fetch a resource. Without them, every spreadsheet cell or heading
 * whose text contains an ampersand would keep the literal `&amp;` in the
 * extracted output. So the parser-level entity machinery stays off and the
 * five fixed replacements run in the value processors instead, `&amp;` last —
 * the order that reproduces the single-pass semantics of a conforming
 * parser: `&amp;amp;` decodes to `&amp;`, not `&`, and numeric character
 * references stay raw exactly as with `htmlEntities: false`.
 *
 * Known deviation: a CDATA section containing the literal text `&amp;` is
 * decoded here but left raw by the default parser. No OOXML, BPMN, or poppler
 * writer emits CDATA sections, so the case does not occur in the formats this
 * service reads.
 */

import { XMLParser, type X2jOptions } from "fast-xml-parser";

/** Decode the five predefined XML entities; `&amp;` last, single pass. */
function decodePredefined(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/**
 * An `XMLParser` with entity processing disabled (requirement 5.3) and the
 * five predefined entities decoded in the value processors so ordinary
 * document text is unaffected. All other options are the caller's.
 */
export function safeXmlParser(options: X2jOptions = {}): XMLParser {
  return new XMLParser({
    ...options,
    processEntities: false,
    tagValueProcessor: (_tagName, value) =>
      typeof value === "string" ? decodePredefined(value) : value,
    attributeValueProcessor: (_attrName, value) =>
      typeof value === "string" ? decodePredefined(value) : value,
  });
}

/**
 * True when the XML carries a DOCTYPE declaration. The sequence `<!DOCTYPE`
 * cannot appear as element content in a well-formed document (it would be
 * escaped), so a raw occurrence is a declaration, a comment, or a CDATA
 * section — all of which are rejected for user-supplied XML regardless.
 */
export function hasDoctypeDeclaration(xml: string): boolean {
  return /<!DOCTYPE/i.test(xml);
}
