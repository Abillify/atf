// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * OpenAPI compatibility guard (requirement 11.7, task 17.3).
 *
 * Every service that publishes an OpenAPI document has a committed baseline
 * under `docs/openapi/`. The document is generated from the same builder the
 * running server uses, so the baseline cannot drift from the implementation
 * without CI noticing.
 *
 * Two failure classes, reported separately:
 *
 *  - BREAKING: a change that can break existing clients — removed paths or
 *    operations, newly required request bodies/parameters/properties, removed
 *    response properties, narrowed enums, changed types. These need an
 *    explicit sign-off: bump the service's API version and note it in the
 *    CHANGELOG before running `openapi:update`.
 *  - DRIFT: the document changed in a client-safe way (new endpoints, added
 *    optional fields, prose). Run `bun run openapi:update` and commit the
 *    result so the published documentation stays current.
 *
 * `info.version` counts as drift, not breakage: a product-version bump must
 * regenerate the baselines (`version:sync` followed by `openapi:update`), but
 * it is not itself a breaking change.
 *
 * All four API services (runtime, gate, search, extract) publish documents
 * under /openapi.json (requirement 14.5) and are covered by this check.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const update = process.argv.includes("--update");

interface ServiceSpec {
	/** Basename of the committed document under docs/openapi/. */
	name: string;
	/** Generate the document exactly as the running server would serve it. */
	generate: () => Promise<Record<string, unknown>>;
}

const SERVICES: ServiceSpec[] = [
	{
		name: "runtime",
		generate: async () => {
			const mod = await import(resolve(root, "apps/runtime/src/openapi.ts"));
			// The runtime inventory is parsed from the real router tree at call
			// time, so the baseline reflects every mountable route; conditional
			// groups carry an x-enabled-when extension instead of being omitted.
			return mod.buildOpenApiSpec("http://127.0.0.1:3000") as Record<string, unknown>;
		},
	},
	{
		name: "gate",
		generate: async () => {
			const mod = await import(resolve(root, "apps/gate/src/openapi.ts"));
			return mod.buildOpenApiSpec("http://127.0.0.1:3003") as Record<string, unknown>;
		},
	},
	{
		name: "search",
		generate: async () => {
			const mod = await import(resolve(root, "apps/search/src/openapi.ts"));
			return mod.buildOpenApiSpec("http://127.0.0.1:3002") as Record<string, unknown>;
		},
	},
	{
		name: "extract",
		generate: async () => {
			const mod = await import(resolve(root, "apps/extract/src/openapi.ts"));
			// All features on: the baseline documents the full surface, the
			// server narrows it per deployment via the same flags.
			return mod.buildOpenApiSpec({
				serverUrl: "http://127.0.0.1:3003",
				ingestEnabled: true,
				v2Enabled: true,
				deleteEnabled: true,
				erasureEnabled: true,
			}) as Record<string, unknown>;
		},
	},
];

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve an internal `$ref` like `#/components/schemas/Foo`. Returns the
 * referenced object or undefined when it cannot be resolved (an unresolvable
 * ref is treated as opaque, which can only under-report, never false-positive).
 */
function resolveRef(doc: Json, ref: string): Json | undefined {
	if (!ref.startsWith("#/")) return undefined;
	let node: unknown = doc;
	for (const segment of ref.slice(2).split("/")) {
		const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
		if (!isObject(node)) return undefined;
		node = node[key];
	}
	return isObject(node) ? node : undefined;
}

/** Follow `$ref` chains so schema comparisons see the real definition. */
function deref(doc: Json, schema: unknown, depth = 0): Json | undefined {
	if (!isObject(schema)) return undefined;
	if (depth > 16) return undefined;
	if (typeof schema.$ref === "string") {
		const target = resolveRef(doc, schema.$ref);
		return target ? deref(doc, target, depth + 1) : undefined;
	}
	return schema;
}

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch"];

interface Finding {
	breaking: boolean;
	message: string;
}

/**
 * Compare one schema pair (old vs new) for client-visible changes. `side` is
 * "request" or "response" and decides which direction counts as breaking.
 */
