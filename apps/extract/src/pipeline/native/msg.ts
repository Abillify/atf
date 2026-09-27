// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pipeline/native/msg.ts
 *
 * Native parser for Outlook `.msg` files ([MS-OXMSG]): a CFB container whose
 * MAPI properties hold the headers, the body and the attachments. The result
 * is the same {@link ParsedEmail} the `.eml` parser produces, so an Outlook
 * export is threaded, stripped of its quoted history and split into its
 * attachments exactly like an RFC 5322 message.
 *
 * Header sources, in order of trust:
 *  1. `PR_TRANSPORT_MESSAGE_HEADERS` — the original RFC 5322 header block of a
 *     received message (Message-ID, In-Reply-To, References, Date, addresses);
 *  2. the MAPI properties — for a draft or sent item without transport headers
 *     (`PR_INTERNET_MESSAGE_ID`, `PR_IN_REPLY_TO_ID`, `PR_INTERNET_REFERENCES`,
 *     `PR_CONVERSATION_INDEX`, sender, recipients, submit time).
 *
 * The body is `PR_BODY`, else `PR_HTML` converted to text. An attachment's
 * bytes are `PR_ATTACH_DATA_BIN`; an embedded message (attach method 5) is
 * turned into an `.eml` of its own so it is ingested as an e-mail.
 */

import { readCfb, type CfbEntry } from "./cfb.js";
import {
	decodeCharset,
	htmlToText,
	parseEmail,
	parseMessageIds,
	threadIndexRoot as threadIndexRootOf,
	type EmailAttachment,
	type EmailMailbox,
	type ParsedEmail,
} from "./eml.js";

// MAPI property ids.
const PR_SUBJECT = 0x0037;
const PR_CLIENT_SUBMIT_TIME = 0x0039;
const PR_CONVERSATION_INDEX = 0x0071;
const PR_TRANSPORT_MESSAGE_HEADERS = 0x007d;
const PR_SENDER_NAME = 0x0c1a;
const PR_SENDER_EMAIL_ADDRESS = 0x0c1f;
const PR_RECIPIENT_TYPE = 0x0c15;
const PR_MESSAGE_DELIVERY_TIME = 0x0e06;
const PR_BODY = 0x1000;
const PR_HTML = 0x1013;
const PR_INTERNET_MESSAGE_ID = 0x1035;
const PR_INTERNET_REFERENCES = 0x1039;
const PR_IN_REPLY_TO_ID = 0x1042;
const PR_DISPLAY_NAME = 0x3001;
const PR_EMAIL_ADDRESS = 0x3003;
const PR_ATTACH_DATA = 0x3701;
const PR_ATTACH_FILENAME = 0x3704;
const PR_ATTACH_METHOD = 0x3705;
const PR_ATTACH_LONG_FILENAME = 0x3707;
const PR_ATTACH_MIME_TAG = 0x370e;
const PR_ATTACH_CONTENT_ID = 0x3712;
const PR_SMTP_ADDRESS = 0x39fe;
const PR_INTERNET_CPID = 0x3fde;
const PR_MESSAGE_CODEPAGE = 0x3ffd;
const PR_SENDER_SMTP_ADDRESS = 0x5d01;

// Property types.
const PT_LONG = 0x0003;
const PT_SYSTIME = 0x0040;
const PT_STRING8 = 0x001e;
const PT_UNICODE = 0x001f;
const PT_BINARY = 0x0102;
const PT_OBJECT = 0x000d;

const ATTACH_EMBEDDED_MSG = 5;
const MAX_EMBED_DEPTH = 4;

/** Windows code page → WHATWG encoding label. */
function codepageLabel(cp: number | undefined): string | undefined {
	if (cp === undefined) return undefined;
	if (cp === 65001) return "utf-8";
	if (cp === 20127) return "us-ascii";
	if (cp === 28591) return "iso-8859-1";
	if (cp === 28605) return "iso-8859-15";
	if (cp >= 1250 && cp <= 1258) return `windows-${cp}`;
	if (cp === 932) return "shift_jis";
	if (cp === 936) return "gbk";
	return undefined;
}

