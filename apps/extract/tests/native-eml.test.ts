// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import { pageRecordSchema } from "@atf/extract-contract/v2";
import {
  buildEmailRecords,
  htmlToText,
  parseEmail,
  QUOTED_HISTORY_HEADING,
  buildMboxRecords,
  splitMbox,
  stripQuotedReply,
  withQuotedHistory,
} from "../src/pipeline/native/index.js";
import {
  decodeHeaderValue,
  parseAddressList,
  parseMessageIds,
  parseParameterizedHeader,
  threadIndexRoot,
} from "../src/pipeline/native/eml.js";
import { resolveFormat } from "../src/formats.js";

const crlf = (s: string): Uint8Array => new TextEncoder().encode(s.replace(/\r?\n/g, "\r\n"));

const PDF_BYTES = Buffer.from(`%PDF-1.4\n${"x".repeat(6000)}\n%%EOF`);

/** A Gmail-style reply: multipart/mixed(alternative(plain, html), pdf). */
const GMAIL_REPLY = `Received: from mx.example.com
From: =?UTF-8?Q?J=C3=BCrgen_M=C3=BCller?= <Juergen@Example.com>
To: "Team, Vertrieb" <vertrieb@example.com>, anna@example.com (Anna)
Cc: Chefs: boss@example.com, ceo@example.com;
Subject: =?utf-8?B?QVc6IEFuZ2Vib3Qgw5xiZXJzaWNodA==?=
 =?utf-8?Q?_Q3?=
Date: Tue, 4 Mar 2025 10:15:00 +0100 (CET)
Message-ID: <CAB123@mail.gmail.com>
In-Reply-To: <orig-1@example.com>
References: <root-0@example.com>
 <orig-1@example.com>
Thread-Index: AQHbjZ0xYWJjZGVmZ2hpamtsbW5vcHFyc3Q=
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="outer"

--outer
Content-Type: multipart/alternative; boundary="alt"

--alt
Content-Type: text/plain; charset="UTF-8"
Content-Transfer-Encoding: quoted-printable

Hallo Anna,

anbei das =C3=BCberarbeitete Angebot mit den neuen Preisen f=C3=BCr Q3. Die=
 Lieferzeit bleibt bei drei Wochen.

Viele Gr=C3=BC=C3=9Fe
J=C3=BCrgen

--=20
J=C3=BCrgen M=C3=BCller | Vertrieb

Am Mo., 3. M=C3=A4rz 2025 um 09:00 Uhr schrieb Anna <anna@example.com>:
> Kannst du das Angebot anpassen?

--alt
Content-Type: text/html; charset="UTF-8"

<div>Hallo Anna, HTML-Version</div>
--alt--

--outer
Content-Type: application/pdf; name="Angebot Q3.pdf"
Content-Disposition: attachment; filename*=UTF-8''Angebot%20%C3%9Cbersicht.pdf
Content-Transfer-Encoding: base64

${PDF_BYTES.toString("base64").replace(/(.{76})/g, "$1\n")}
--outer--
`;

/** An Outlook HTML-only reply with a Windows-1252 body and a reply header block. */
const OUTLOOK_REPLY = `From: Anna Beispiel <anna@example.com>
To: Juergen@example.com
Subject: RE: Angebot
Date: Wed, 5 Mar 2025 08:00:00 +0000
Message-ID: <AM0PR01@outlook.com>
Content-Type: text/html; charset="windows-1252"
Content-Transfer-Encoding: quoted-printable

<html><head><style>p{}</style></head><body>
<p>Danke, das passt so. Bitte die Auftragsbest=E4tigung an <a href=3D"mailto:x@y.de">x@y.de</a>.</p>
<ul><li>Position 1</li><li>Position 2</li></ul>
<div id=3D"divRplyFwdMsg"><b>Von:</b> J=FCrgen<br><b>Gesendet:</b> Dienstag<br><b>An:</b> Anna</div>
<p>Alter Text, der nicht erneut indexiert werden soll.</p>
</body></html>
`;

