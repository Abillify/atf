// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pipeline/native/eml.ts
 *
 * Native parser for RFC 5322 e-mail (`.eml`): MIME structure, transfer and
 * header encodings, the threading headers, the body text and the attachments.
 * No dependency and no model call — an e-mail is text already.
 *
 * What it handles:
 *
 *  - header unfolding, RFC 2047 encoded words (`=?utf-8?Q?…?=`, B and Q, split
 *    across adjacent words) and raw UTF-8 header bytes (RFC 6532);
 *  - `multipart/*` trees of any depth, `base64` / `quoted-printable` / 7bit /
 *    8bit / binary transfer encodings, every charset the runtime's TextDecoder
 *    knows (the WHATWG set: windows-125x, iso-8859-x, koi8, Shift_JIS, GBK …);
 *  - RFC 2231 parameters (`filename*=utf-8''…`, continuations `name*0*=`);
 *  - body selection: the first `text/plain` outside an attachment, else the
 *    first `text/html` converted to text (see {@link htmlToText});
 *  - attachments: parts with `Content-Disposition: attachment`, a file name, or
 *    a non-text type; an embedded `message/rfc822` is an attachment `*.eml`.
 *    Inline images (signature logos referenced by `cid:`) are dropped.
 *
 * {@link stripQuotedReply} then removes the quoted history below a reply, so a
 * thread indexes each message's own words once rather than every earlier
 * message again in every reply.
 */

/** A mailbox as written in an address header. */
export interface EmailMailbox {
	name?: string;
	address: string;
}

/** An attachment of the message, bytes decoded. */
export interface EmailAttachment {
	filename: string;
	mimeType: string;
	content: Uint8Array;
	/** `Content-Disposition: inline` (or referenced by Content-ID). */
	inline: boolean;
	contentId?: string;
}

export interface ParsedEmail {
	/** `Message-ID` without angle brackets; null when the header is missing. */
	messageId: string | null;
	inReplyTo: string[];
	references: string[];
	/** Base64 of the first 22 bytes of Outlook's `Thread-Index` (the conversation root). */
	threadIndexRoot?: string;
	subject?: string;
	from?: EmailMailbox;
	to: EmailMailbox[];
	cc: EmailMailbox[];
	/** `Date` as RFC 3339, when parseable. */
	date?: string;
	/** The body as plain text (HTML converted), quotes still in. */
	text: string;
	/** True when the body came from `text/html`. */
	fromHtml: boolean;
	attachments: EmailAttachment[];
	warnings: string[];
}

// ─── Low-level decoding ───────────────────────────────────────────────────

/** Bytes → a "binary string" (one char per byte) the structure is parsed on. */
function toBinaryString(bytes: Uint8Array): string {
	let out = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return out;
}

function fromBinaryString(value: string): Uint8Array {
	const out = new Uint8Array(value.length);
	for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff;
	return out;
}

/** Decode bytes in a declared charset, falling back to UTF-8 then windows-1252. */
export function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
	const label = (charset ?? "").trim().toLowerCase().replace(/^["']|["']$/g, "");
	if (label !== "" && label !== "utf-8" && label !== "utf8") {
		try {
			return new TextDecoder(label).decode(bytes);
		} catch {
			// Unknown label: fall through to the UTF-8 / windows-1252 heuristic.
		}
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return new TextDecoder("windows-1252").decode(bytes);
	}
}

function decodeBase64(value: string): Uint8Array {
	const clean = value.replace(/[^A-Za-z0-9+/=]/g, "");
	return new Uint8Array(Buffer.from(clean, "base64"));
}

function decodeQuotedPrintable(value: string, header = false): Uint8Array {
	const bytes: number[] = [];
	const text = header ? value.replace(/_/g, " ") : value.replace(/=\r?\n/g, "");
	for (let i = 0; i < text.length; i++) {
		const ch = text.charAt(i);
		if (ch === "=" && i + 2 < text.length && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
			bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
			i += 2;
		} else {
			bytes.push(text.charCodeAt(i) & 0xff);
		}
	}
	return new Uint8Array(bytes);
}

/**
 * Decode a header value: RFC 2047 encoded words, and raw 8-bit bytes as UTF-8
 * (RFC 6532) with a windows-1252 fallback. Whitespace between two adjacent
 * encoded words is dropped, as the RFC requires.
 */
export function decodeHeaderValue(raw: string): string {
	const eightBit = /[\x80-\xff]/.test(raw) ? decodeCharset(fromBinaryString(raw), undefined) : raw;
	const encodedWord = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
	const joined = eightBit.replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?)/g, "$1");
	return joined.replace(encodedWord, (_m, charset: string, enc: string, text: string) => {
		const cs = charset.split("*")[0]; // RFC 2231 language suffix
		const bytes = enc.toUpperCase() === "B" ? decodeBase64(text) : decodeQuotedPrintable(text, true);
		return decodeCharset(bytes, cs);
	});
}