/** The MAPI properties of one storage (message, recipient or attachment). */
class PropertyBag {
	private readonly fixed = new Map<number, { type: number; value: Buffer }>();
	constructor(
		private readonly storage: CfbEntry,
		headerSize: number,
		private readonly charset: () => string | undefined,
	) {
		const stream = storage.child("__properties_version1.0");
		if (stream === undefined) return;
		const bytes = Buffer.from(stream.read());
		for (let o = headerSize; o + 16 <= bytes.length; o += 16) {
			const tag = bytes.readUInt32LE(o);
			this.fixed.set(tag >>> 16, { type: tag & 0xffff, value: bytes.subarray(o + 8, o + 16) });
		}
	}

	private stream(id: number, type: number): CfbEntry | undefined {
		const tag = `${id.toString(16).padStart(4, "0")}${type.toString(16).padStart(4, "0")}`.toUpperCase();
		return this.storage.child(`__substg1.0_${tag}`);
	}

	string(id: number): string | undefined {
		const unicode = this.stream(id, PT_UNICODE);
		if (unicode !== undefined) {
			const text = Buffer.from(unicode.read()).toString("utf16le").replace(/\0+$/, "");
			return text === "" ? undefined : text;
		}
		const ansi = this.stream(id, PT_STRING8);
		if (ansi !== undefined) {
			const text = decodeCharset(ansi.read(), this.charset() ?? "windows-1252").replace(/\0+$/, "");
			return text === "" ? undefined : text;
		}
		return undefined;
	}

	binary(id: number): Uint8Array | undefined {
		return this.stream(id, PT_BINARY)?.read();
	}

	object(id: number): CfbEntry | undefined {
		return this.stream(id, PT_OBJECT);
	}

	long(id: number): number | undefined {
		const p = this.fixed.get(id);
		return p !== undefined && p.type === PT_LONG ? p.value.readInt32LE(0) : undefined;
	}

	time(id: number): string | undefined {
		const p = this.fixed.get(id);
		if (p === undefined || p.type !== PT_SYSTIME) return undefined;
		const ticks = p.value.readBigUInt64LE(0);
		if (ticks === 0n) return undefined;
		const ms = Number(ticks / 10_000n) - 11_644_473_600_000;
		return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
	}
}

/** Is this buffer an Outlook `.msg`? (A CFB with a root properties stream and `__substg1.0_` streams.) */
export function looksLikeMsg(buffer: Uint8Array): boolean {
	const root = readCfb(buffer);
	return root !== null && isMessageStorage(root);
}

function isMessageStorage(storage: CfbEntry): boolean {
	return (
		storage.child("__properties_version1.0") !== undefined &&
		storage.children.some((c) => c.name.toLowerCase().startsWith("__substg1.0_"))
	);
}

/** Parse an Outlook `.msg`. Never throws; a malformed file yields warnings and an empty message. */
export function parseMsg(buffer: Uint8Array): ParsedEmail {
	const root = readCfb(buffer);
	if (root === null || !isMessageStorage(root)) {
		return emptyMessage(["not a readable Outlook .msg (CFB) file"]);
	}
	return parseMessage(root, 32, 0);
}

function emptyMessage(warnings: string[]): ParsedEmail {
	return { messageId: null, inReplyTo: [], references: [], to: [], cc: [], text: "", fromHtml: false, attachments: [], warnings };
}