describe("header decoding", () => {
  it("decodes RFC 2047 words, joining adjacent ones", () => {
    expect(decodeHeaderValue("=?utf-8?B?QVc6IEFuZ2Vib3Qgw5xiZXJzaWNodA==?= =?utf-8?Q?_Q3?=")).toBe(
      "AW: Angebot Übersicht Q3",
    );
    expect(decodeHeaderValue("=?iso-8859-1?Q?Gr=FC=DFe?= aus Berlin")).toBe("Grüße aus Berlin");
  });

  it("parses RFC 2231 parameters and continuations", () => {
    expect(parseParameterizedHeader("attachment; filename*=UTF-8''%C3%9Cbersicht.pdf").params.get("filename")).toBe(
      "Übersicht.pdf",
    );
    const cont = parseParameterizedHeader(
      "attachment; filename*0*=UTF-8''Sehr%20langer%20; filename*1=Name.pdf",
    );
    expect(cont.params.get("filename")).toBe("Sehr langer Name.pdf");
    expect(parseParameterizedHeader('multipart/mixed; boundary="a;b"').params.get("boundary")).toBe("a;b");
  });

  it("parses address lists with quotes, comments and groups", () => {
    expect(parseAddressList('"Team, Vertrieb" <Vertrieb@Example.com>, anna@example.com (Anna)')).toEqual([
      { name: "Team, Vertrieb", address: "vertrieb@example.com" },
      { name: "Anna", address: "anna@example.com" },
    ]);
    expect(parseAddressList("Chefs: boss@example.com, ceo@example.com;").map((m) => m.address)).toEqual([
      "boss@example.com",
      "ceo@example.com",
    ]);
  });

  it("parses message ids and the Outlook conversation root", () => {
    expect(parseMessageIds("<a@x> <b@x>\n <a@x>")).toEqual(["a@x", "b@x"]);
    const root = threadIndexRoot("AQHbjZ0xYWJjZGVmZ2hpamtsbW5vcHFyc3Q=");
    expect(root).toBeDefined();
    // Another message of the same conversation: same 22-byte prefix, longer.
    const child = Buffer.concat([Buffer.from("AQHbjZ0xYWJjZGVmZ2hpamtsbW5vcHFyc3Q=", "base64"), Buffer.from([1, 2, 3, 4, 5])]);
    expect(threadIndexRoot(child.toString("base64"))).toBe(root);
  });
});

describe("parseEmail", () => {
  it("reads a Gmail reply: headers, plain body, attachment", () => {
    const mail = parseEmail(crlf(GMAIL_REPLY));
    expect(mail.messageId).toBe("CAB123@mail.gmail.com");
    expect(mail.inReplyTo).toEqual(["orig-1@example.com"]);
    expect(mail.references).toEqual(["root-0@example.com", "orig-1@example.com"]);
    expect(mail.subject).toBe("AW: Angebot Übersicht Q3");
    expect(mail.from).toEqual({ name: "Jürgen Müller", address: "juergen@example.com" });
    expect(mail.cc.map((m) => m.address)).toEqual(["boss@example.com", "ceo@example.com"]);
    expect(mail.date).toBe("2025-03-04T09:15:00.000Z");
    expect(mail.fromHtml).toBe(false);
    expect(mail.text).toContain("überarbeitete Angebot mit den neuen Preisen für Q3. Die Lieferzeit");
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0]).toMatchObject({ filename: "Angebot Übersicht.pdf", mimeType: "application/pdf" });
    expect(Buffer.from(mail.attachments[0]?.content ?? []).equals(PDF_BYTES)).toBe(true);
  });

  it("reads an HTML-only Outlook message in windows-1252", () => {
    const mail = parseEmail(crlf(OUTLOOK_REPLY));
    expect(mail.fromHtml).toBe(true);
    expect(mail.text).toContain("Auftragsbestätigung an x@y.de");
    expect(mail.text).toContain("- Position 1");
    expect(mail.text).not.toContain("p{}");
    expect(mail.text).toMatch(/^> Alter Text/m);
  });

  it("never throws on garbage and reports a missing Message-ID", () => {
    const mail = parseEmail(new TextEncoder().encode("Subject: x\n\nbody"));
    expect(mail.messageId).toBeNull();
    expect(mail.text).toBe("body");
    expect(mail.warnings.join()).toContain("Message-ID");
  });
});

