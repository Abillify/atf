// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Generates the "Gate configuration file (YAML)" section of
 * `docs/CONFIGURATION.md` from the Gate's Zod schema.
 *
 * The section is imported by `scripts/generate-config-reference.ts` (not wired
 * through `package.json`) so that `config-reference` and `config-reference:check`
 * include it automatically.
 *
 * The parser is deliberately static: it never imports or evaluates the schema.
 * It masks comments, strings, template literals and regex literals, then walks
 * the remaining source text for `z.object({ … })` calls (including the ones
 * reached through `.and(…)`, `z.preprocess(…)`, `z.array(…)`, `z.record(…)`,
 * `z.union([...])`, `z.discriminatedUnion(…)` and same-file named schema
 * references) and emits one row per object-literal property.
 *
 * Note on the TypeScript compiler API: this repository pins TypeScript 7,
 * whose main entry no longer exposes the classic `createSourceFile` API, so the
 * masking walker below replaces it. The facts extracted (key path, first call
 * of the Zod chain, `.default(<literal>)`, leading JSDoc) are the same ones the
 * spec asks for and are stable in the source text.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_DEPTH = 16;

/** Keywords after which a `/` starts a regex literal instead of a division. */
const REGEX_KEYWORDS = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"throw",
	"case",
	"do",
	"else",
	"yield",
	"await",
]);

interface CommentRange {
	start: number;
	end: number;
	jsdoc: boolean;
}

interface DeclRange {
	start: number;
	end: number;
}

export interface GateKeyRow {
	key: string;
	type: string;
	def: string;
	description: string;
}

class GateSchemaParser {
	private readonly src: string;
	private readonly masked: string;
	private readonly comments: CommentRange[] = [];
	private readonly decls = new Map<string, DeclRange>();
	private readonly rows = new Map<string, GateKeyRow>();

	constructor(source: string) {
		this.src = source;
		const { masked, comments } = maskSource(source);
		this.masked = masked;
		this.comments = comments;
		this.collectDecls();
	}

	build(): GateKeyRow[] {
		const root = this.decls.get("AppConfigSchema");
		if (!root) {
			throw new Error(
				"AppConfigSchema not found in apps/gate/src/config/schema.ts",
			);
		}
		this.scanRegion(root.start, root.end, "", 0, new Set());
		return [...this.rows.values()].sort((a, b) => a.key.localeCompare(b.key));
	}

	// ----------------------------------------------------------------- setup

