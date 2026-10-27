// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { buildAssetId, nativeLocalId } from "@atf/extract-contract";
import {
	markdownTranscriptionSchema,
	pageRecordSchema,
	processTranscriptionSchema,
} from "@atf/extract-contract/v2";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildVsdxRecords, parseVsdx } from "../src/pipeline/native/index.js";

/**
 * Build a minimal VSDX (an OPC ZIP package) directly with fflate, so the test
 * needs no Visio library. `pages` maps a page name to its `pageN.xml` body; the
 * package gets a matching `pages.xml` index and a rels part, exactly the parts
 * {@link parseVsdx} reads.
 */
function buildVsdx(
	pages: { name: string; body: string }[],
	extraParts: Record<string, Uint8Array> = {},
): Uint8Array {
	const pageEntries: Record<string, Uint8Array> = {};
	const pageIndex: string[] = [];
	const relEntries: string[] = [];
	pages.forEach((page, i) => {
		const n = i + 1;
		pageEntries[`visio/pages/page${n}.xml`] = strToU8(page.body);
		pageIndex.push(
			`<Page ID="${n}" NameU="${page.name}" Name="${page.name}"><Rel r:id="rId${n}"/></Page>`,
		);
		relEntries.push(
			`<Relationship Id="rId${n}" Type="http://schemas.microsoft.com/visio/2010/relationships/page" Target="page${n}.xml"/>`,
		);
	});
	const pagesXml = `<?xml version="1.0" encoding="UTF-8"?>
<Pages xmlns="http://schemas.microsoft.com/office/visio/2012/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  ${pageIndex.join("\n  ")}
</Pages>`;
	const relsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${relEntries.join("\n  ")}
</Relationships>`;
	return zipSync({
		"[Content_Types].xml": strToU8("<Types/>"),
		"visio/pages/pages.xml": strToU8(pagesXml),
		"visio/pages/_rels/pages.xml.rels": strToU8(relsXml),
		...pageEntries,
		...extraParts,
	});
}

/**
 * A page with three shapes (Start → Prüfen → Ende) joined by two connectors.
 * Connector shape 4 joins 1→2 (Begin=1, End=2), connector 5 joins 2→3, and
 * connector 5 carries the label "ja".
 */
const FLOW_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<PageContents xmlns="http://schemas.microsoft.com/office/visio/2012/main">
  <Shapes>
    <Shape ID="1" NameU="Start" Type="Shape"><Text>Posteingang</Text></Shape>
    <Shape ID="2" NameU="Task" Type="Shape"><Text>Antragseingang <cp IX="0"/>prüfen</Text></Shape>
    <Shape ID="3" NameU="End" Type="Shape"><Text>Abgeschlossen</Text></Shape>
    <Shape ID="4" NameU="Dynamic connector" Type="Shape"><Text/></Shape>
    <Shape ID="5" NameU="Dynamic connector" Type="Shape"><Text>ja</Text></Shape>
  </Shapes>
  <Connects>
    <Connect FromSheet="4" FromCell="BeginX" ToSheet="1" ToCell="PinX"/>
    <Connect FromSheet="4" FromCell="EndX" ToSheet="2" ToCell="PinX"/>
    <Connect FromSheet="5" FromCell="BeginX" ToSheet="2" ToCell="PinX"/>
    <Connect FromSheet="5" FromCell="EndX" ToSheet="3" ToCell="PinX"/>
  </Connects>
</PageContents>`;

/** A page with shapes but no connectors: a schematic/diagram. */
const DIAGRAM_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<PageContents xmlns="http://schemas.microsoft.com/office/visio/2012/main">
  <Shapes>
    <Shape ID="10" Type="Shape"><Text>Pumpe P1</Text></Shape>
    <Shape ID="11" Type="Shape"><Text>Ventil V2</Text></Shape>
    <Shape ID="12" Type="Group">
      <Shapes>
        <Shape ID="13" Type="Shape"><Text>Tank T3</Text></Shape>
      </Shapes>
    </Shape>
  </Shapes>
</PageContents>`;

describe("parseVsdx", () => {
	it("reads a connected page as a process transcription with nodes, edges and steps", () => {
		const { pages, warnings } = parseVsdx(
			buildVsdx([{ name: "Ablauf", body: FLOW_PAGE }]),
		);
		expect(warnings).toEqual([]);
		expect(pages).toHaveLength(1);

		const [page] = pages;
		if (page === undefined) throw new Error("expected a page");
		expect(page.name).toBe("Ablauf");
		expect(page.figureKind).toBe("flowchart");
		expect(page.transcription.format).toBe("process");
		if (page.transcription.format !== "process") throw new Error("expected process");

		// The transcription is exactly the contract's `process` shape.
		expect(() =>
			processTranscriptionSchema.parse(page.transcription),
		).not.toThrow();

		// Three text-bearing shapes are nodes; the two connector shapes are not.
		expect(page.transcription.nodes.map((n) => n.id).sort()).toEqual([
			"1",
			"2",
			"3",
		]);
		// Interleaved formatting markers do not leak into the label.
		expect(page.transcription.nodes.find((n) => n.id === "2")?.label).toBe(
			"Antragseingang prüfen",
		);

		// Two edges from the connector graph, in Begin→End direction.
		expect(page.transcription.edges).toEqual([
			{ from: "1", to: "2" },
			{ from: "2", to: "3", label: "ja" },
		]);

		// Steps walk from the root (shape 1) along the edges.
		expect(page.transcription.steps).toEqual([
			"Posteingang",
			"Antragseingang prüfen",
			"Abgeschlossen",
		]);

		// A deterministic Mermaid flowchart is generated.
		expect(page.transcription.mermaid.startsWith("flowchart TD")).toBe(true);
		expect(page.transcription.mermaid).toContain("Posteingang");
	});

	it("reads a connector-free page as a diagram markdown transcription", () => {
		const { pages } = parseVsdx(
			buildVsdx([{ name: "Schema", body: DIAGRAM_PAGE }]),
		);
		expect(pages).toHaveLength(1);
		const [page] = pages;
		if (page === undefined) throw new Error("expected a page");
		expect(page.figureKind).toBe("diagram");
		expect(page.transcription.format).toBe("markdown");
		if (page.transcription.format !== "markdown") throw new Error("expected markdown");
		expect(() =>
			markdownTranscriptionSchema.parse(page.transcription),
		).not.toThrow();

		// Every shape text is captured, including the one nested in a group.
		expect(page.transcription.text).toContain("Pumpe P1");
		expect(page.transcription.text).toContain("Ventil V2");
		expect(page.transcription.text).toContain("Tank T3");
	});

	it("reads every Visio page in document order", () => {
		const { pages } = parseVsdx(
			buildVsdx([
				{ name: "Ablauf", body: FLOW_PAGE },
				{ name: "Schema", body: DIAGRAM_PAGE },
			]),
		);
		expect(pages.map((p) => p.name)).toEqual(["Ablauf", "Schema"]);
		expect(pages.map((p) => p.figureKind)).toEqual(["flowchart", "diagram"]);
	});

	it("is deterministic: the same package parses to the same result", () => {
		const bytes = buildVsdx([
			{ name: "Ablauf", body: FLOW_PAGE },
			{ name: "Schema", body: DIAGRAM_PAGE },
		]);
		const a = parseVsdx(bytes);
		const b = parseVsdx(bytes);
		expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
	});

	it("degrades to an empty result with a warning on non-VSDX bytes", () => {
		const { pages, warnings } = parseVsdx(
			new TextEncoder().encode("this is not a visio package"),
		);
		expect(pages).toEqual([]);
		expect(warnings.length).toBeGreaterThan(0);
	});

	it("warns when a package has no Visio pages", () => {
		const empty = zipSync({ "[Content_Types].xml": strToU8("<Types/>") });
		const { pages, warnings } = parseVsdx(empty);
		expect(pages).toEqual([]);
		expect(warnings.some((w) => /Seite|Visio/i.test(w))).toBe(true);
	});

	it("falls back to numeric page order when the index is missing", () => {
		// A package with page parts but no pages.xml index.
		const bytes = zipSync({
			"[Content_Types].xml": strToU8("<Types/>"),
			"visio/pages/page1.xml": strToU8(FLOW_PAGE),
			"visio/pages/page2.xml": strToU8(DIAGRAM_PAGE),
		});
		const { pages } = parseVsdx(bytes);
		expect(pages).toHaveLength(2);
		expect(pages[0]?.figureKind).toBe("flowchart");
		expect(pages[1]?.figureKind).toBe("diagram");
	});
});

describe("buildVsdxRecords", () => {
	it("emits one contract-valid page record per Visio page with a page image asset and the native .vsdx", () => {
		const reference = "vsdx-ref-1";
		const buffer = buildVsdx([
			{ name: "Ablauf", body: FLOW_PAGE },
			{ name: "Schema", body: DIAGRAM_PAGE },
		]);
		const parsed = parseVsdx(buffer);
		const { records, nativeAssets, warnings } = buildVsdxRecords(
			reference,
			parsed,
			buffer,
		);

		expect(warnings).toEqual([]);
		expect(records).toHaveLength(2);
		for (const record of records) {
			expect(() => pageRecordSchema.parse(record)).not.toThrow();
			expect(record.class).toBe("drawing");
			// Each page references a `page` asset for the LibreOffice-rendered image.
			expect(record.assets.some((a) => a.kind === "page")).toBe(true);
		}

		// Page 1 is the flow → a flowchart figure with a process transcription.
		const [flow, diagram] = records;
		if (flow === undefined || diagram === undefined) throw new Error("expected two records");
		const flowFigure = flow.blocks.find((b) => b.type === "figure");
		if (flowFigure?.type === "figure") {
			expect(flowFigure.kind).toBe("flowchart");
			expect(flowFigure.source).toBe("native");
			expect(flowFigure.transcription?.format).toBe("process");
		} else {
			throw new Error("expected a figure block on the flow page");
		}

		// Page 2 is connector-free → a diagram figure with a markdown transcription.
		const diagramFigure = diagram.blocks.find((b) => b.type === "figure");
		if (diagramFigure?.type === "figure") {
			expect(diagramFigure.kind).toBe("diagram");
			expect(diagramFigure.transcription?.format).toBe("markdown");
		} else {
			throw new Error("expected a figure block on the diagram page");
		}

		// The original .vsdx is kept once as a native: asset, on page 1, and its
		// id is the contract derivation of `native:diagram.vsdx`.
		const nativeRefs = records.flatMap((r) =>
			r.assets.filter((a) => a.kind === "native"),
		);
		expect(nativeRefs).toHaveLength(1);
		expect(nativeRefs[0]?.page).toBe(1);
		expect(nativeRefs[0]?.localId).toBe(nativeLocalId("diagram.vsdx"));
		expect(nativeRefs[0]?.assetId).toBe(
			buildAssetId(reference, nativeLocalId("diagram.vsdx")),
		);
		expect(nativeRefs[0]?.mimeType).toBe("application/vnd.ms-visio.drawing");

		// The native asset bytes are the original package, verbatim.
		expect(nativeAssets).toHaveLength(1);
		expect(nativeAssets[0]?.buffer).toEqual(buffer);
	});
});