describe("stripQuotedReply", () => {
  it("removes the German reply header, quotes and the signature", () => {
    const { text, stripped } = stripQuotedReply(parseEmail(crlf(GMAIL_REPLY)).text);
    expect(stripped).toBe(true);
    expect(text).toContain("Viele Grüße");
    expect(text).not.toContain("schrieb");
    expect(text).not.toContain("Vertrieb");
    expect(text).not.toContain("Kannst du");
  });

  it("removes an Outlook header block but keeps a forward", () => {
    const reply = "Passt.\n\n________________\nVon: Anna\nGesendet: Montag\nAn: Jürgen\nBetreff: Angebot\n\nAlt";
    expect(stripQuotedReply(reply).text).toBe("Passt.");
    expect(stripQuotedReply(reply, { isForward: true }).text).toContain("Alt");
    const fwd = "FYI\n\n---------- Forwarded message ---------\nFrom: x\nDate: y\n\nInhalt";
    expect(stripQuotedReply(fwd).text).toContain("Inhalt");
  });

  it("keeps the full text when nothing of its own would remain", () => {
    expect(stripQuotedReply("> nur Zitat").text).toBe("> nur Zitat");
  });

  it("returns the removed history as `quoted`", () => {
    const { quoted } = stripQuotedReply(parseEmail(crlf(GMAIL_REPLY)).text);
    expect(quoted).toContain("schrieb");
    expect(quoted).toContain("Kannst du");
  });

  it("keeps the quoted lines directly above an inline answer", () => {
    const inline = [
      "Hallo Anna,",
      "",
      "> Punkt 1: Lieferant ist Pflichtfeld",
      "> Punkt 2: Anforderung WE-07 Menge > 0",
      "Ja, passt.",
      "",
      "> Einleitung",
      "> Zeile 2",
      "> Zeile 3",
      "> Punkt 3: Datum optional",
      "Nein, Pflicht.",
      "",
      "> Alter Verlauf ohne Antwort",
    ].join("\n");
    const { text, quoted } = stripQuotedReply(inline);
    expect(text).toContain("> Punkt 2: Anforderung WE-07 Menge > 0\nJa, passt.");
    expect(text).toContain("> Punkt 3: Datum optional\nNein, Pflicht.");
    // Only the last three quote lines above an answer stay; the rest and the
    // unanswered bottom quote go to `quoted`.
    expect(text).not.toContain("Einleitung");
    expect(text).not.toContain("Alter Verlauf");
    expect(quoted).toContain("> Einleitung");
    expect(quoted).toContain("> Alter Verlauf ohne Antwort");
  });
});

describe("mbox", () => {
  const MBOX = [
    "From anna@example.com Tue Mar  4 10:00:00 2025",
    "From: Anna <anna@example.com>",
    "Subject: Angebot",
    "Date: Tue, 4 Mar 2025 10:00:00 +0000",
    "Message-ID: <m1@example.com>",
    "",
    "Anbei das Angebot.",
    ">From the archive: escaped line",
    "",
    "From j@example.com Wed Mar  5 10:00:00 2025",
    "From: Jürgen <j@example.com>",
    "Subject: AW: Angebot",
    "Date: Wed, 5 Mar 2025 10:00:00 +0000",
    "Message-ID: <m2@example.com>",
    "In-Reply-To: <m1@example.com>",
    "",
    "Passt.",
    "",
  ].join("\n");

  it("splits an mbox into its messages and unescapes >From lines", () => {
    const parts = splitMbox(new TextEncoder().encode(MBOX));
    expect(parts).toHaveLength(2);
    const [one, two] = parts;
    if (one === undefined || two === undefined) throw new Error("expected two messages");
    const first = parseEmail(one);
    expect(first.messageId).toBe("m1@example.com");
    expect(first.text).toContain("From the archive: escaped line");
    expect(parseEmail(two).inReplyTo).toEqual(["m1@example.com"]);
  });

  it("leaves a single message untouched", () => {
    const one = new TextEncoder().encode("From a@b Tue Mar  4 10:00:00 2025\nSubject: x\nFrom: a@b.c\n\nText\n");
    expect(splitMbox(one)).toEqual([one]);
    const eml = crlf(GMAIL_REPLY);
    expect(splitMbox(eml)).toEqual([eml]);
  });

  it("builds an index page and one .eml child per message", () => {
    const built = buildMboxRecords(splitMbox(new TextEncoder().encode(MBOX)));
    const page = pageRecordSchema.parse(built.records[0]);
    expect(page.blocks[0]).toMatchObject({ type: "heading", text: "Postfach-Export (2 Nachrichten)" });
    expect(built.attachments.map((a) => a.filename)).toEqual(["1 Angebot.eml", "2 AW_ Angebot.eml"]);
    expect(built.attachments.every((a) => a.mimeType === "message/rfc822")).toBe(true);
    expect(built.messageIds).toEqual(["m1@example.com", "m2@example.com"]);
    const resolved = resolveFormat({ buffer: new TextEncoder().encode(MBOX), filename: "export.mbox" });
    expect(resolved.ok && resolved.format.kind).toBe("email");
  });
});