	private collectDecls(): void {
		const pattern =
			/(?:^|[\s;}])(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=;]*)?=/g;
		for (const match of this.masked.matchAll(pattern)) {
			const name = match[1];
			const eq = (match.index ?? 0) + match[0].lastIndexOf("=");
			const start = this.skipWs(eq + 1);
			const end = this.declEnd(start);
			if (!this.decls.has(name)) this.decls.set(name, { start, end });
		}
	}

	/** End of an initializer: the first depth-0 `;` after it (or EOF). */
	private declEnd(start: number): number {
		let nest = 0;
		for (let i = start; i < this.src.length; i++) {
			const c = this.masked[i];
			if (c === "(" || c === "[" || c === "{") nest++;
			else if (c === ")" || c === "]" || c === "}") nest--;
			else if (c === ";" && nest === 0) return i;
		}
		return this.src.length;
	}

	// ------------------------------------------------------- region walking

	/**
	 * Walks [start,end) at nesting level 0 and descends into every construct
	 * that can carry object-literal schema properties.
	 */
	private scanRegion(
		start: number,
		end: number,
		prefix: string,
		depth: number,
		visited: Set<string>,
	): void {
		if (depth > MAX_DEPTH) return;
		let i = start;
		let nest = 0;
		while (i < end) {
			const c = this.masked[i];
			if (c === "(" || c === "[" || c === "{") {
				nest++;
				i++;
				continue;
			}
			if (c === ")" || c === "]" || c === "}") {
				nest--;
				i++;
				continue;
			}
			if (nest !== 0) {
				i++;
				continue;
			}
			if (!this.isIdentStart(i)) {
				i++;
				continue;
			}
			const wordStart = i;
			let j = i;
			while (this.isIdentPart(j)) j++;
			const word = this.src.slice(wordStart, j);
			const call = this.memberCall(j);
			if (call) {
				this.handleCall(
					word,
					call.member,
					call.argStart,
					call.argEnd,
					prefix,
					depth,
					visited,
				);
				i = call.argEnd + 1;
				continue;
			}
			if (this.prevSignificant(wordStart) !== "." && this.decls.has(word)) {
				this.resolveRef(word, prefix, depth, visited);
			}
			i = j;
		}
	}

	private handleCall(
		word: string,
		member: string,
		argStart: number,
		argEnd: number,
		prefix: string,
		depth: number,
		visited: Set<string>,
	): void {
		switch (member) {
			case "object": {
				const open = this.skipWs(argStart);
				if (this.masked[open] === "{") {
					const close = this.matchDelim(open);
					this.processObjectLiteral(open, close, prefix, depth, visited);
				}
				break;
			}
			case "preprocess": {
				const args = this.splitArgs(argStart, argEnd);
				const inner = args[1];
				if (inner) this.scanRegion(inner[0], inner[1], prefix, depth + 1, visited);
				break;
			}
			case "array": {
				const args = this.splitArgs(argStart, argEnd);
				const inner = args[0];
				if (inner)
					this.scanRegion(
						inner[0],
						inner[1],
						this.arrayPrefix(prefix),
						depth + 1,
						visited,
					);
				break;
			}
			case "record": {
				const args = this.splitArgs(argStart, argEnd);
				const inner = args[1];
				if (inner)
					this.scanRegion(
						inner[0],
						inner[1],
						`${prefix}*.`,
						depth + 1,
						visited,
					);
				break;
			}
			case "union":
			case "xor":
			case "discriminatedUnion": {
				const args = this.splitArgs(argStart, argEnd);
				const list = member === "discriminatedUnion" ? args[1] : args[0];
				if (list) {
					for (const element of this.splitArgs(...this.unwrapArray(list))) {
						this.scanRegion(element[0], element[1], prefix, depth + 1, visited);
					}
				}
				break;
			}
			case "optional":
			case "nullable":
			case "nullish":
			case "lazy":
			case "and":
			case "or":
			case "intersection": {
				const args = this.splitArgs(argStart, argEnd);
				const inner = args[0];
				if (inner) this.scanRegion(inner[0], inner[1], prefix, depth + 1, visited);
				break;
			}
			default:
				break;
		}
		// The receiver of the call may itself be a named schema whose properties
		// belong to the same path (e.g. `ServerConfigSchema.prefault({})`).
		if (word !== "z" && this.decls.has(word)) {
			this.resolveRef(word, prefix, depth, visited);
		}
	}

	/** Turns `apps.` into `apps[].` for properties of an array's item schema. */
	private arrayPrefix(prefix: string): string {
		return `${prefix.replace(/\.$/, "")}[].`;
	}

	private resolveRef(
		word: string,
		prefix: string,
		depth: number,
		visited: Set<string>,
	): void {
		const key = `${word}@${prefix}`;
		if (visited.has(key) || depth > MAX_DEPTH) return;
		visited.add(key);
		const decl = this.decls.get(word);
		if (!decl) return;
		this.scanRegion(decl.start, decl.end, prefix, depth + 1, visited);
	}

	// ---------------------------------------------------- object literals

	private processObjectLiteral(
		open: number,
		close: number,
		prefix: string,
		depth: number,
		visited: Set<string>,
	): void {
		let i = open + 1;
		while (i < close) {
			while (i < close && /[\s,]/.test(this.masked[i])) i++;
			if (i >= close) break;
			const keyStart = i;
			let key: string;
			if (this.masked[i] === '"' || this.masked[i] === "'") {
				const strEnd = this.stringEnd(i);
				key = this.src.slice(i + 1, strEnd - 1);
				i = strEnd;
			} else if (this.isIdentStart(i)) {
				let j = i;
				while (this.isIdentPart(j)) j++;
				key = this.src.slice(i, j);
				i = j;
			} else {
				i++;
				continue;
			}
			i = this.skipWs(i);
			if (this.masked[i] !== ":") continue;
			i = this.skipWs(i + 1);
			const valueStart = i;
			let nest = 0;
			let j = i;
			while (j < close) {
				const c = this.masked[j];
				if (c === "(" || c === "[" || c === "{") nest++;
				else if (c === ")" || c === "]" || c === "}") {
					if (nest === 0) break;
					nest--;
				} else if (c === "," && nest === 0) break;
				j++;
			}
			const valueEnd = j;
			this.emit(key, valueStart, valueEnd, prefix, keyStart);
			this.scanRegion(
				valueStart,
				valueEnd,
				`${prefix}${key}.`,
				depth + 1,
				visited,
			);
			i = valueEnd;
		}
	}

	private emit(
		key: string,
		valueStart: number,
		valueEnd: number,
		prefix: string,
		keyStart: number,
	): void {
		const path = `${prefix}${key}`;
		const type = this.typeOf(valueStart, valueEnd, 0, new Set());
		const def = this.defaultOf(valueStart, valueEnd);
		const description = this.descriptionBefore(keyStart);
		const existing = this.rows.get(path);
		if (!existing) {
			this.rows.set(path, { key: path, type, def, description });
			return;
		}
		if (existing.type !== type && !existing.type.includes(type)) {
			existing.type = `${existing.type} | ${type}`;
		}
		if (existing.def === "—" && def !== "—") existing.def = def;
		if (!existing.description && description) existing.description = description;
	}

	// ------------------------------------------------------------- typing

	private typeOf(
		start: number,
		end: number,
		depth: number,
		seen: Set<string>,
	): string {
		if (depth > MAX_DEPTH) return "unknown";
		const i = this.skipWs(start);
		if (i >= end || !this.isIdentStart(i)) return "unknown";
		let j = i;
		while (this.isIdentPart(j)) j++;
		const word = this.src.slice(i, j);
		const call = this.memberCall(j, end);
		if (call) return this.typeOfCall(word, call.member, call.argStart, call.argEnd, depth, seen);
		// Property access without a call, e.g. the `z.coerce` head of
		// `z.coerce.number()`: continue the chain from the member.
		const p = this.skipWs(j);
		if (this.masked[p] === ".") {
			return this.typeOf(this.skipWs(p + 1), end, depth + 1, seen);
		}
		return this.resolveWordType(word, depth, seen);
	}

	private typeOfCall(
		word: string,
		member: string,
		argStart: number,
		argEnd: number,
		depth: number,
		seen: Set<string>,
	): string {
		if (word === "coerce") return member;
		if (word !== "z") {
			// A modifier on a named schema (`Schema.default(…)`, `Schema.optional()`)
			// keeps the schema's own type.
			return this.resolveWordType(word, depth, seen);
		}
		switch (member) {
			case "string":
				return "string";
			case "number":
			case "nan":
				return "number";
			case "boolean":
				return "boolean";
			case "date":
				return "date";
			case "bigint":
				return "bigint";
			case "symbol":
				return "symbol";
			case "array":
				return "array";
			case "object":
				return "object";
			case "record":
				return "record";
			case "map":
				return "map";
			case "set":
				return "set";
			case "tuple":
				return "tuple";
			case "function":
				return "function";
			case "promise":
				return "promise";
			case "any":
				return "any";
			case "unknown":
				return "unknown";
			case "never":
				return "never";
			case "null":
				return "null";
			case "undefined":
				return "undefined";
			case "enum":
			case "nativeEnum":
				return this.enumValues(argStart, argEnd);
			case "literal": {
				const args = this.splitArgs(argStart, argEnd);
				const arg = args[0];
				if (!arg) return "literal";
				return this.literalize(arg[0], arg[1]) ?? "literal";
			}
			case "union":
			case "xor": {
				const args = this.splitArgs(argStart, argEnd);
				const list = args[0];
				if (!list) return "union";
				const types = [
					...new Set(
						this.splitArgs(...this.unwrapArray(list)).map((element) =>
							this.typeOf(element[0], element[1], depth + 1, seen),
						),
					),
				];
				return types.join(" | ");
			}
			case "discriminatedUnion":
				return "union";
			case "preprocess": {
				const args = this.splitArgs(argStart, argEnd);
				const inner = args[1];
				if (!inner) return "unknown";
				return this.typeOf(inner[0], inner[1], depth + 1, seen);
			}
			case "lazy":
			case "pipe": {
				const args = this.splitArgs(argStart, argEnd);
				const inner = args[0];
				if (!inner) return "unknown";
				return this.typeOf(inner[0], inner[1], depth + 1, seen);
			}
			default:
				return "unknown";
		}
	}

	private resolveWordType(word: string, depth: number, seen: Set<string>): string {
		if (seen.has(word)) return "unknown";
		const decl = this.decls.get(word);
		if (!decl) return "unknown";
		seen.add(word);
		return this.typeOf(decl.start, decl.end, depth + 1, seen);
	}

	private enumValues(argStart: number, argEnd: number): string {
		const open = this.skipWs(argStart, argEnd);
		if (this.masked[open] !== "[") return "enum";
		const close = this.matchDelim(open, argEnd);
		const values = this.splitArgs(open + 1, close)
			.map((arg) => this.literalize(arg[0], arg[1]))
			.filter((value): value is string => value !== null);
		return values.length > 0 ? values.join(" | ") : "enum";
	}

	// ----------------------------------------------------------- defaults

	private defaultOf(start: number, end: number): string {
		let nest = 0;
		for (let i = start; i < end; i++) {
			const c = this.masked[i];
			if (c === "(" || c === "[" || c === "{") {
				nest++;
				continue;
			}
			if (c === ")" || c === "]" || c === "}") {
				nest--;
				continue;
			}
			if (nest !== 0 || c !== ".") continue;
			const nameStart = this.skipWs(i + 1);
			let nameEnd = nameStart;
			while (this.isIdentPart(nameEnd)) nameEnd++;
			if (this.src.slice(nameStart, nameEnd) !== "default") continue;
			const paren = this.skipWs(nameEnd);
			if (this.masked[paren] !== "(") continue;
			const close = this.matchDelim(paren);
			const args = this.splitArgs(paren + 1, close);
			const arg = args[0];
			if (!arg) return "—";
			return this.literalize(arg[0], arg[1]) ?? "—";
		}
		return "—";
	}

	/** Compact single-line rendering of a literal, or null if not a literal. */
	private literalize(start: number, end: number): string | null {
		const trimmedStart = this.skipWs(start, end);
		let trimmedEnd = end;
		while (trimmedEnd > trimmedStart && /\s/.test(this.masked[trimmedEnd - 1]))
			trimmedEnd--;
		if (trimmedEnd <= trimmedStart) return null;
		const first = this.masked[trimmedStart];
		if (first === '"' || first === "'" || first === "`") {
			const strEnd = this.stringEnd(trimmedStart);
			if (strEnd !== trimmedEnd) return null;
			return this.src.slice(trimmedStart, trimmedEnd);
		}
		if (/^-?[\d_]+(\.[\d_]+)?([eE][+-]?\d+)?$/.test(
			this.src.slice(trimmedStart, trimmedEnd),
		)) {
			return this.src.slice(trimmedStart, trimmedEnd).replaceAll("_", "");
		}
		const raw = this.src.slice(trimmedStart, trimmedEnd);
		if (raw === "true" || raw === "false" || raw === "null") return raw;
		if (first === "[") {
			const close = this.matchDelim(trimmedStart);
			if (close !== trimmedEnd) return null;
			const items: string[] = [];
			for (const arg of this.splitArgs(trimmedStart + 1, close)) {
				const value = this.literalize(arg[0], arg[1]);
				if (value === null) return null;
				items.push(value);
			}
			return `[${items.join(", ")}]`;
		}
		if (first === "{") {
			const close = this.matchDelim(trimmedStart);
			if (close !== trimmedEnd) return null;
			const parts: string[] = [];
			for (const arg of this.splitArgs(trimmedStart + 1, close)) {
				const [keyText, valueText] = this.splitKeyValue(arg[0], arg[1]);
				if (!keyText || !valueText) return null;
				const value = this.literalize(valueText[0], valueText[1]);
				if (value === null) return null;
				parts.push(
					`${this.src.slice(keyText[0], keyText[1]).trim()}: ${value}`,
				);
			}
			return `{ ${parts.join(", ")} }`;
		}
		return null;
	}

	private splitKeyValue(
		start: number,
		end: number,
	): [[number, number], [number, number]] | null {
		let nest = 0;
		for (let i = start; i < end; i++) {
			const c = this.masked[i];
			if (c === "(" || c === "[" || c === "{") nest++;
			else if (c === ")" || c === "]" || c === "}") nest--;
			else if (c === ":" && nest === 0) {
				return [
					[start, i],
					[this.skipWs(i + 1, end), end],
				];
			}
		}
		return null;
	}

	// -------------------------------------------------------- descriptions

	private descriptionBefore(keyStart: number): string {
		let best: CommentRange | null = null;
		let boundary = keyStart;
		for (let i = this.comments.length - 1; i >= 0; i--) {
			const comment = this.comments[i];
			if (comment.start >= keyStart) continue;
			if (comment.end > boundary) continue;
			if (this.src.slice(comment.end, boundary).trim() !== "") break;
			if (!comment.jsdoc) break;
			best = comment;
			boundary = comment.start;
			break;
		}
		if (!best) return "";
		return cleanJsDoc(this.src.slice(best.start, best.end));
	}

	// ------------------------------------------------------------- helpers

	private memberCall(
		afterWord: number,
		limit = this.src.length,
	): { member: string; argStart: number; argEnd: number } | null {
		const dot = this.skipWs(afterWord, limit);
		if (this.masked[dot] !== ".") return null;
		const nameStart = this.skipWs(dot + 1, limit);
		if (!this.isIdentStart(nameStart)) return null;
		let nameEnd = nameStart;
		while (this.isIdentPart(nameEnd)) nameEnd++;
		const paren = this.skipWs(nameEnd, limit);
		if (this.masked[paren] !== "(") return null;
		const close = this.matchDelim(paren, limit);
		return { member: this.src.slice(nameStart, nameEnd), argStart: paren + 1, argEnd: close };
	}

	/** Index of the delimiter matching the one at `open`. */
	private matchDelim(open: number, limit = this.src.length): number {
		const opener = this.masked[open];
		const closer = opener === "(" ? ")" : opener === "[" ? "]" : "}";
		let nest = 0;
		for (let i = open; i < limit; i++) {
			if (this.masked[i] === opener) nest++;
			else if (this.masked[i] === closer) {
				nest--;
				if (nest === 0) return i;
			}
		}
		return limit;
	}

	private splitArgs(start: number, end: number): [number, number][] {
		const args: [number, number][] = [];
		let nest = 0;
		let current = start;
		for (let i = start; i < end; i++) {
			const c = this.masked[i];
			if (c === "(" || c === "[" || c === "{") nest++;
			else if (c === ")" || c === "]" || c === "}") nest--;
			else if (c === "," && nest === 0) {
				args.push([current, i]);
				current = i + 1;
			}
		}
		if (this.src.slice(current, end).trim() !== "") args.push([current, end]);
		return args;
	}

	/**
	 * `z.union([...])` and friends pass their members as an array literal;
	 * unwrap `[ … ]` so `splitArgs` sees the members as top-level commas.
	 */
	private unwrapArray(range: [number, number]): [number, number] {
		const open = this.skipWs(range[0], range[1]);
		if (this.masked[open] !== "[") return range;
		const close = this.matchDelim(open, range[1]);
		return [open + 1, close];
	}

	private stringEnd(start: number): number {
		const quote = this.src[start];
		let i = start + 1;
		while (i < this.src.length) {
			if (this.src[i] === "\\") {
				i += 2;
				continue;
			}
			if (this.src[i] === quote) return i + 1;
			if (this.src[i] === "\n") return i;
			i++;
		}
		return this.src.length;
	}

	private skipWs(from: number, limit = this.src.length): number {
		let i = from;
		while (i < limit && /\s/.test(this.masked[i])) i++;
		return i;
	}

	private prevSignificant(index: number): string {
		let i = index - 1;
		while (i >= 0 && /\s/.test(this.masked[i])) i--;
		return i >= 0 ? this.masked[i] : "";
	}

	private isIdentStart(index: number): boolean {
		return /[A-Za-z_$]/.test(this.masked[index] ?? "");
	}

	private isIdentPart(index: number): boolean {
		return /[A-Za-z0-9_$]/.test(this.masked[index] ?? "");
	}
}

