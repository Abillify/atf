// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pipeline/native/vsdx.ts
 *
 * A native Visio reader: a `.vsdx` in, one contract transcription per Visio page
 * out — a `process` graph when the drawing has connectors, a plain shape-text
 * `markdown` diagram when it does not. No model
 * call: the shape text and the connector graph are read directly from the OOXML
 * package.
 *
 * ## Why native, and why the render still happens
 *
 * A Visio drawing is a graph of shapes we were handed as XML. Asking a vision
 * model to re-derive the boxes and arrows from a rasterised picture of that
 * graph is lossy and wasteful, exactly as it is for BPMN (see `bpmn.ts`). So
 * this reader pulls the structure out of the package: each `visio/pages/pageN.xml`
 * contributes its text-bearing shapes as nodes, and the page's `<Connects>`
 * graph — a connector shape's Begin/End connections resolving to the two shapes
 * it joins — as edges.
 *
 * Unlike BPMN, though, a Visio drawing genuinely benefits from the *picture*:
 * geometry, colour and spatial grouping carry meaning a shape/connector graph
 * cannot. So the design keeps the LibreOffice → PDF render for the page image
 * *in addition to* this native structure ("additionally LibreOffice → PDF for
 * the image"). This module is only the structured half; the render half is unchanged
 * in the page renderer.
 *
 * ## process vs. diagram — the split
 *
 * Requirement 10.4 asks for "shape texts and connectors → `process` or
 * `diagram`". The decision is per page and follows the content:
 *
 *  - A page whose shapes are joined by connectors is a flow: it becomes a
 *    `process` transcription (contract {@link Transcription} `format:"process"`)
 *    with the shape texts as node labels and the `<Connects>` graph as directed
 *    edges, plus a deterministic Mermaid `flowchart TD` — the same shape a BPMN
 *    or flowchart figure carries, so a downstream consumer treats a Visio flow
 *    exactly like a BPMN one.
 *  - A page with shapes but no connectors is a schematic/diagram: there is no
 *    flow to reconstruct, so it becomes a `markdown` transcription that lists
 *    the shape texts (the searchable content) under a `diagram`-kind figure.
 *
 * ## Tolerant and bounded, like the BPMN/XLSX parsers
 *
 * Visio's schema is verbose and tool-dependent: element/attribute casing
 * varies, text lives in `<Text>` interleaved with `<cp>`/`<pp>`/`<tp>`
 * formatting markers, and shapes inherit text from masters. Every field
 * degrades gracefully — a shape with no text is dropped from the node set, a
 * connection that resolves to nothing is ignored, a page that fails to parse
 * yields nothing but a warning. A package that fails to unzip yields an empty
 * result with a warning rather than throwing, so a mis-detected `.vsdx` becomes
 * "no native structure" (the render still runs) instead of a failed job.
 *
 * ## Why fflate + fast-xml-parser
 *
 * A `.vsdx` is an OPC ZIP package, like XLSX. The repo already unzips with
 * `fflate` (MIT) and reads XML with `fast-xml-parser` (both existing
 * dependencies); no Visio-specific library is added.
 */

import type { Transcription } from "@atf/extract-contract/v2";
import { strFromU8, unzipSync } from "fflate";
import { ExtractError } from "../../errors.js";
import { safeXmlParser } from "../safe-xml.js";
import { assertZipWithinLimits, type ZipLimits } from "./zip-guard.js";

const parser = safeXmlParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  // Strip `r:`/`v:`… prefixes so element and attribute lookups are prefix-agnostic.
  removeNSPrefix: true,
});

/** A node in a Visio page graph: a shape id, its (optional) text label. */
export interface VsdxNode {
	/** The shape's `ID`, unique within its page. */
	id: string;
	/** The shape's text, normalised to a single line (never empty for a node). */
	label: string;
}

/** A directed edge derived from a connector shape's Begin/End connections. */
export interface VsdxEdge {
	from: string;
	to: string;
	/** The connector shape's own text, when it carries a label. */
	label?: string;
}