describe("withQuotedHistory", () => {
  it("files the quoted history under its own section before the attachment list", () => {
    const built = buildEmailRecords(crlf(GMAIL_REPLY));
    expect(built.quotedHistory).toContain("Kannst du");
    const record = built.records[0];
    if (record === undefined) throw new Error("no record");
    const page = pageRecordSchema.parse(withQuotedHistory(record, built.quotedHistory ?? ""));
    const headings = page.blocks.filter((b) => b.type === "heading").map((b) => ("text" in b ? b.text : ""));
    expect(headings).toEqual(["AW: Angebot Übersicht Q3", QUOTED_HISTORY_HEADING, "Attachments"]);
    const quotedText = page.blocks
      .filter((b) => b.id.startsWith("p1-q") && b.type === "paragraph")
      .map((b) => ("text" in b ? b.text : ""))
      .join("\n");
    expect(quotedText).toContain("Kannst du");
    expect(quotedText).not.toMatch(/^>/m);
    expect(new Set(page.blocks.map((b) => b.id)).size).toBe(page.blocks.length);
  });
});

describe("htmlToText", () => {
  it("keeps link targets and decodes entities", () => {
    expect(htmlToText('<p>Siehe <a href="https://x.de/a">Doku</a> &amp; Stra&szlig;e&nbsp;1</p>')).toBe(
      "Siehe Doku (https://x.de/a) & Straße 1",
    );
  });
});

describe("buildEmailRecords", () => {
  it("builds one contract-valid page with header, own text and attachment list", () => {
    const built = buildEmailRecords(crlf(GMAIL_REPLY));
    expect(built.records).toHaveLength(1);
    const page = pageRecordSchema.parse(built.records[0]);
    const texts = page.blocks.map((b) => ("text" in b ? b.text : "items" in b ? b.items.join(",") : ""));
    expect(texts[0]).toBe("AW: Angebot Übersicht Q3");
    expect(texts[1]).toContain("From: Jürgen Müller <juergen@example.com>");
    expect(texts[1]).toContain("Date: 2025-03-04 09:15 UTC");
    expect(texts.join("\n")).not.toContain("Kannst du");
    expect(texts.at(-1)).toBe("Angebot Übersicht.pdf");
    expect(built.email).toMatchObject({
      messageId: "CAB123@mail.gmail.com",
      references: ["root-0@example.com", "orig-1@example.com"],
      attachments: ["Angebot Übersicht.pdf"],
    });
    expect(built.title).toBe("AW: Angebot Übersicht Q3");
  });

  it("synthesises a stable Message-ID for a message without one", () => {
    const a = buildEmailRecords(new TextEncoder().encode("Subject: s\nFrom: a@b.c\n\nText"));
    const b = buildEmailRecords(new TextEncoder().encode("Subject: s\nFrom: a@b.c\n\nText"));
    expect(a.email.messageId).toMatch(/^sha256-[0-9a-f]{64}@atf-extract\.invalid$/);
    expect(a.email.messageId).toBe(b.email.messageId);
  });
});

describe("format detection", () => {
  it("recognises an .eml by its header block", () => {
    const resolved = resolveFormat({ buffer: crlf(GMAIL_REPLY), filename: "x.eml" });
    expect(resolved.ok && resolved.format.kind).toBe("email");
    const noName = resolveFormat({ buffer: crlf(OUTLOOK_REPLY) });
    expect(noName.ok && noName.format.mimeType).toBe("message/rfc822");
  });

  it("does not take a plain text file for an e-mail", () => {
    const resolved = resolveFormat({ buffer: new TextEncoder().encode("Hello: world\nthis is prose\n"), filename: "x.eml" });
    expect(resolved.ok).toBe(false);
  });
});
