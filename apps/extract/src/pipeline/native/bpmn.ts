// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pipeline/native/bpmn.ts
 *
 * A deterministic BPMN 2.0 parser: `.bpmn` XML in, a contract `process`
 * transcription out, with no rendering and no model call (design §10.1,
 * requirement 10.1).
 *
 * ## Why native, not vision
 *
 * A `.bpmn` file already *is* the structured graph the Pass-2 `process`
 * transcription reconstructs from a rasterised diagram. Asking a vision model to
 * re-derive nodes, edges and lanes from a rendered picture of a graph we were
 * handed as XML is wasteful and lossy. So this parser reads the OMG BPMN 2.0
 * XML directly — `definitions` → `process`/`collaboration`, `laneSet`/`lane`,
 * the flow-node elements (`task`, `userTask`, gateways, events, …) and
 * `sequenceFlow` edges — and produces exactly the {@link Transcription} shape
 * the vision pipeline produces for a `bpmn` figure, so a downstream consumer
 * cannot tell (and does not care) whether it came from XML or a model.
 *
 * ## Tolerant, like the model parsers
 *
 * Real-world BPMN is exported by many tools and namespaced inconsistently
 * (`bpmn:`, `bpmn2:`, `semantic:`, or no prefix at all). fast-xml-parser strips
 * the prefixes for us (`removeNSPrefix`), and every field has a defined
 * fallback: a node with no `name` keeps its id as the label, an edge missing a
 * `sourceRef`/`targetRef` is dropped, a lane's flow-node refs that point at
 * nothing are ignored. A file that is not parseable BPMN yields an empty
 * process rather than throwing, so a mis-detected `.bpmn` degrades to "no
 * content" instead of failing the job.
 */

import type { Transcription } from "@atf/extract-contract/v2";
import { XMLParser } from "fast-xml-parser";

/** The flow-node element names BPMN 2.0 defines, mapped to a compact node type. */
const NODE_TYPES: Readonly<Record<string, string>> = {
	task: "task",
	userTask: "userTask",
	serviceTask: "serviceTask",
	scriptTask: "scriptTask",
	manualTask: "manualTask",
	sendTask: "sendTask",
	receiveTask: "receiveTask",
	businessRuleTask: "businessRuleTask",
	callActivity: "callActivity",
	subProcess: "subProcess",
	exclusiveGateway: "exclusiveGateway",
	parallelGateway: "parallelGateway",
	inclusiveGateway: "inclusiveGateway",
	complexGateway: "complexGateway",
	eventBasedGateway: "eventBasedGateway",
	startEvent: "startEvent",
	endEvent: "endEvent",
	intermediateThrowEvent: "intermediateThrowEvent",
	intermediateCatchEvent: "intermediateCatchEvent",
	boundaryEvent: "boundaryEvent",
};

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@_",
	parseAttributeValue: false,
	parseTagValue: false,
	trimValues: true,
	// Strip `bpmn:`/`bpmn2:`/… prefixes so element lookups are prefix-agnostic.
	removeNSPrefix: true,
});