/** One Visio page, already reduced to its structured content. */
export interface VsdxPage {
	/** The page's `Name`/`NameU`, or a positional fallback (`Seite N`). */
	name: string;
	/**
	 * The transcription for this page: `process` when the page has connectors
	 * (a flow), a shape-text `markdown` otherwise (a schematic/diagram).
	 */
	transcription:
		| Extract<Transcription, { format: "process" }>
		| Extract<Transcription, { format: "markdown" }>;
	/**
	 * Which figure the page maps to: a connected page is a `flowchart`, a
	 * shape-only page is a `diagram` ("process bzw. diagram").
	 */
	figureKind: "flowchart" | "diagram";
}

/** A parsed Visio drawing plus any tolerant-recovery warnings. */
export interface ParsedVsdx {
	pages: VsdxPage[];
	warnings: string[];
}

/** Coerce any fast-xml-parser child to an array (0, 1 or many elements). */
function asArray(value: unknown): unknown[] {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? value : [value];
}

/** Read a string attribute, trimmed, or undefined when absent/empty. */
function attr(node: unknown, name: string): string | undefined {
	if (typeof node !== "object" || node === null) return undefined;
	const value = (node as Record<string, unknown>)[`@_${name}`];
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	const trimmed = String(value).trim();
	return trimmed === "" ? undefined : trimmed;
}

/**
 * Collapse a Visio `<Text>` node to a single line of text.
 *
 * A `<Text>` element interleaves plain text with formatting markers (`<cp>`,
 * `<pp>`, `<tp>`, `<fld>`). fast-xml-parser hands the plain text back as
 * `#text` (a string, or an array when text surrounds a marker) and drops the
 * markers into sibling keys; we take only the text and normalise whitespace.
 */
function shapeText(textNode: unknown): string {
	if (textNode === undefined || textNode === null) return "";
	if (typeof textNode === "string" || typeof textNode === "number") {
		return normalizeLine(String(textNode));
	}
	if (typeof textNode !== "object") return "";
	const parts: string[] = [];
	collectText(textNode, parts);
	return normalizeLine(parts.join(" "));
}

/** Recursively gather every `#text` fragment under a parsed `<Text>` node. */
function collectText(node: unknown, out: string[]): void {
	if (typeof node === "string" || typeof node === "number") {
		out.push(String(node));
		return;
	}
	if (Array.isArray(node)) {
		for (const child of node) collectText(child, out);
		return;
	}
	if (typeof node !== "object" || node === null) return;
	for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
		// Attributes (`@_…`) are formatting metadata, never displayed text.
		if (key.startsWith("@_")) continue;
		if (key === "#text") collectText(value, out);
		else collectText(value, out);
	}
}