function parseMessage(storage: CfbEntry, headerSize: number, depth: number): ParsedEmail {
	const warnings: string[] = [];
	let charset: string | undefined;
	const props = new PropertyBag(storage, headerSize, () => charset);
	charset = codepageLabel(props.long(PR_INTERNET_CPID) ?? props.long(PR_MESSAGE_CODEPAGE));

	// 1. The original transport headers, when the message was received.
	const transport = props.string(PR_TRANSPORT_MESSAGE_HEADERS);
	const headers = transport !== undefined ? parseEmail(new TextEncoder().encode(`${transport.trimEnd()}\r\n\r\n`)) : undefined;

	// 2. MAPI properties as the fallback.
	const recipients = readRecipients(storage, () => charset);
	const senderAddress = props.string(PR_SENDER_SMTP_ADDRESS) ?? smtpOnly(props.string(PR_SENDER_EMAIL_ADDRESS));
	const senderName = props.string(PR_SENDER_NAME);
	const from: EmailMailbox | undefined =
		headers?.from ??
		(senderAddress !== undefined
			? { address: senderAddress.toLowerCase(), ...(senderName !== undefined && senderName !== senderAddress ? { name: senderName } : {}) }
			: undefined);

	const messageIdProp = props.string(PR_INTERNET_MESSAGE_ID);
	const messageId = headers?.messageId ?? (messageIdProp !== undefined ? (parseMessageIds(messageIdProp)[0] ?? messageIdProp.replace(/[<>\s]/g, "")) : null);
	if (messageId === null) warnings.push("the message has no Message-ID; threading falls back to its subject");

	const conversation = props.binary(PR_CONVERSATION_INDEX);
	const rootFromIndex =
		conversation !== undefined && conversation.length >= 22 ? threadIndexRootOf(Buffer.from(conversation).toString("base64")) : undefined;

	const subject = props.string(PR_SUBJECT) ?? headers?.subject;
	const date = headers?.date ?? props.time(PR_CLIENT_SUBMIT_TIME) ?? props.time(PR_MESSAGE_DELIVERY_TIME);

	// Body: plain text, else HTML converted.
	let text = (props.string(PR_BODY) ?? "").replace(/\r\n?/g, "\n").trim();
	let fromHtml = false;
	if (text === "") {
		const html = props.binary(PR_HTML);
		const htmlText = html !== undefined ? decodeCharset(html, charset) : props.string(PR_HTML);
		if (htmlText !== undefined && htmlText.trim() !== "") {
			text = htmlToText(htmlText);
			fromHtml = true;
		}
	}

	const attachments = readAttachments(storage, () => charset, depth, warnings);
	const threadRoot = headers?.threadIndexRoot ?? rootFromIndex;

	return {
		messageId,
		inReplyTo: headers?.inReplyTo.length ? headers.inReplyTo : parseMessageIds(props.string(PR_IN_REPLY_TO_ID)),
		references: headers?.references.length ? headers.references : parseMessageIds(props.string(PR_INTERNET_REFERENCES)),
		...(threadRoot !== undefined ? { threadIndexRoot: threadRoot } : {}),
		...(subject !== undefined && subject.trim() !== "" ? { subject: subject.replace(/\s+/g, " ").trim() } : {}),
		...(from !== undefined ? { from } : {}),
		to: headers?.to.length ? headers.to : recipients.to,
		cc: headers?.cc.length ? headers.cc : recipients.cc,
		...(date !== undefined ? { date } : {}),
		text,
		fromHtml,
		attachments,
		warnings: [...(headers?.warnings.filter((w) => !w.includes("Message-ID")) ?? []), ...warnings],
	};
}

/** An Exchange `/O=…/CN=…` address is not an SMTP address. */
function smtpOnly(address: string | undefined): string | undefined {
	return address?.includes("@") && !address.startsWith("/") ? address : undefined;
}

function readRecipients(storage: CfbEntry, charset: () => string | undefined): { to: EmailMailbox[]; cc: EmailMailbox[] } {
	const to: EmailMailbox[] = [];
	const cc: EmailMailbox[] = [];
	for (const child of storage.children) {
		if (child.type !== "storage" || !child.name.toLowerCase().startsWith("__recip_version1.0_")) continue;
		const props = new PropertyBag(child, 8, charset);
		const address = props.string(PR_SMTP_ADDRESS) ?? smtpOnly(props.string(PR_EMAIL_ADDRESS));
		if (address === undefined) continue;
		const name = props.string(PR_DISPLAY_NAME);
		const mailbox: EmailMailbox = { address: address.toLowerCase(), ...(name !== undefined && name !== address ? { name } : {}) };
		const type = props.long(PR_RECIPIENT_TYPE) ?? 1;
		if (type === 2) cc.push(mailbox);
		else if (type === 1) to.push(mailbox);
		// 3 = Bcc: not part of what the recipients saw.
	}
	return { to, cc };
}