/**
 * Blanks comments, string/template contents and regex literals so structural
 * scanning cannot be fooled by delimiters inside them. Positions and newlines
 * are preserved; the original text is still used to read actual values.
 */
function maskSource(src: string): { masked: string; comments: CommentRange[] } {
	const chars: string[] = [...src];
	const comments: CommentRange[] = [];
	const blank = (from: number, to: number) => {
		for (let k = from; k < to && k < src.length; k++) {
			if (src[k] !== "\n") chars[k] = " ";
		}
	};
	const templateReturn: number[] = [];
	let depth = 0;
	let inTemplate = false;
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (!inTemplate) {
			if (c === "/" && src[i + 1] === "/") {
				const start = i;
				while (i < src.length && src[i] !== "\n") i++;
				blank(start, i);
				comments.push({ start, end: i, jsdoc: false });
				continue;
			}
			if (c === "/" && src[i + 1] === "*") {
				const start = i;
				i += 2;
				while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
				i = Math.min(i + 2, src.length);
				blank(start, i);
				comments.push({
					start,
					end: i,
					jsdoc: src.startsWith("/**", start) && !src.startsWith("/**/", start),
				});
				continue;
			}
			if (c === '"' || c === "'") {
				const start = i;
				i++;
				while (i < src.length) {
					if (src[i] === "\\") {
						i += 2;
						continue;
					}
					if (src[i] === c) {
						i++;
						break;
					}
					if (src[i] === "\n") break;
					i++;
				}
				blank(start + 1, Math.max(start + 1, i - 1));
				continue;
			}
			if (c === "`") {
				blank(i, i + 1);
				inTemplate = true;
				i++;
				continue;
			}
			if (c === "/" && isRegexPosition(chars, i)) {
				const start = i;
				i++;
				let inClass = false;
				while (i < src.length) {
					const d = src[i];
					if (d === "\\") {
						i += 2;
						continue;
					}
					if (d === "[") inClass = true;
					else if (d === "]") inClass = false;
					else if (d === "/" && !inClass) {
						i++;
						break;
					} else if (d === "\n") break;
					i++;
				}
				while (i < src.length && /[a-z]/.test(src[i])) i++;
				blank(start, i);
				continue;
			}
			if (c === "{") depth++;
			else if (c === "}") {
				// `${` pushed the depth *before* incrementing, so the interpolation's
				// own `}` is the one seen at pushed depth + 1.
				if (
					templateReturn.length > 0 &&
					depth === templateReturn[templateReturn.length - 1] + 1
				) {
					templateReturn.pop();
					blank(i, i + 1);
					inTemplate = true;
					depth--;
					i++;
					continue;
				}
				depth--;
			}
			i++;
			continue;
		}
		// Inside a template literal: contents are data, `${ … }` is code again.
		if (c === "\\") {
			blank(i, i + 2);
			i += 2;
			continue;
		}
		if (c === "`") {
			blank(i, i + 1);
			inTemplate = false;
			i++;
			continue;
		}
		if (c === "$" && src[i + 1] === "{") {
			blank(i, i + 2);
			templateReturn.push(depth);
			depth++;
			inTemplate = false;
			i += 2;
			continue;
		}
		blank(i, i + 1);
		i++;
	}
	return { masked: chars.join(""), comments };
}