/** Normalise a text fragment to a single trimmed line. */
function normalizeLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Escape a label for a Mermaid node body (Mermaid is picky about brackets). */
function mermaidLabel(text: string): string {
	return text
		.replace(/"/g, "'")
		.replace(/[[\]{}()]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Render the page graph to a deterministic `flowchart TD` Mermaid diagram. */
function toMermaid(nodes: VsdxNode[], edges: VsdxEdge[]): string {
	if (nodes.length === 0) return "flowchart TD";
	const alias = new Map<string, string>();
	nodes.forEach((node, index) => {
		alias.set(node.id, `n${index}`);
	});
	const lines: string[] = ["flowchart TD"];
	for (const node of nodes) {
		const id = alias.get(node.id) ?? node.id;
		lines.push(`  ${id}["${mermaidLabel(node.label || node.id)}"]`);
	}
	for (const edge of edges) {
		const from = alias.get(edge.from);
		const to = alias.get(edge.to);
		if (from === undefined || to === undefined) continue;
		const label = edge.label !== undefined ? mermaidLabel(edge.label) : "";
		lines.push(
			label === ""
				? `  ${from} --> ${to}`
				: `  ${from} -->|"${label}"| ${to}`,
		);
	}
	return lines.join("\n");
}

/**
 * Order the nodes into a linear `steps` list by a breadth-first walk from the
 * roots (nodes with no incoming edge) along the edges, appending any unreached
 * nodes at the end so nothing is lost. Deterministic: ties break on the shape
 * order within the page.
 */
function toSteps(nodes: VsdxNode[], edges: VsdxEdge[]): string[] {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const outgoing = new Map<string, string[]>();
	for (const edge of edges) {
		const list = outgoing.get(edge.from) ?? [];
		list.push(edge.to);
		outgoing.set(edge.from, list);
	}
	const hasIncoming = new Set(edges.map((e) => e.to));
	const roots = nodes.filter((n) => !hasIncoming.has(n.id)).map((n) => n.id);
	const seed = roots.length > 0 ? roots : nodes.slice(0, 1).map((n) => n.id);

	const visited = new Set<string>();
	const order: string[] = [];
	const queue = [...seed];
	while (queue.length > 0) {
		const id = queue.shift();
		if (id === undefined || visited.has(id)) continue;
		visited.add(id);
		if (byId.has(id)) order.push(id);
		for (const next of outgoing.get(id) ?? [])
			if (!visited.has(next)) queue.push(next);
	}
	for (const node of nodes) if (!visited.has(node.id)) order.push(node.id);

	return order.map((id) => {
		const node = byId.get(id);
		return node === undefined ? id : node.label || node.id;
	});
}

/**
 * Read every shape on a page into `{ id → text }`, walking nested groups so a
 * shape inside a `<Group>` is not lost. Shapes with no text keep an empty
 * string here (they may still be a connector); the node set drops them later.
 */
function collectShapes(
	shapesNode: unknown,
	into: Map<string, string>,
	order: string[],
): void {
	if (typeof shapesNode !== "object" || shapesNode === null) return;
	for (const shape of asArray((shapesNode as Record<string, unknown>).Shape)) {
		if (typeof shape !== "object" || shape === null) continue;
		const shapeObj = shape as Record<string, unknown>;
		const id = attr(shapeObj, "ID");
		if (id !== undefined && !into.has(id)) {
			into.set(id, shapeText(shapeObj.Text));
			order.push(id);
		}
		// A `<Group>` shape nests further `<Shapes>`; recurse so nested text and
		// ids are available for connector resolution.
		if (shapeObj.Shapes !== undefined) {
			collectShapes(shapeObj.Shapes, into, order);
		}
	}
}

/**
 * Build the edge set from a page's `<Connects>`.
 *
 * Each connector shape is joined to the shapes it links by two `<Connect>`
 * rows: `FromSheet` is the connector's own id in both, `ToSheet` is the shape
 * it touches, and `FromCell` says which end (`BeginX`/`EndX`). Grouping the
 * connections by connector, the `BeginX` end is the edge source and the `EndX`
 * end is the target; a connector with exactly one Begin and one End yields one
 * directed edge. A connector that resolves to fewer than two shapes is dropped.
 */
function collectEdges(
	connectsNode: unknown,
	shapeText: Map<string, string>,
): VsdxEdge[] {
	if (typeof connectsNode !== "object" || connectsNode === null) return [];
	interface Ends {
		begin?: string;
		end?: string;
		other: string[];
	}
	const byConnector = new Map<string, Ends>();
	const orderedConnectors: string[] = [];
	for (const connect of asArray(
		(connectsNode as Record<string, unknown>).Connect,
	)) {
		if (typeof connect !== "object" || connect === null) continue;
		const fromSheet = attr(connect, "FromSheet");
		const toSheet = attr(connect, "ToSheet");
		if (fromSheet === undefined || toSheet === undefined) continue;
		const fromCell = (attr(connect, "FromCell") ?? "").toLowerCase();
		let ends = byConnector.get(fromSheet);
		if (ends === undefined) {
			ends = { other: [] };
			byConnector.set(fromSheet, ends);
			orderedConnectors.push(fromSheet);
		}
		// `BeginX`/`EndX` (or `BeginY`/`EndY`) mark the connector's two ends.
		if (fromCell.startsWith("begin")) ends.begin = toSheet;
		else if (fromCell.startsWith("end")) ends.end = toSheet;
		else ends.other.push(toSheet);
	}

	const edges: VsdxEdge[] = [];
	for (const connectorId of orderedConnectors) {
		const ends = byConnector.get(connectorId);
		if (ends === undefined) continue;
		// Prefer the explicit Begin→End direction; fall back to the first two
		// touched shapes when the ends are unlabelled (some exporters omit the
		// cell name), so a connector still yields an edge in document order.
		const from = ends.begin ?? ends.other[0];
		const to = ends.end ?? (ends.begin !== undefined ? ends.other[0] : ends.other[1]);
		if (from === undefined || to === undefined || from === to) continue;
		const label = shapeText.get(connectorId);
		edges.push({
			from,
			to,
			...(label !== undefined && label !== "" ? { label } : {}),
		});
	}
	return edges;
}

/**
 * Turn one Visio page's XML into a {@link VsdxPage}. Never throws: a page that
 * fails to parse is reported to the caller as `null` so it can warn and skip.
 */
function parsePage(name: string, xml: string): VsdxPage | null {
	let doc: Record<string, unknown>;
	try {
		doc = parser.parse(xml) as Record<string, unknown>;
	} catch {
		return null;
	}
	// The page part's root is `<PageContents>` (page part) or `<Page>`.
	const root =
		(typeof doc.PageContents === "object" && doc.PageContents !== null
			? (doc.PageContents as Record<string, unknown>)
			: undefined) ??
		(typeof doc.Page === "object" && doc.Page !== null
			? (doc.Page as Record<string, unknown>)
			: undefined);
	if (root === undefined) return null;

	const shapeTextById = new Map<string, string>();
	const shapeOrder: string[] = [];
	collectShapes(root.Shapes, shapeTextById, shapeOrder);

	const edges = collectEdges(root.Connects, shapeTextById);

	// Shapes that participate in a connection are structural (connectors and the
	// nodes they join). Nodes are the text-bearing shapes; a connector shape
	// (typically text-free) is not itself a node.
	const connectorIds = new Set<string>();
	for (const connect of asArray(
		typeof root.Connects === "object" && root.Connects !== null
			? (root.Connects as Record<string, unknown>).Connect
			: undefined,
	)) {
		const fromSheet = attr(connect, "FromSheet");
		if (fromSheet !== undefined) connectorIds.add(fromSheet);
	}

	const nodes: VsdxNode[] = [];
	for (const id of shapeOrder) {
		if (connectorIds.has(id)) continue; // the connector shape itself is an edge
		const label = shapeTextById.get(id) ?? "";
		if (label === "") continue; // a text-free, non-connector shape has no searchable content
		nodes.push({ id, label });
	}

	// Only keep edges whose endpoints are real (text-bearing) nodes.
	const nodeIds = new Set(nodes.map((n) => n.id));
	const resolvedEdges = edges.filter(
		(e) => nodeIds.has(e.from) && nodeIds.has(e.to),
	);

	if (resolvedEdges.length > 0) {
		return {
			name,
			figureKind: "flowchart",
			transcription: {
				format: "process",
				mermaid: toMermaid(nodes, resolvedEdges),
				nodes: nodes.map((n) => ({ id: n.id, type: "shape", label: n.label })),
				edges: resolvedEdges,
				steps: toSteps(nodes, resolvedEdges),
			},
		};
	}

	// No connectors: a schematic/diagram. Emit the shape texts as markdown so
	// they are searchable, under a `diagram` figure.
	return {
		name,
		figureKind: "diagram",
		transcription: {
			format: "markdown",
			text: shapeTextToMarkdown(nodes),
		},
	};
}

/** Render a connector-free page's shape texts as a simple markdown list. */
function shapeTextToMarkdown(nodes: VsdxNode[]): string {
	if (nodes.length === 0) return "";
	const lines = nodes.map((n) => `- ${n.label}`);
	return lines.join("\n");
}

/** The `<Page>` entries in `visio/pages/pages.xml`, in document order. */
function readPageIndex(xml: string | undefined): { name: string; rid?: string }[] {
	if (xml === undefined) return [];
	let doc: Record<string, unknown>;
	try {
		doc = parser.parse(xml) as Record<string, unknown>;
	} catch {
		return [];
	}
	const pages = doc.Pages;
	if (typeof pages !== "object" || pages === null) return [];
	const result: { name: string; rid?: string }[] = [];
	for (const page of asArray((pages as Record<string, unknown>).Page)) {
		if (typeof page !== "object" || page === null) continue;
		const pageObj = page as Record<string, unknown>;
		const name =
			attr(pageObj, "NameU") ??
			attr(pageObj, "Name") ??
			`Seite ${result.length + 1}`;
		// The page part is referenced by `<Rel r:id="…">`.
		const rel = pageObj.Rel;
		const rid = rel !== undefined ? attr(rel, "id") : undefined;
		result.push({ name, ...(rid !== undefined ? { rid } : {}) });
	}
	return result;
}

/** Read `visio/pages/_rels/pages.xml.rels` into an r:id → target map. */
function readPageRels(xml: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (xml === undefined) return map;
	let doc: Record<string, unknown>;
	try {
		doc = parser.parse(xml) as Record<string, unknown>;
	} catch {
		return map;
	}
	const relationships = doc.Relationships;
	if (typeof relationships !== "object" || relationships === null) return map;
	for (const rel of asArray(
		(relationships as Record<string, unknown>).Relationship,
	)) {
		const id = attr(rel, "Id");
		const target = attr(rel, "Target");
		if (id !== undefined && target !== undefined) map.set(id, target);
	}
	return map;
}

/** Normalise a rel target (`page1.xml`, `/visio/pages/page1.xml`) to a package path. */
function normalizePagePart(target: string): string {
	const clean = target.replace(/^\.\//, "");
	if (clean.startsWith("/")) return clean.replace(/^\//, "");
	return clean.startsWith("visio/") ? clean : `visio/pages/${clean}`;
}

/**
 * Read a `.vsdx` into one transcription per Visio page.
 * Never throws — a package that fails to unzip or has no readable pages yields
 * an empty result with a warning, and the caller still renders the drawing via
 * LibreOffice for the picture.
 */
export function parseVsdx(buffer: Uint8Array, limits?: ZipLimits): ParsedVsdx {
  const warnings: string[] = [];
  let entries: Record<string, Uint8Array>;
  try {
    // Checked before any inflation; a limit violation
    // throws ExtractError and is re-thrown below, never downgraded.
    assertZipWithinLimits(buffer, limits);
    entries = unzipSync(buffer, {
      filter: (file) =>
        file.name === "visio/pages/pages.xml" ||
        file.name === "visio/pages/_rels/pages.xml.rels" ||
        /^visio\/pages\/page\d+\.xml$/.test(file.name),
    });
  } catch (error) {
    if (error instanceof ExtractError) throw error;
    warnings.push(
      `Das VSDX konnte nicht gelesen werden: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { pages: [], warnings };
  }

  const indexBytes = entries["visio/pages/pages.xml"];
  // Resolve page parts via the index + rels when present; otherwise fall back
  // to every `pageN.xml` in numeric order, so a package without a clean index
  // still yields its pages.
  const rels = readPageRels(
    entries["visio/pages/_rels/pages.xml.rels"] !== undefined
      ? strFromU8(entries["visio/pages/_rels/pages.xml.rels"])
      : undefined,
  );
  const index = readPageIndex(
    indexBytes !== undefined ? strFromU8(indexBytes) : undefined,
  );

  const partOrder: { name: string; part: string }[] = [];
  if (index.length > 0) {
    let fallback = 0;
    for (const entry of index) {
      fallback += 1;
      const target = entry.rid !== undefined ? rels.get(entry.rid) : undefined;
      const part =
        target !== undefined
          ? normalizePagePart(target)
          : `visio/pages/page${fallback}.xml`;
      partOrder.push({ name: entry.name, part });
    }
  } else {
    // No index: take the `pageN.xml` parts in numeric order.
    const pageParts = Object.keys(entries)
      .filter((n) => /^visio\/pages\/page\d+\.xml$/.test(n))
      .sort((a, b) => pageNumber(a) - pageNumber(b));
    pageParts.forEach((part, i) => {
      partOrder.push({ name: `Seite ${i + 1}`, part });
    });
  }

  if (partOrder.length === 0) {
    warnings.push("Keine Visio-Seiten im VSDX gefunden.");
    return { pages: [], warnings };
  }

  const pages: VsdxPage[] = [];
  for (const { name, part } of partOrder) {
    const bytes = entries[part];
    if (bytes === undefined) {
      warnings.push(`Visio-Seite „${name}“ konnte nicht gelesen werden.`);
      continue;
    }
    const page = parsePage(name, strFromU8(bytes));
    if (page === null) {
      warnings.push(`Visio-Seite „${name}“ konnte nicht geparst werden.`);
      continue;
    }
    pages.push(page);
  }

  if (pages.length === 0) {
    warnings.push("Das VSDX enthält keine lesbaren Visio-Seiten.");
  }

  return { pages, warnings };
}

/** Numeric part of a `visio/pages/pageN.xml` part name, for ordering. */
function pageNumber(part: string): number {
	const match = /page(\d+)\.xml$/.exec(part);
	return match?.[1] !== undefined ? Number(match[1]) : 0;
}