function readAttachments(
	storage: CfbEntry,
	charset: () => string | undefined,
	depth: number,
	warnings: string[],
): EmailAttachment[] {
	const out: EmailAttachment[] = [];
	for (const child of storage.children) {
		if (child.type !== "storage" || !child.name.toLowerCase().startsWith("__attach_version1.0_")) continue;
		const props = new PropertyBag(child, 8, charset);
		const method = props.long(PR_ATTACH_METHOD);
		const filename = props.string(PR_ATTACH_LONG_FILENAME) ?? props.string(PR_ATTACH_FILENAME);
		if (method === ATTACH_EMBEDDED_MSG) {
			const embedded = props.object(PR_ATTACH_DATA);
			if (embedded === undefined || depth >= MAX_EMBED_DEPTH) {
				warnings.push(`embedded message ${filename ?? ""} skipped`.trim());
				continue;
			}
			const inner = parseMessage(embedded, 24, depth + 1);
			const base = (filename ?? inner.subject ?? "Nachricht").replace(/\.msg$/i, "").replace(/[\\/]/g, "_");
			out.push({ filename: `${base}.eml`, mimeType: "message/rfc822", content: toEml(inner), inline: false });
			continue;
		}
		const data = props.binary(PR_ATTACH_DATA);
		if (data === undefined || data.length === 0) continue;
		const contentId = props.string(PR_ATTACH_CONTENT_ID);
		out.push({
			filename: (filename ?? `attachment-${out.length + 1}.bin`).replace(/[\\/]/g, "_"),
			mimeType: (props.string(PR_ATTACH_MIME_TAG) ?? "application/octet-stream").toLowerCase(),
			content: data,
			inline: contentId !== undefined,
			...(contentId !== undefined ? { contentId } : {}),
		});
	}
	return out;
}

/** Encode a header value as an RFC 2047 word when it is not plain ASCII. */
function encodeWord(value: string): string {
	return /^[\x20-\x7e]*$/.test(value) ? value : `=?utf-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function formatAddress(m: EmailMailbox): string {
	return m.name !== undefined ? `${encodeWord(m.name)} <${m.address}>` : `<${m.address}>`;
}

/**
 * Serialise a parsed message as a minimal RFC 5322 `.eml` (headers plus the
 * text body; its own attachments are not carried) — how an embedded Outlook
 * message is handed on as a child e-mail.
 */
export function toEml(mail: ParsedEmail): Uint8Array {
	const lines: string[] = [];
	if (mail.from) lines.push(`From: ${formatAddress(mail.from)}`);
	if (mail.to.length > 0) lines.push(`To: ${mail.to.map(formatAddress).join(", ")}`);
	if (mail.cc.length > 0) lines.push(`Cc: ${mail.cc.map(formatAddress).join(", ")}`);
	if (mail.subject) lines.push(`Subject: ${encodeWord(mail.subject)}`);
	if (mail.date) lines.push(`Date: ${new Date(mail.date).toUTCString()}`);
	if (mail.messageId) lines.push(`Message-ID: <${mail.messageId}>`);
	if (mail.inReplyTo.length > 0) lines.push(`In-Reply-To: ${mail.inReplyTo.map((i) => `<${i}>`).join(" ")}`);
	if (mail.references.length > 0) lines.push(`References: ${mail.references.map((i) => `<${i}>`).join(" ")}`);
	if (mail.threadIndexRoot) lines.push(`Thread-Index: ${mail.threadIndexRoot}`);
	lines.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "");
	const body = Buffer.from(mail.text, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
	return new TextEncoder().encode(`${lines.join("\r\n")}\r\n${body}\r\n`);
}
