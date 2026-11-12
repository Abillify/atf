// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { normalizedSeedValue } from "./coverage-assignment.js";
import { normalizedRef } from "./coverage-identity.js";
import type {
	CoverageAssignment,
	CoverageReport,
	CoverageReportDecision,
	CoverageReportItem,
	CoverageReportMarkers,
} from "./coverage-types.js";

function markerCount(text: string, marker: string): number {
	let count = 0;
	let offset = 0;
	while (true) {
		const index = text.indexOf(marker, offset);
		if (index < 0) return count;
		count += 1;
		offset = index + marker.length;
	}
}

export function coverageFindingText(
	text: string,
	markers: CoverageReportMarkers,
): string {
	const start = text.indexOf(markers.start);
	return (start < 0 ? text : text.slice(0, start)).trim();
}

const MAX_DISCOVERED_ITEMS = 100;

const MAX_DISCOVERED_ITEM_CHARS = 256;

function parseDiscoveredValues(value: unknown): string[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_DISCOVERED_ITEMS)
		return undefined;
	const seen = new Set<string>();
	const values: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") return undefined;
		const normalized = normalizedSeedValue(item);
		if (normalized === "" || normalized.length > MAX_DISCOVERED_ITEM_CHARS) {
			return undefined;
		}
		const key = normalized.toLocaleLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		values.push(normalized);
	}
	return values;
}

/**
 * Validates an already-parsed coverage-report OBJECT against an assignment.
 *
 * This is the format-agnostic core shared by both delivery contracts:
 *   - {@link parseCoverageReport} extracts the object from between the markers
 *     (the streaming worker contract), then calls this.
 *   - {@link parseCoverageReportObject} takes a schema-enforced JSON object
 *     directly (the structured-output worker contract) and calls this.
 *
 * The rules (key set, per-item shape, mode-dependent decision set, ref
 * membership, no duplicates, discovery fields only for `original`) live here so
 * the two contracts can never drift apart. Returns the normalized report or
 * `undefined` when any rule is violated.
 */
function validateCoverageReportObject(
	raw: unknown,
	assignment: CoverageAssignment,
): CoverageReport | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	const recordKeys = Object.keys(record).sort();
	if (
		recordKeys.length !== 2 ||
		recordKeys[0] !== "assignmentId" ||
		recordKeys[1] !== "documents" ||
		record.assignmentId !== assignment.id ||
		!Array.isArray(record.documents)
	) {
		return undefined;
	}

	const expectedRefs = assignment.documents.map((document) => document.ref);
	if (
		record.documents.length === 0 ||
		record.documents.length > expectedRefs.length
	) {
		return undefined;
	}
	const seen = new Set<string>();
	const documents: CoverageReportItem[] = [];
	for (const value of record.documents) {
		if (value === null || typeof value !== "object") return undefined;
		const item = value as Record<string, unknown>;
		const itemKeys = Object.keys(item).sort();
		const allowedKeys = new Set([
			"decision",
			"discoveredEntities",
			"discoveredTerms",
			"reason",
			"ref",
		]);
		if (
			itemKeys.some((key) => !allowedKeys.has(key)) ||
			!itemKeys.includes("decision") ||
			!itemKeys.includes("reason") ||
			!itemKeys.includes("ref") ||
			typeof item.ref !== "string" ||
			typeof item.decision !== "string" ||
			typeof item.reason !== "string" ||
			item.reason.trim() === ""
		) {
			return undefined;
		}
		const discoveredEntities = parseDiscoveredValues(item.discoveredEntities);
		const discoveredTerms = parseDiscoveredValues(item.discoveredTerms);
		if (
			discoveredEntities === undefined ||
			discoveredTerms === undefined ||
			(assignment.mode !== "original" &&
				(item.discoveredEntities !== undefined ||
					item.discoveredTerms !== undefined))
		) {
			return undefined;
		}
		const ref = normalizedRef(item.ref);
		const decision = item.decision as CoverageReportDecision;
		const validDecision =
			assignment.mode === "summary"
				? decision === "relevant" ||
					decision === "possibly_relevant" ||
					decision === "excluded"
				: decision === "reviewed" || decision === "excluded";
		if (!validDecision || !expectedRefs.includes(ref) || seen.has(ref)) {
			return undefined;
		}
		seen.add(ref);
		documents.push({
			ref,
			decision,
			reason: item.reason.trim().normalize("NFC"),
			...(discoveredEntities.length > 0 ? { discoveredEntities } : {}),
			...(discoveredTerms.length > 0 ? { discoveredTerms } : {}),
		});
	}
	return { assignmentId: assignment.id, documents };
}