/** A parsed BPMN document plus any tolerant-recovery warnings. */
export interface ParsedBpmn {
	transcription: Extract<Transcription, { format: "process" }>;
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
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

/** All processes under `definitions`, whether wrapped in a collaboration or not. */
function collectProcesses(
	definitions: Record<string, unknown>,
): Record<string, unknown>[] {
	return asArray(definitions.process).filter(
		(p): p is Record<string, unknown> => typeof p === "object" && p !== null,
	);
}

/**
 * Build a lane id/flow-node → lane name map from a process's `laneSet`.
 * A lane's members are listed as `flowNodeRef` (text children); the lane's
 * `name` (or id) becomes the label those members carry.
 */
function laneAssignments(process: Record<string, unknown>): {
	lanes: string[];
	memberLane: Map<string, string>;
} {
	const lanes: string[] = [];
	const memberLane = new Map<string, string>();
	for (const laneSet of asArray(process.laneSet)) {
		if (typeof laneSet !== "object" || laneSet === null) continue;
		for (const lane of asArray((laneSet as Record<string, unknown>).lane)) {
			if (typeof lane !== "object" || lane === null) continue;
			const laneObj = lane as Record<string, unknown>;
			const label = attr(laneObj, "name") ?? attr(laneObj, "id") ?? "";
			if (label === "") continue;
			if (!lanes.includes(label)) lanes.push(label);
			for (const ref of asArray(laneObj.flowNodeRef)) {
				const id =
					typeof ref === "string"
						? ref.trim()
						: asString((ref as Record<string, unknown>)?.["#text"]);
				if (id !== "") memberLane.set(id, label);
			}
		}
	}
	return { lanes, memberLane };
}

/** Coerce a fast-xml-parser text value to a trimmed string. */
function asString(value: unknown): string {
	return typeof value === "string" || typeof value === "number"
		? String(value).trim()
		: "";
}

interface ProcessNode {
	id: string;
	type: string;
	label: string;
	lane?: string;
}

interface ProcessEdge {
	from: string;
	to: string;
	condition?: string;
}

/** Escape a label for a Mermaid node body (Mermaid is picky about brackets). */
function mermaidLabel(text: string): string {
	return text
		.replace(/"/g, "'")
		.replace(/[[\]{}()]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Render the graph to a `flowchart TD` Mermaid diagram, deterministically. */
function toMermaid(nodes: ProcessNode[], edges: ProcessEdge[]): string {
	if (nodes.length === 0) return "flowchart TD";
	const alias = new Map<string, string>();
	nodes.forEach((node, index) => {
		alias.set(node.id, `n${index}`);
	});
	const lines: string[] = ["flowchart TD"];
	for (const node of nodes) {
		const id = alias.get(node.id) ?? node.id;
		const label = mermaidLabel(node.label || node.id);
		// Gateways as rhombus, start/end as rounded, everything else as a box.
		if (node.type.endsWith("Gateway")) lines.push(`  ${id}{"${label}"}`);
		else if (node.type === "startEvent" || node.type === "endEvent")
			lines.push(`  ${id}(["${label}"])`);
		else lines.push(`  ${id}["${label}"]`);
	}
	for (const edge of edges) {
		const from = alias.get(edge.from);
		const to = alias.get(edge.to);
		if (from === undefined || to === undefined) continue;
		const condition =
			edge.condition !== undefined ? mermaidLabel(edge.condition) : "";
		lines.push(
			condition === ""
				? `  ${from} --> ${to}`
				: `  ${from} -->|"${condition}"| ${to}`,
		);
	}
	return lines.join("\n");
}

/**
 * Order the nodes into a linear `steps` list by a breadth-first walk from the
 * start events along the sequence flows, appending any unreached nodes at the
 * end so nothing is lost. Deterministic: ties break on document order.
 */
function toSteps(nodes: ProcessNode[], edges: ProcessEdge[]): string[] {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const outgoing = new Map<string, string[]>();
	for (const edge of edges) {
		const list = outgoing.get(edge.from) ?? [];
		list.push(edge.to);
		outgoing.set(edge.from, list);
	}
	const hasIncoming = new Set(edges.map((e) => e.to));
	// Roots: declared start events, else any node with no incoming edge, else
	// the first node — so a cyclic graph with no clear start still walks.
	const starts = nodes.filter((n) => n.type === "startEvent").map((n) => n.id);
	const roots =
		starts.length > 0
			? starts
			: nodes.filter((n) => !hasIncoming.has(n.id)).map((n) => n.id);
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
	// Append anything unreached (a disconnected fragment) in document order.
	for (const node of nodes) if (!visited.has(node.id)) order.push(node.id);

	return order.map((id) => {
		const node = byId.get(id);
		return node === undefined ? id : node.label || node.id;
	});
}

/**
 * Parse a BPMN 2.0 XML document into a `process` transcription. Never throws —
 * an unparseable or non-BPMN input yields an empty process with a warning.
 */
export function parseBpmn(xml: string): ParsedBpmn {
	const warnings: string[] = [];
	let doc: Record<string, unknown>;
	try {
		doc = parser.parse(xml) as Record<string, unknown>;
	} catch (error) {
		warnings.push(
			`Die BPMN-XML konnte nicht geparst werden: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { transcription: emptyProcess(), warnings };
	}

	const definitions = doc.definitions;
	if (definitions === undefined) {
		warnings.push(
			"Die Datei enthält kein <definitions>-Wurzelelement; leerer Prozess.",
		);
		return { transcription: emptyProcess(), warnings };
	}
	// A self-closing or empty `<definitions/>` parses to an empty string, not an
	// object: it is a well-formed BPMN root that simply carries no process.
	if (typeof definitions !== "object" || definitions === null) {
		warnings.push("Kein <process> im BPMN-Dokument gefunden; leerer Prozess.");
		return { transcription: emptyProcess(), warnings };
	}

	const processes = collectProcesses(definitions as Record<string, unknown>);
	if (processes.length === 0) {
		warnings.push("Kein <process> im BPMN-Dokument gefunden; leerer Prozess.");
		return { transcription: emptyProcess(), warnings };
	}

	const nodes: ProcessNode[] = [];
	const edges: ProcessEdge[] = [];
	const lanes: string[] = [];

	for (const process of processes) {
		const { lanes: processLanes, memberLane } = laneAssignments(process);
		for (const lane of processLanes)
			if (!lanes.includes(lane)) lanes.push(lane);

		for (const [element, type] of Object.entries(NODE_TYPES)) {
			for (const raw of asArray(process[element])) {
				if (typeof raw !== "object" || raw === null) continue;
				const id = attr(raw, "id");
				if (id === undefined) continue;
				const label = attr(raw, "name") ?? id;
				const lane = memberLane.get(id);
				nodes.push({
					id,
					type,
					label,
					...(lane !== undefined ? { lane } : {}),
				});
			}
		}

		for (const raw of asArray(process.sequenceFlow)) {
			if (typeof raw !== "object" || raw === null) continue;
			const from = attr(raw, "sourceRef");
			const to = attr(raw, "targetRef");
			if (from === undefined || to === undefined) {
				warnings.push(
					"Ein sequenceFlow ohne sourceRef/targetRef wurde übersprungen.",
				);
				continue;
			}
			// The edge condition: a `name` (a labelled gate) or a conditionExpression.
			const name = attr(raw, "name");
			const condition =
				name ?? conditionExpression(raw as Record<string, unknown>);
			edges.push({
				from,
				to,
				...(condition !== undefined ? { condition } : {}),
			});
		}
	}

	if (nodes.length === 0) {
		warnings.push("Der BPMN-Prozess enthält keine Knoten.");
	}

	const transcription: ParsedBpmn["transcription"] = {
		format: "process",
		mermaid: toMermaid(nodes, edges),
		nodes,
		edges,
		...(lanes.length > 0 ? { lanes } : {}),
		steps: toSteps(nodes, edges),
	};
	return { transcription, warnings };
}

/** Extract a `conditionExpression`'s text from a sequenceFlow, when present. */
function conditionExpression(
	flow: Record<string, unknown>,
): string | undefined {
	const expr = flow.conditionExpression;
	if (typeof expr === "object" && expr !== null) {
		const text = asString((expr as Record<string, unknown>)["#text"]);
		if (text !== "") return text;
	} else if (typeof expr === "string" && expr.trim() !== "") {
		return expr.trim();
	}
	return undefined;
}

/** The empty `process` a non-BPMN or content-free input degrades to. */
function emptyProcess(): ParsedBpmn["transcription"] {
	return {
		format: "process",
		mermaid: "flowchart TD",
		nodes: [],
		edges: [],
		steps: [],
	};
}