function compareSchema(
	docOld: Json,
	docNew: Json,
	oldSchema: unknown,
	newSchema: unknown,
	path: string,
	side: "request" | "response",
	findings: Finding[],
	seen: Set<string>,
): void {
	const key = `${path}|${side}`;
	if (seen.has(key)) return;
	seen.add(key);

	const oldS = deref(docOld, oldSchema);
	const newS = deref(docNew, newSchema);
	if (!oldS || !newS) return;

	// Type change (e.g. string -> object) breaks every typed client.
	const oldType = oldS.type ?? (isObject(oldS.properties) ? "object" : undefined);
	const newType = newS.type ?? (isObject(newS.properties) ? "object" : undefined);
	if (typeof oldType === "string" && typeof newType === "string" && oldType !== newType) {
		findings.push({
			breaking: true,
			message: `${path}: type changed ${oldType} -> ${newType}`,
		});
		return;
	}

	// Enum narrowing: values clients may legitimately send/receive disappear.
	if (Array.isArray(oldS.enum) && Array.isArray(newS.enum)) {
		const newValues = new Set(newS.enum.map((v) => JSON.stringify(v)));
		const removed = oldS.enum.filter((v) => !newValues.has(JSON.stringify(v)));
		if (removed.length > 0) {
			findings.push({
				breaking: true,
				message: `${path}: enum removed ${removed.map((v) => JSON.stringify(v)).join(", ")}`,
			});
		}
	}

	// Object properties.
	const oldProps = isObject(oldS.properties) ? oldS.properties : undefined;
	const newProps = isObject(newS.properties) ? newS.properties : undefined;
	if (oldProps && newProps) {
		const oldRequired = new Set(Array.isArray(oldS.required) ? (oldS.required as string[]) : []);
		const newRequired = new Set(Array.isArray(newS.required) ? (newS.required as string[]) : []);
		for (const [name, oldProp] of Object.entries(oldProps)) {
			const propPath = `${path}.${name}`;
			if (!(name in newProps)) {
				// Removing a response property breaks consumers reading it;
				// removing an optional request property is client-safe.
				findings.push({
					breaking: side === "response" || oldRequired.has(name),
					message: `${propPath}: property removed (${side})`,
				});
				continue;
			}
			compareSchema(
				docOld,
				docNew,
				oldProp,
				newProps[name],
				propPath,
				side,
				findings,
				seen,
			);
		}
		for (const name of Object.keys(newProps)) {
			if (newRequired.has(name) && !oldRequired.has(name) && side === "request") {
				findings.push({
					breaking: true,
					message: `${path}.${name}: became required (request)`,
				});
			}
		}
	}

	// Array item schemas recurse.
	if (isObject(oldS.items) && isObject(newS.items)) {
		compareSchema(docOld, docNew, oldS.items, newS.items, `${path}[]`, side, findings, seen);
	}
}

function compareOperation(
	docOld: Json,
	docNew: Json,
	pathKey: string,
	method: string,
	oldOp: Json,
	newOp: Json,
	findings: Finding[],
): void {
	const opId = `${method.toUpperCase()} ${pathKey}`;

	// Request bodies: newly required, or newly required schema properties.
	const oldBody = isObject(oldOp.requestBody) ? oldOp.requestBody : undefined;
	const newBody = isObject(newOp.requestBody) ? newOp.requestBody : undefined;
	if (newBody && !oldBody) {
		findings.push({ breaking: true, message: `${opId}: request body became required` });
	} else if (oldBody && newBody) {
		const oldRequired = oldBody.required === true;
		const newRequired = newBody.required === true;
		if (newRequired && !oldRequired) {
			findings.push({ breaking: true, message: `${opId}: request body became required` });
		}
		const oldContent = isObject(oldBody.content) ? oldBody.content : {};
		const newContent = isObject(newBody.content) ? newBody.content : {};
		for (const [media, oldEntry] of Object.entries(oldContent)) {
			const newEntry = isObject(newContent[media]) ? (newContent[media] as Json) : undefined;
			if (!newEntry) {
				findings.push({
					breaking: true,
					message: `${opId}: request media type ${media} removed`,
				});
				continue;
			}
			compareSchema(
				docOld,
				docNew,
				isObject(oldEntry) ? oldEntry.schema : undefined,
				newEntry.schema,
				`${opId} request ${media}`,
				"request",
				findings,
				new Set(),
			);
		}
	}

	// Parameters: newly required ones break callers that omit them.
	const oldParams = Array.isArray(oldOp.parameters) ? (oldOp.parameters as Json[]) : [];
	const newParams = Array.isArray(newOp.parameters) ? (newOp.parameters as Json[]) : [];
	for (const param of newParams) {
		if (param.required !== true) continue;
		const match = oldParams.find(
			(p) => p.name === param.name && p.in === param.in,
		);
		if (match?.required !== true) {
			findings.push({
				breaking: true,
				message: `${opId}: ${param.in} parameter ${String(param.name)} became required`,
			});
		}
	}

	// Responses: compare every shared status code's schemas.
	const oldResponses = isObject(oldOp.responses) ? oldOp.responses : {};
	const newResponses = isObject(newOp.responses) ? newOp.responses : {};
	for (const [status, oldResp] of Object.entries(oldResponses)) {
		const newResp = isObject(newResponses[status]) ? (newResponses[status] as Json) : undefined;
		if (!newResp) {
			findings.push({ breaking: true, message: `${opId}: response ${status} removed` });
			continue;
		}
		if (!status.startsWith("2")) continue;
		const oldContent = isObject(oldResp) && isObject(oldResp.content) ? oldResp.content : {};
		const newContent = isObject(newResp.content) ? newResp.content : {};
		for (const [media, oldEntry] of Object.entries(oldContent)) {
			const newEntry = isObject(newContent[media]) ? (newContent[media] as Json) : undefined;
			if (!newEntry) {
				findings.push({
					breaking: true,
					message: `${opId}: response ${status} media type ${media} removed`,
				});
				continue;
			}
			compareSchema(
				docOld,
				docNew,
				isObject(oldEntry) ? oldEntry.schema : undefined,
				newEntry.schema,
				`${opId} ${status} ${media}`,
				"response",
				findings,
				new Set(),
			);
		}
	}
}