export function parseCoverageReport(
	text: string,
	assignment: CoverageAssignment,
	markers: CoverageReportMarkers,
): { report: CoverageReport; findingText: string } | undefined {
	if (
		markerCount(text, markers.start) !== 1 ||
		markerCount(text, markers.end) !== 1
	) {
		return undefined;
	}
	const start = text.indexOf(markers.start);
	const end = text.indexOf(markers.end, start + markers.start.length);
	if (
		start < 0 ||
		end < start ||
		text.slice(end + markers.end.length).trim() !== ""
	) {
		return undefined;
	}

	let raw: unknown;
	try {
		raw = JSON.parse(text.slice(start + markers.start.length, end).trim());
	} catch {
		return undefined;
	}
	const report = validateCoverageReportObject(raw, assignment);
	if (report === undefined) return undefined;
	return { report, findingText: text.slice(0, start).trim() };
}

/**
 * Parses a coverage report delivered as a schema-enforced JSON OBJECT (the
 * structured-output worker contract), with NO surrounding markers. `text` is the
 * worker's whole assistant content, expected to be exactly one JSON object.
 *
 * A structured-output worker cannot prepend a free-text finding, so there is no
 * `findingText` to recover here (findings for these workers are carried via the
 * report itself, not a text preamble).
 */
export function parseCoverageReportObject(
	text: string,
	assignment: CoverageAssignment,
): { report: CoverageReport; findingText: string } | undefined {
	const trimmed = text.trim();
	if (trimmed === "") return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	const report = validateCoverageReportObject(raw, assignment);
	if (report === undefined) return undefined;
	return { report, findingText: "" };
}

/**
 * Builds the JSON Schema a structured-output coverage worker must satisfy for a
 * given assignment. The schema is mode-dependent, mirroring the acceptance rules
 * in {@link validateCoverageReportObject}:
 *   - `assignmentId` is pinned to the exact assignment id (const),
 *   - the `decision` enum is `relevant|possibly_relevant|excluded` for summary
 *     assignments and `reviewed|excluded` otherwise,
 *   - `discoveredEntities`/`discoveredTerms` are offered only for `original`
 *     assignments (they are rejected by the validator for other modes).
 *
 * `additionalProperties: false` and the `required` lists keep the object shape
 * exactly what the validator accepts, so a schema-conforming object passes the
 * gate deterministically.
 */
export function buildCoverageReportSchema(
	assignment: CoverageAssignment,
): Record<string, unknown> {
	const decisionEnum =
		assignment.mode === "summary"
			? ["relevant", "possibly_relevant", "excluded"]
			: ["reviewed", "excluded"];
	const itemProperties: Record<string, unknown> = {
		ref: { type: "string", enum: assignment.documents.map((d) => d.ref) },
		decision: { type: "string", enum: decisionEnum },
		reason: { type: "string", minLength: 1 },
	};
	const itemRequired = ["ref", "decision", "reason"];
	if (assignment.mode === "original") {
		itemProperties.discoveredEntities = {
			type: "array",
			items: { type: "string" },
		};
		itemProperties.discoveredTerms = {
			type: "array",
			items: { type: "string" },
		};
	}
	return {
		type: "object",
		additionalProperties: false,
		required: ["assignmentId", "documents"],
		properties: {
			assignmentId: { type: "string", const: assignment.id },
			documents: {
				type: "array",
				minItems: 1,
				maxItems: assignment.documents.length,
				items: {
					type: "object",
					additionalProperties: false,
					required: itemRequired,
					properties: itemProperties,
				},
			},
		},
	};
}

/**
 * Classifies WHY {@link parseCoverageReportObject} rejected a structured-output
 * worker's JSON. Returns the same stable, content-free rule codes as
 * {@link describeCoverageReportDefect}, minus the marker-specific codes.
 */
export function describeCoverageReportObjectDefect(
	text: string,
	assignment: CoverageAssignment,
): string {
	const trimmed = text.trim();
	if (trimmed === "") return "empty_output";
	let raw: unknown;
	try {
		raw = JSON.parse(trimmed);
	} catch {
		return "invalid_json";
	}
	return describeCoverageReportObjectPayload(raw, assignment);
}