// ─── Header parsing ───────────────────────────────────────────────────────

interface HeaderField {
	name: string;
	/** Unfolded raw value (binary string, not yet decoded). */
	value: string;
}

function parseHeaderBlock(block: string): HeaderField[] {
	const fields: HeaderField[] = [];
	const lines = block.split(/\r?\n/);
	for (const line of lines) {
		const last = fields[fields.length - 1];
		if (/^[ \t]/.test(line) && last !== undefined) {
			last.value += ` ${line.trim()}`;
			continue;
		}
		const idx = line.indexOf(":");
		if (idx <= 0) continue; // an mbox "From " line or junk
		const name = line.slice(0, idx).trim().toLowerCase();
		if (!/^[!-9;-~]+$/.test(name)) continue;
		fields.push({ name, value: line.slice(idx + 1).trim() });
	}
	return fields;
}

function header(fields: HeaderField[], name: string): string | undefined {
	return fields.find((f) => f.name === name)?.value;
}

interface ParsedParams {
	value: string;
	params: Map<string, string>;
}

/**
 * Parse `type/subtype; a=b; c="d; e"` including RFC 2231 extended and
 * continued parameters. Returns the lower-cased main value and the decoded
 * parameters (names lower-cased).
 */
export function parseParameterizedHeader(raw: string | undefined): ParsedParams {
	const params = new Map<string, string>();
	if (raw === undefined) return { value: "", params };
	const parts: string[] = [];
	let current = "";
	let quoted = false;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw.charAt(i);
		if (ch === '"' && raw[i - 1] !== "\\") quoted = !quoted;
		if (ch === ";" && !quoted) {
			parts.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	parts.push(current);
	const value = (parts.shift() ?? "").trim().toLowerCase();

	const continuations = new Map<string, Array<{ index: number; text: string; encoded: boolean }>>();
	for (const part of parts) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		let name = part.slice(0, eq).trim().toLowerCase();
		let text = part.slice(eq + 1).trim();
		if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
			text = text.slice(1, -1).replace(/\\(.)/g, "$1");
		}
		const cont = /^(.+?)\*(\d+)(\*?)$/.exec(name);
		if (cont) {
			const base = cont[1] ?? name;
			const list = continuations.get(base) ?? [];
			list.push({ index: Number(cont[2]), text, encoded: cont[3] === "*" });
			continuations.set(base, list);
			continue;
		}
		if (name.endsWith("*")) {
			name = name.slice(0, -1);
			params.set(name, decodeRfc2231(text, true));
			continue;
		}
		params.set(name, decodeHeaderValue(text));
	}
	for (const [name, list] of continuations) {
		list.sort((a, b) => a.index - b.index);
		const first = list[0];
		let charset: string | undefined;
		let joinedBytes = "";
		for (const piece of list) {
			let text = piece.text;
			if (piece === first && piece.encoded) {
				const m = /^([^']*)'[^']*'(.*)$/.exec(text);
				if (m) {
					charset = m[1];
					text = m[2] ?? "";
				}
			}
			joinedBytes += piece.encoded ? percentDecodeToBinary(text) : text;
		}
		params.set(name, decodeCharset(fromBinaryString(joinedBytes), charset));
	}
	return { value, params };
}

function percentDecodeToBinary(text: string): string {
	return text.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function decodeRfc2231(text: string, extended: boolean): string {
	if (!extended) return text;
	const m = /^([^']*)'[^']*'(.*)$/.exec(text);
	if (!m) return decodeCharset(fromBinaryString(percentDecodeToBinary(text)), undefined);
	return decodeCharset(fromBinaryString(percentDecodeToBinary(m[2] ?? "")), m[1]);
}

// ─── Addresses and message ids ────────────────────────────────────────────

/** Split an address list on commas outside quotes, angle brackets and comments. */
function splitAddressList(value: string): string[] {
	const out: string[] = [];
	let current = "";
	let depthAngle = 0;
	let depthParen = 0;
	let quoted = false;
	for (let i = 0; i < value.length; i++) {
		const ch = value.charAt(i);
		if (ch === '"' && value[i - 1] !== "\\") quoted = !quoted;
		else if (!quoted) {
			if (ch === "<") depthAngle++;
			else if (ch === ">") depthAngle = Math.max(0, depthAngle - 1);
			else if (ch === "(") depthParen++;
			else if (ch === ")") depthParen = Math.max(0, depthParen - 1);
			else if ((ch === "," || ch === ";") && depthAngle === 0 && depthParen === 0) {
				out.push(current);
				current = "";
				continue;
			}
		}
		current += ch;
	}
	out.push(current);
	return out.map((s) => s.trim()).filter((s) => s !== "");
}

/** Parse an address header into mailboxes (groups flattened, names decoded). */
export function parseAddressList(raw: string | undefined): EmailMailbox[] {
	if (raw === undefined) return [];
	const decoded = decodeHeaderValue(raw);
	const out: EmailMailbox[] = [];
	for (let entry of splitAddressList(decoded)) {
		// "Group: a@b, c@d;" — drop the group label.
		const group = /^[^"<>@]*:\s*(.*)$/.exec(entry);
		if (group && !entry.includes("<") && group[1] !== undefined) entry = group[1];
		const angle = /^(.*)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/.exec(entry);
		if (angle) {
			const name = (angle[1] ?? "").trim().replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1").trim();
			out.push({ address: (angle[2] ?? "").toLowerCase(), ...(name !== "" ? { name } : {}) });
			continue;
		}
		const comment = /^([^\s()]+@[^\s()]+)\s*(?:\((.*)\))?$/.exec(entry);
		if (comment) {
			const name = comment[2]?.trim();
			out.push({ address: (comment[1] ?? "").toLowerCase(), ...(name ? { name } : {}) });
		}
	}
	return out;
}

/** Message ids of an In-Reply-To / References header, brackets removed. */
export function parseMessageIds(raw: string | undefined): string[] {
	if (raw === undefined) return [];
	const bracketed = [...raw.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1] ?? "");
	if (bracketed.length > 0) return [...new Set(bracketed)];
	return [...new Set(raw.split(/\s+/).filter((t) => t.includes("@")))];
}

/** The conversation root of an Outlook `Thread-Index` (its first 22 bytes). */
export function threadIndexRoot(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const bytes = decodeBase64(raw.trim());
	if (bytes.length < 22) return undefined;
	return Buffer.from(bytes.subarray(0, 22)).toString("base64");
}

function parseDate(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	// Drop a trailing "(CET)"-style comment Date.parse may choke on.
	const cleaned = raw.replace(/\([^)]*\)\s*$/, "").trim();
	const ms = Date.parse(cleaned);
	return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

// ─── MIME tree ────────────────────────────────────────────────────────────

interface MimePart {
	fields: HeaderField[];
	contentType: string;
	params: Map<string, string>;
	disposition: string;
	dispositionParams: Map<string, string>;
	/** The raw body, still transfer-encoded (binary string). */
	body: string;
	children: MimePart[];
}

const MAX_DEPTH = 12;

function splitHeaderBody(raw: string): { head: string; body: string } {
	const m = /\r?\n\r?\n/.exec(raw);
	if (m === null) return { head: raw, body: "" };
	return { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) };
}

function parsePart(raw: string, depth: number, warnings: string[]): MimePart {
	const { head, body } = splitHeaderBody(raw);
	const fields = parseHeaderBlock(head);
	const ct = parseParameterizedHeader(header(fields, "content-type") ?? "text/plain; charset=us-ascii");
	const cd = parseParameterizedHeader(header(fields, "content-disposition"));
	const part: MimePart = {
		fields,
		contentType: ct.value || "text/plain",
		params: ct.params,
		disposition: cd.value,
		dispositionParams: cd.params,
		body,
		children: [],
	};
	if (part.contentType.startsWith("multipart/")) {
		const boundary = ct.params.get("boundary");
		if (boundary === undefined || boundary === "") {
			warnings.push(`multipart part without boundary (${part.contentType}) treated as text`);
			return part;
		}
		if (depth >= MAX_DEPTH) {
			warnings.push("MIME nesting too deep; inner parts skipped");
			return part;
		}
		for (const chunk of splitMultipart(body, boundary)) {
			part.children.push(parsePart(chunk, depth + 1, warnings));
		}
	}
	return part;
}

/** The body parts between `--boundary` delimiters (preamble and epilogue dropped). */
function splitMultipart(body: string, boundary: string): string[] {
	const delimiter = `--${boundary}`;
	const lines = body.split(/(\r?\n)/);
	const parts: string[] = [];
	let current: string[] | null = null;
	for (let i = 0; i < lines.length; i += 2) {
		const line = lines[i] ?? "";
		const eol = lines[i + 1] ?? "";
		const trimmed = line.trimEnd();
		if (trimmed === delimiter || trimmed === `${delimiter}--`) {
			if (current !== null) {
				// The CRLF before a delimiter belongs to the delimiter.
				const text = current.join("");
				parts.push(text.replace(/\r?\n$/, ""));
			}
			if (trimmed.endsWith("--") && trimmed === `${delimiter}--`) return parts;
			current = [];
			continue;
		}
		if (current !== null) current.push(line, eol);
	}
	if (current !== null && current.length > 0) parts.push(current.join("").replace(/\r?\n$/, ""));
	return parts;
}

function transferDecode(part: MimePart): Uint8Array {
	const cte = (header(part.fields, "content-transfer-encoding") ?? "").trim().toLowerCase();
	if (cte === "base64") return decodeBase64(part.body);
	if (cte === "quoted-printable") return decodeQuotedPrintable(part.body);
	return fromBinaryString(part.body);
}

function partText(part: MimePart): string {
	return decodeCharset(transferDecode(part), part.params.get("charset"));
}

function partFilename(part: MimePart): string | undefined {
	const name = part.dispositionParams.get("filename") ?? part.params.get("name");
	if (name === undefined) return undefined;
	const clean = [...name.replace(/[\\/]/g, "_")]
		.filter((ch) => ch.charCodeAt(0) >= 0x20)
		.join("")
		.trim();
	return clean === "" ? undefined : clean;
}

const EXTENSION_FOR_TYPE: Record<string, string> = {
	"application/pdf": ".pdf",
	"message/rfc822": ".eml",
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"text/plain": ".txt",
	"text/html": ".html",
	"text/calendar": ".ics",
};

interface Collected {
	plain: string[];
	html: string[];
	attachments: EmailAttachment[];
}

function collect(part: MimePart, out: Collected, inAlternative: boolean): void {
	if (part.children.length > 0) {
		const alternative = part.contentType === "multipart/alternative";
		if (alternative) {
			// Take the plain alternative when there is one, else the richest.
			const plain = part.children.find((c) => c.contentType === "text/plain" && c.disposition !== "attachment");
			const chosen = plain ?? part.children[part.children.length - 1];
			for (const child of part.children) {
				if (child === chosen || child.children.length > 0 || isAttachment(child)) {
					collect(child, out, child !== chosen);
				}
			}
			return;
		}
		for (const child of part.children) collect(child, out, false);
		return;
	}
	if (isAttachment(part)) {
		const content = part.contentType === "message/rfc822" ? fromBinaryString(part.body) : transferDecode(part);
		const contentId = header(part.fields, "content-id")?.replace(/^<|>$/g, "");
		out.attachments.push({
			filename:
				partFilename(part) ??
				`attachment-${out.attachments.length + 1}${EXTENSION_FOR_TYPE[part.contentType] ?? ".bin"}`,
			mimeType: part.contentType,
			content,
			inline: part.disposition === "inline" || contentId !== undefined,
			...(contentId ? { contentId } : {}),
		});
		return;
	}
	if (inAlternative) return;
	if (part.contentType === "text/plain") out.plain.push(partText(part));
	else if (part.contentType === "text/html") out.html.push(partText(part));
}

function isAttachment(part: MimePart): boolean {
	if (part.children.length > 0) return false;
	if (part.disposition === "attachment") return true;
	if (part.contentType === "message/rfc822") return true;
	// A text part is body text unless explicitly attached (handled above).
	if (part.contentType === "text/plain" || part.contentType === "text/html") return false;
	return true;
}

// ─── HTML → text ──────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
	nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", shy: "",
	auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß",
	eacute: "é", egrave: "è", agrave: "à", aacute: "á", ccedil: "ç", ntilde: "ñ",
	euro: "€", copy: "©", reg: "®", trade: "™", deg: "°", sect: "§", para: "¶", middot: "·",
	ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»", bull: "•",
	bdquo: "„", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", sbquo: "‚",
	times: "×", divide: "÷", plusmn: "±", frac12: "½", frac14: "¼", frac34: "¾",
};

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
		if (body[0] === "#") {
			const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
			return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
		}
		return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? m;
	});
}

/**
 * Convert an HTML mail body to readable text: block elements become line
 * breaks, list items bullets, table cells are separated, links keep their
 * target when it differs from the text. Quoted replies (`<blockquote
 * type="cite">`, Gmail's `gmail_quote`, Outlook's reply header `divRplyFwdMsg`
 * and everything after it) are marked with a `>` prefix so
 * {@link stripQuotedReply} removes them like plain-text quotes.
 */
/**
 * Applies `re` until the string stops changing, so a removal cannot splice a
 * new match together (`<scr<script></script>ipt>` → `<script>` after one pass).
 */
function replaceToFixedPoint(value: string, re: RegExp, replacement: string): string {
	let previous: string;
	let current = value;
	do {
		previous = current;
		current = current.replace(re, replacement);
	} while (current !== previous);
	return current;
}

export function htmlToText(html: string): string {
	let s = replaceToFixedPoint(
		replaceToFixedPoint(html, /<!--[\s\S]*?-->/g, ""),
		/<(head|style|script|title|xml)\b[\s\S]*?<\/\1\s*>/gi,
		"",
	);
	// Outlook: everything from the reply header on is the quoted thread.
	s = s.replace(/<div[^>]*id=["']?(?:divRplyFwdMsg|appendonsend)["']?[\s\S]*$/i, (m) => `<blockquote type="cite">${m}</blockquote>`);
	// Quoted blocks → marker lines.
	s = s.replace(
		/<blockquote\b[^>]*(?:type=["']?cite["']?|class=["'][^"']*gmail_quote[^"']*["'])[^>]*>/gi,
		"\n\u0001QUOTE_START\u0001\n",
	);
	s = s.replace(/<div\b[^>]*class=["'][^"']*gmail_quote[^"']*["'][^>]*>/gi, "\n\u0001QUOTE_START\u0001\n");
	s = s
		.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
			const label = replaceToFixedPoint(text, /<[^>]+>/g, "").trim();
			if (href.startsWith("mailto:") || label === "" || label === href || href.startsWith("#")) return label;
			return `${label} (${href})`;
		})
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<\/(td|th)>/gi, " \t")
		.replace(/<\/(p|div|tr|h[1-6]|li|ul|ol|table|blockquote|pre|section|article|header|footer)>/gi, "\n")
		.replace(/<(p|div|tr|h[1-6]|table|pre|section|article)\b[^>]*>/gi, "\n")
		.replace(/<hr\b[^>]*>/gi, "\n");
	s = replaceToFixedPoint(s, /<[^>]+>/g, "");
	s = decodeEntities(s);
	const lines = s.split(/\r?\n/).map((l) => l.replace(/[ \t ]+/g, " ").trim());
	// Everything after a quote marker is quoted history.
	const out: string[] = [];
	let quoting = false;
	for (const line of lines) {
		if (line === "\u0001QUOTE_START\u0001") {
			quoting = true;
			continue;
		}
		out.push(quoting && line !== "" ? `> ${line}` : line);
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ─── Quoted replies ───────────────────────────────────────────────────────

/** "On Mon, 1 Jan 2025 at 10:00, Anna <a@x> wrote:" and its translations. */
const REPLY_HEADER_LINE = [
	/^On .{4,200}\bwrote:?$/i,
	/^Am .{4,200}\bschrieb .{0,200}:?$/i,
	/^Le .{4,200}\ba écrit ?:?$/i,
	/^El .{4,200}\bescribió:?$/i,
	/^Il .{4,200}\bha scritto:?$/i,
	/^Op .{4,200}\bschreef .{0,200}:?$/i,
];

/** Separator lines that introduce the quoted original. */
const ORIGINAL_MESSAGE =
	/^-{2,}\s*(?:original message|ursprüngliche nachricht|originalnachricht|message d'origine|mensaje original|messaggio originale)\s*-{2,}\s*$/i;
const FORWARDED_MESSAGE =
	/^-{2,}\s*(?:forwarded message|weitergeleitete nachricht|message transféré|mensaje reenviado|messaggio inoltrato)\s*-{2,}\s*$/i;

/** First line of an Outlook header block ("Von: … / Gesendet: … / An: …"). */
const OUTLOOK_FROM = /^\*?(?:von|from|de|da|van)\s*:\*?\s+\S/i;
const OUTLOOK_SENT = /^\*?(?:gesendet|sent|date|datum|envoyé|enviado|inviato|verzonden)\s*:\*?\s+\S/i;
const OUTLOOK_TO = /^\*?(?:an|to|à|para|a|aan|betreff|subject|objet|asunto|oggetto|onderwerp)\s*:\*?\s+\S/i;

export interface StrippedReply {
	/** The message's own text. */
	text: string;
	/** True when quoted history or a signature was removed. */
	stripped: boolean;
	/**
	 * The quoted history that was removed (reply header and everything below
	 * it, plus `>`-quoted lines that answer nothing), `""` when there was none.
	 * The caller keeps it when the quoted messages are not in the corpus.
	 */
	quoted: string;
}

/**
 * `>`-quoted lines kept directly above an inline answer, so "Ja, passt." still
 * says what it agrees to. More than this is history, not context.
 */
const INLINE_QUOTE_CONTEXT_LINES = 3;

/**
 * Remove the quoted history below a reply and the signature. Forwarded content
 * is kept: a forward's point is the forwarded message, which the corpus may not
 * hold otherwise. When removing the quote would leave nothing (a bare forward
 * or a top-quoted message), the full text is kept.
 *
 * An inline reply — own text interleaved with `>`-quoted lines — keeps the
 * last {@link INLINE_QUOTE_CONTEXT_LINES} quoted lines above each answer; a
 * quote block that no own text follows is history and removed. Everything
 * removed is returned as `quoted`.
 */
export function stripQuotedReply(text: string, options: { isForward?: boolean } = {}): StrippedReply {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	let cut = lines.length;
	for (let i = 0; i < lines.length; i++) {
		const line = (lines[i] ?? "").trim();
		if (FORWARDED_MESSAGE.test(line)) break; // keep the forwarded message
		if (ORIGINAL_MESSAGE.test(line)) {
			cut = i;
			break;
		}
		const twoLines = `${line} ${lines[i + 1]?.trim() ?? ""}`.trim();
		if (REPLY_HEADER_LINE.some((re) => re.test(line) || re.test(twoLines))) {
			cut = i;
			break;
		}
		if (!options.isForward && OUTLOOK_FROM.test(line)) {
			const window = lines.slice(i + 1, i + 6).map((l) => l.trim());
			if (window.some((l) => OUTLOOK_SENT.test(l)) && window.some((l) => OUTLOOK_TO.test(l))) {
				// An underscore rule right above belongs to the block.
				cut = i > 0 && /^_{8,}$/.test((lines[i - 1] ?? "").trim()) ? i - 1 : i;
				break;
			}
		}
	}
	let own = lines.slice(0, cut);
	const history = lines.slice(cut);
	// Standard signature delimiter "-- ".
	const sig = own.findIndex((l) => l === "-- " || l === "--");
	if (sig >= 0) own = own.slice(0, sig);
	// Remaining ">"-quoted lines: context above an inline answer is kept, a
	// quote block no own text follows (a bottom quote) is history.
	const isQuote = (l: string): boolean => /^\s*>/.test(l);
	const kept: string[] = [];
	const droppedQuotes: string[] = [];
	for (let i = 0; i < own.length; ) {
		const line = own[i] ?? "";
		if (!isQuote(line)) {
			kept.push(line);
			i++;
			continue;
		}
		let end = i;
		while (end < own.length && isQuote(own[end] ?? "")) end++;
		let next = end;
		while (next < own.length && (own[next] ?? "").trim() === "") next++;
		const block = own.slice(i, end);
		const answered = next < own.length && !isQuote(own[next] ?? "");
		if (answered) {
			const context = block.slice(-INLINE_QUOTE_CONTEXT_LINES);
			droppedQuotes.push(...block.slice(0, block.length - context.length));
			kept.push(...context);
		} else {
			droppedQuotes.push(...block);
		}
		i = end;
	}
	const result = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
	if (result === "") return { text: text.trim(), stripped: false, quoted: "" };
	const quoted = [...droppedQuotes, ...history].join("\n").replace(/\n{3,}/g, "\n\n").trim();
	return { text: result, stripped: result !== text.trim(), quoted };
}

// ─── mbox ─────────────────────────────────────────────────────────────────

/** An mbox "From " envelope line: `From <sender> <asctime date>`. */
const MBOX_SEPARATOR = /^From \S+.*$/;

/**
 * Split an mbox file into its messages. A message starts at a `From ` line
 * at the top of the file or after an empty line; the envelope line itself is
 * dropped and mboxrd-escaped body lines (`>From `, `>>From `) lose one `>`.
 * Returns the single buffer unchanged when the file is one message (a plain
 * `.eml`, or an mbox holding one message).
 */
export function splitMbox(buffer: Uint8Array): Uint8Array[] {
	let raw = toBinaryString(buffer);
	if (raw.startsWith("\xEF\xBB\xBF")) raw = raw.slice(3);
	if (!raw.startsWith("From ")) return [buffer];
	const lines = raw.split(/(?<=\n)/);
	const messages: string[][] = [];
	let current: string[] | null = null;
	let previousBlank = true;
	for (const line of lines) {
		const bare = line.replace(/\r?\n$/, "");
		if (previousBlank && MBOX_SEPARATOR.test(bare)) {
			current = [];
			messages.push(current);
			previousBlank = false;
			continue;
		}
		previousBlank = bare === "";
		if (current === null) continue;
		current.push(/^>+From /.test(bare) ? line.slice(1) : line);
	}
	const parts = messages
		.map((m) => m.join("").replace(/(?:\r?\n)+$/, "\n"))
		.filter((m) => m.trim() !== "");
	if (parts.length <= 1) return [buffer];
	return parts.map(fromBinaryString);
}

// ─── Entry point ──────────────────────────────────────────────────────────

/** An inline image below this size is decoration (logo, icon), not content. */
const INLINE_IMAGE_MIN_BYTES = 50_000;
/** An attached image below this size is a pixel or icon. */
const IMAGE_MIN_BYTES = 5_000;

/** Parse a `.eml` file. Never throws on malformed input; problems become warnings. */
export function parseEmail(buffer: Uint8Array): ParsedEmail {
	const warnings: string[] = [];
	let raw = toBinaryString(buffer);
	if (raw.startsWith("\xEF\xBB\xBF")) raw = raw.slice(3);
	// An mbox "From " envelope line before the headers.
	raw = raw.replace(/^From [^\n]*\n/, "");
	const root = parsePart(raw, 0, warnings);
	const fields = root.fields;

	const collected: Collected = { plain: [], html: [], attachments: [] };
	collect(root, collected, false);

	let text = collected.plain
		.map((t) => t.replace(/\r\n?/g, "\n").trim())
		.filter((t) => t !== "")
		.join("\n\n");
	let fromHtml = false;
	if (text === "" && collected.html.length > 0) {
		text = collected.html.map(htmlToText).filter((t) => t !== "").join("\n\n");
		fromHtml = true;
	}

	const messageIdRaw = header(fields, "message-id");
	const messageId = messageIdRaw ? (parseMessageIds(messageIdRaw)[0] ?? messageIdRaw.replace(/[<>\s]/g, "")) : null;
	if (messageId === null) warnings.push("the message has no Message-ID; threading falls back to its subject");

	const subjectRaw = header(fields, "subject");
	const subject = subjectRaw !== undefined ? decodeHeaderValue(subjectRaw).replace(/\s+/g, " ").trim() : undefined;
	const from = parseAddressList(header(fields, "from"))[0];
	const date = parseDate(header(fields, "date"));
	const root22 = threadIndexRoot(header(fields, "thread-index"));

	// Small images are signature logos, social icons and tracking pixels, not
	// content; an inline image large enough to be a screenshot is kept.
	const attachments = collected.attachments.filter((a) => {
		if (!a.mimeType.startsWith("image/")) return true;
		return a.content.length >= (a.inline ? INLINE_IMAGE_MIN_BYTES : IMAGE_MIN_BYTES);
	});

	return {
		messageId,
		inReplyTo: parseMessageIds(header(fields, "in-reply-to")),
		references: parseMessageIds(header(fields, "references")),
		...(root22 !== undefined ? { threadIndexRoot: root22 } : {}),
		...(subject !== undefined && subject !== "" ? { subject } : {}),
		...(from !== undefined ? { from } : {}),
		to: parseAddressList(header(fields, "to")),
		cc: parseAddressList(header(fields, "cc")),
		...(date !== undefined ? { date } : {}),
		text,
		fromHtml,
		attachments,
		warnings,
	};
}