function isRegexPosition(chars: string[], index: number): boolean {
	let j = index - 1;
	while (j >= 0 && /\s/.test(chars[j])) j--;
	if (j < 0) return true;
	const c = chars[j];
	if (/[)\]}'"`]/.test(c) || /[A-Za-z0-9_$.]/.test(c)) {
		let k = j;
		while (k >= 0 && /[A-Za-z0-9_$]/.test(chars[k])) k--;
		return REGEX_KEYWORDS.has(chars.slice(k + 1, j + 1).join(""));
	}
	return true;
}

function cleanJsDoc(comment: string): string {
	const body = comment.replace(/^\/\*\*?/, "").replace(/\*\/$/, "");
	const lines = body
		.split("\n")
		.map((line) => line.replace(/^\s*\*+\s?/, "").trim())
		.filter((line) => line !== "");
	return lines
		.join(" ")
		.replace(/\{@link\s+([^}]+)\}/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

function cell(text: string): string {
	return text.replaceAll("\n", " ").replaceAll(/\s+/g, " ").replaceAll("|", "\\|").trim();
}

/** Renders the markdown section appended to `docs/CONFIGURATION.md`. */
export function buildGateConfigReference(source: string): string {
	const rows = new GateSchemaParser(source).build();
	const lines = [
		"## Gate configuration file (YAML)",
		"",
		"Generated from apps/gate/src/config/schema.ts by bun run config-reference. Keys are relative to the Gate's config.yaml.",
		"",
		"| Key (dotted) | Type | Default | Description |",
		"| --- | --- | --- | --- |",
	];
	for (const row of rows) {
		lines.push(
			`| \`${cell(row.key)}\` | ${cell(row.type) || "—"} | ${
				row.def === "—" ? "—" : `\`${cell(row.def)}\``
			} | ${cell(row.description) || "—"} |`,
		);
	}
	return lines.join("\n");
}

if (import.meta.main) {
	const schemaPath = resolve(process.cwd(), "apps/gate/src/config/schema.ts");
	const source = await readFile(schemaPath, "utf8");
	process.stdout.write(`${buildGateConfigReference(source)}\n`);
}