/**
 * Classifies WHY {@link parseCoverageReport} rejected a worker's final message.
 *
 * The returned value is a stable, non-content-bearing rule code. Worker output,
 * assignment references, configured markers, JSON keys, and parser errors must
 * never be copied into diagnostics: all are externally controlled and may
 * contain document data, credentials, or private endpoints.
 */
export function describeCoverageReportDefect(
	text: string,
	assignment: CoverageAssignment,
	markers: CoverageReportMarkers,
): string {
	const startCount = markerCount(text, markers.start);
	const endCount = markerCount(text, markers.end);
	if (startCount === 0) return "missing_start_marker";
	if (endCount === 0) return "missing_end_marker";
	if (startCount !== 1 || endCount !== 1) return "invalid_marker_count";
	const start = text.indexOf(markers.start);
	const end = text.indexOf(markers.end, start + markers.start.length);
	if (end < start) return "invalid_marker_order";
	if (text.slice(end + markers.end.length).trim() !== "") {
		return "trailing_content";
	}
	const payload = text.slice(start + markers.start.length, end).trim();
	let raw: unknown;
	try {
		raw = JSON.parse(payload);
	} catch {
		return "invalid_json";
	}
	return describeCoverageReportObjectPayload(raw, assignment);
}

/**
 * Shared payload classifier for an already-parsed report OBJECT. Returns the
 * same stable rule codes for both the marker path
 * ({@link describeCoverageReportDefect}) and the structured-output path
 * ({@link describeCoverageReportObjectDefect}). Content-free by contract.
 */
function describeCoverageReportObjectPayload(
	raw: unknown,
	assignment: CoverageAssignment,
): string {
	if (raw === null || typeof raw !== "object") return "invalid_report_type";
	const record = raw as Record<string, unknown>;
	const recordKeys = Object.keys(record).sort();
	if (
		recordKeys.length !== 2 ||
		recordKeys[0] !== "assignmentId" ||
		recordKeys[1] !== "documents"
	) {
		return "invalid_report_keys";
	}
	if (record.assignmentId !== assignment.id) return "assignment_id_mismatch";
	if (!Array.isArray(record.documents)) return "invalid_documents_type";
	const expectedRefs = assignment.documents.map((document) => document.ref);
	if (record.documents.length === 0) return "empty_documents";
	if (record.documents.length > expectedRefs.length)
		return "too_many_documents";
	const seen = new Set<string>();
	for (const [index, value] of record.documents.entries()) {
		if (value === null || typeof value !== "object") {
			return `invalid_document_type_at_${index}`;
		}
		const item = value as Record<string, unknown>;
		const itemKeys = Object.keys(item).sort();
		const allowedKeys = new Set([
			"decision",
			"discoveredEntities",
			"discoveredTerms",
			"reason",
			"ref",
		]);
		if (itemKeys.some((key) => !allowedKeys.has(key))) {
			return `unknown_document_keys_at_${index}`;
		}
		for (const key of ["ref", "decision", "reason"] as const) {
			if (typeof item[key] !== "string") {
				return `invalid_${key}_type_at_${index}`;
			}
		}
		if ((item.reason as string).trim() === "") {
			return `empty_reason_at_${index}`;
		}
		if (
			assignment.mode !== "original" &&
			(item.discoveredEntities !== undefined ||
				item.discoveredTerms !== undefined)
		) {
			return `discovery_fields_not_allowed_at_${index}`;
		}
		if (
			parseDiscoveredValues(item.discoveredEntities) === undefined ||
			parseDiscoveredValues(item.discoveredTerms) === undefined
		) {
			return `invalid_discovery_fields_at_${index}`;
		}
		const ref = normalizedRef(item.ref as string);
		const decision = item.decision as CoverageReportDecision;
		const validDecision =
			assignment.mode === "summary"
				? decision === "relevant" ||
					decision === "possibly_relevant" ||
					decision === "excluded"
				: decision === "reviewed" || decision === "excluded";
		if (!validDecision) return `invalid_decision_at_${index}`;
		if (!expectedRefs.includes(ref)) return `unassigned_ref_at_${index}`;
		if (seen.has(ref)) return `duplicate_ref_at_${index}`;
		seen.add(ref);
	}
	return "accepted_on_recheck";
}