function compareDocuments(oldDoc: Json, newDoc: Json): Finding[] {
	const findings: Finding[] = [];
	const oldPaths = isObject(oldDoc.paths) ? oldDoc.paths : {};
	const newPaths = isObject(newDoc.paths) ? newDoc.paths : {};

	for (const [pathKey, oldPath] of Object.entries(oldPaths)) {
		const newPath = isObject(newPaths[pathKey]) ? (newPaths[pathKey] as Json) : undefined;
		if (!newPath) {
			findings.push({ breaking: true, message: `path ${pathKey} removed` });
			continue;
		}
		if (!isObject(oldPath)) continue;
		for (const method of HTTP_METHODS) {
			const oldOp = isObject(oldPath[method]) ? (oldPath[method] as Json) : undefined;
			if (!oldOp) continue;
			const newOp = isObject(newPath[method]) ? (newPath[method] as Json) : undefined;
			if (!newOp) {
				findings.push({ breaking: true, message: `operation ${method.toUpperCase()} ${pathKey} removed` });
				continue;
			}
			compareOperation(oldDoc, newDoc, pathKey, method, oldOp, newOp, findings);
		}
	}
	return findings;
}

/** Stable stringify: keys sorted so formatting never shows up as drift. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isObject(value)) {
		const entries = Object.keys(value)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

let failed = false;
for (const service of SERVICES) {
	const baselinePath = resolve(root, "docs/openapi", `${service.name}.json`);
	const current = await service.generate();

	if (update) {
		await mkdir(dirname(baselinePath), { recursive: true });
		await writeFile(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
		console.log(`${service.name}: baseline updated -> docs/openapi/${service.name}.json`);
		continue;
	}

	let baselineText: string;
	try {
		baselineText = await readFile(baselinePath, "utf8");
	} catch {
		console.error(
			`${service.name}: no committed baseline at docs/openapi/${service.name}.json — run 'bun run openapi:update'.`,
		);
		failed = true;
		continue;
	}
	const baseline = JSON.parse(baselineText) as Json;

	if (canonical(baseline) === canonical(current)) {
		console.log(`${service.name}: document matches the committed baseline.`);
		continue;
	}

	const findings = compareDocuments(baseline, current);
	const breaking = findings.filter((f) => f.breaking);
	const safe = findings.filter((f) => !f.breaking);

	if (breaking.length > 0) {
		failed = true;
		console.error(`${service.name}: BREAKING changes against the committed baseline:`);
		for (const f of breaking) console.error(`  - ${f.message}`);
		console.error(
			"  Breaking changes need an API-version bump and a CHANGELOG note, then 'bun run openapi:update'.",
		);
	}
	if (breaking.length === 0 || safe.length > 0) {
		failed = true;
		console.error(`${service.name}: document drifted from the committed baseline:`);
		if (safe.length === 0 && breaking.length === 0) {
			console.error("  - descriptions, examples or other prose changed");
		}
		for (const f of safe) console.error(`  - ${f.message}`);
		if (breaking.length === 0) {
			console.error("  Changes are client-safe: run 'bun run openapi:update' and commit the result.");
		}
	}
}

if (failed) process.exit(1);
console.log(`OpenAPI compatibility check passed (${SERVICES.length} services).`);
