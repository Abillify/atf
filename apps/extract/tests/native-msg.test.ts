// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
import { describe, expect, it } from "vitest";
import { pageRecordSchema } from "@atf/extract-contract/v2";
import {
  buildEmailRecords,
  DEFAULT_MAX_EMBED_DEPTH,
  parseEmail,
  parseMsg,
  readCfb,
} from "../src/pipeline/native/index.js";
import { resolveFormat } from "../src/formats.js";
import {
  msgBinary,
  msgProperties,
  msgString,
  writeCfb,
  type CfbNode,
} from "./cfb-writer.js";

const PDF = Buffer.from(`%PDF-1.4\n${"y".repeat(6000)}\n%%EOF`);

/** A received reply with transport headers, two recipients and two attachments. */
function receivedMsg(): Uint8Array {
  const transport = [
    "Message-ID: <m2@example.com>",
    "In-Reply-To: <m1@example.com>",
    "References: <m0@example.com> <m1@example.com>",
    "Date: Wed, 5 Mar 2025 10:00:00 +0000",
    "From: =?utf-8?Q?J=C3=BCrgen?= <j@example.com>",
    "To: Anna <anna@example.com>",
    "Subject: AW: Maske WE-01",
  ].join("\r\n");
  const inner = [
    msgProperties(24, []),
    msgString(0x0037, "Ursprüngliche Anforderung"),
    msgString(0x1000, "Lieferant ist Pflicht."),
    msgString(0x1035, "<m1@example.com>"),
    msgString(0x0c1f, "anna@example.com"),
  ];
  return writeCfb([
    msgProperties(32, [{ id: 0x0039, time: new Date("2025-03-05T10:00:00Z") }]),
    msgString(0x0037, "AW: Maske WE-01"),
    msgString(0x007d, transport),
    msgString(0x1000, "Ja, passt.\r\n\r\nAm 04.03.2025 schrieb Anna:\r\n> Lieferant ist Pflicht."),
    {
      name: "__recip_version1.0_#00000000",
      children: [msgProperties(8, [{ id: 0x0c15, long: 1 }]), msgString(0x3001, "Anna"), msgString(0x39fe, "anna@example.com")],
    },
    {
      name: "__attach_version1.0_#00000000",
      children: [
        msgProperties(8, [{ id: 0x3705, long: 1 }]),
        msgString(0x3707, "Spezifikation.pdf"),
        msgString(0x370e, "application/pdf"),
        msgBinary(0x3701, PDF),
      ],
    },
    {
      name: "__attach_version1.0_#00000001",
      children: [
        msgProperties(8, [{ id: 0x3705, long: 5 }]),
        msgString(0x3707, "Anforderung.msg"),
        { name: "__substg1.0_3701000D", children: inner },
      ],
    },
  ]);
}

describe("CFB reader", () => {
  it("reads streams from the mini stream and from regular sectors", () => {
    const root = readCfb(writeCfb([{ name: "small", data: Buffer.from("abc") }, { name: "big", data: PDF }]));
    expect(root).not.toBeNull();
    expect(Buffer.from(root?.child("small")?.read() ?? []).toString()).toBe("abc");
    expect(Buffer.from(root?.child("BIG")?.read() ?? []).equals(PDF)).toBe(true);
  });

  it("returns null for bytes that are not a compound file", () => {
    expect(readCfb(new Uint8Array(1024))).toBeNull();
  });
});

describe("parseMsg", () => {
  it("reads headers from the transport headers, body, recipients and attachments", () => {
    const mail = parseMsg(receivedMsg());
    expect(mail.messageId).toBe("m2@example.com");
    expect(mail.inReplyTo).toEqual(["m1@example.com"]);
    expect(mail.references).toEqual(["m0@example.com", "m1@example.com"]);
    expect(mail.subject).toBe("AW: Maske WE-01");
    expect(mail.from).toEqual({ name: "Jürgen", address: "j@example.com" });
    expect(mail.to).toEqual([{ name: "Anna", address: "anna@example.com" }]);
    expect(mail.date).toBe("2025-03-05T10:00:00.000Z");
    expect(mail.text).toContain("Ja, passt.");
    expect(mail.attachments.map((a) => a.filename)).toEqual(["Spezifikation.pdf", "Anforderung.eml"]);
    expect(Buffer.from(mail.attachments[0]?.content ?? []).equals(PDF)).toBe(true);
    // The embedded message became a child e-mail of its own.
    const inner = parseEmail(mail.attachments[1]?.content ?? new Uint8Array());
    expect(inner.messageId).toBe("m1@example.com");
    expect(inner.subject).toBe("Ursprüngliche Anforderung");
    expect(inner.text).toBe("Lieferant ist Pflicht.");
  });

  it("falls back to MAPI properties without transport headers", () => {
    const sent = writeCfb([
      msgProperties(32, [{ id: 0x0039, time: new Date("2025-01-02T03:04:05Z") }]),
      msgString(0x0037, "Entwurf"),
      msgString(0x1000, "Text"),
      msgString(0x1035, "<sent-1@example.com>"),
      msgString(0x1042, "<parent@example.com>"),
      msgString(0x0c1a, "Anna"),
      msgString(0x5d01, "Anna@Example.com"),
      {
        name: "__recip_version1.0_#00000000",
        children: [msgProperties(8, [{ id: 0x0c15, long: 2 }]), msgString(0x39fe, "cc@example.com")],
      },
    ]);
    const mail = parseMsg(sent);
    expect(mail.messageId).toBe("sent-1@example.com");
    expect(mail.inReplyTo).toEqual(["parent@example.com"]);
    expect(mail.from).toEqual({ name: "Anna", address: "anna@example.com" });
    expect(mail.cc).toEqual([{ address: "cc@example.com" }]);
    expect(mail.date).toBe("2025-01-02T03:04:05.000Z");
  });

  it("builds a contract-valid e-mail page with the quoted history split off", () => {
    const buffer = receivedMsg();
    const built = buildEmailRecords(buffer, parseMsg(buffer));
    pageRecordSchema.parse(built.records[0]);
    expect(built.email.messageId).toBe("m2@example.com");
    expect(built.text).toContain("Ja, passt.");
    expect(built.text).not.toContain("schrieb Anna");
    expect(built.quotedHistory).toContain("Lieferant ist Pflicht.");
  });

  it("is recognised as Outlook with or without a file name", () => {
    const buffer = receivedMsg();
    const named = resolveFormat({ buffer, filename: "mail.msg" });
    expect(named.ok && named.format.mimeType).toBe("application/vnd.ms-outlook");
    const bare = resolveFormat({ buffer });
    expect(bare.ok && bare.format.kind).toBe("email");
  });

  it("bounds embedded-message nesting at MAX_EMBED_DEPTH (requirement 5.4)", () => {
    // The default is the configured MAX_EMBED_DEPTH of 2, not the old
    // hard-coded 4.
    expect(DEFAULT_MAX_EMBED_DEPTH).toBe(2);

    // level0 embeds level1 embeds level2 …, each as an ATTACH_EMBEDDED_MSG
    // storage. An embedded message is handed on as an EML child, so the
    // observable boundary is whether a level is parsed at all: at the depth
    // limit it is skipped with a warning instead of recursed into.
    const message = (name: string, embedded?: CfbNode[]): CfbNode[] => [
      msgProperties(24, []),
      msgString(0x0037, name),
      msgString(0x1000, `Body ${name}`),
      msgString(0x1035, `<${name}@example.com>`),
      ...(embedded !== undefined
        ? [
            {
              name: "__attach_version1.0_#00000000",
              children: [
                msgProperties(8, [{ id: 0x3705, long: 5 }]),
                msgString(0x3707, `${name}-inner.msg`),
                { name: "__substg1.0_3701000D", children: embedded },
              ],
            },
          ]
        : []),
    ];
    const nested = writeCfb([
      msgProperties(32, []),
      msgString(0x0037, "level0"),
      msgString(0x1000, "Body level0"),
      msgString(0x1035, "<level0@example.com>"),
      {
        name: "__attach_version1.0_#00000000",
        children: [
          msgProperties(8, [{ id: 0x3705, long: 5 }]),
          msgString(0x3707, "level1-inner.msg"),
          {
            name: "__substg1.0_3701000D",
            children: message("level1", message("level2", message("level3"))),
          },
        ],
      },
    ]);

    // The first embedded message is parsed into an EML child.
    const mail = parseMsg(nested);
    expect(mail.attachments.map((a) => a.filename)).toEqual([
      "level1-inner.eml",
    ]);
    const level1 = parseEmail(mail.attachments[0]?.content ?? new Uint8Array());
    expect(level1.subject).toBe("level1");
    expect(level1.text).toBe("Body level1");

    // Depth 0: embedding is off entirely, and the skip is reported.
    const flat = parseMsg(nested, 0);
    expect(flat.attachments).toEqual([]);
    expect(
      flat.warnings.some(
        (w) => w.includes("level1-inner.msg") && w.includes("skipped"),
      ),
    ).toBe(true);

    // A pathological nesting far below the limit terminates without throwing;
    // the recursion stops at the depth bound rather than following every level.
    let deep: CfbNode[] = message("leaf");
    for (let level = 0; level < 40; level += 1)
      deep = message(`deep${level}`, deep);
    const deepMail = parseMsg(writeCfb([msgProperties(32, []), ...deep]));
    expect(deepMail.attachments).toHaveLength(1);
    // The outermost wrapper is the last one wound; its child is followed once
    // and the recursion stops at the bound, 38 levels deeper.
    expect(deepMail.attachments[0]?.filename).toBe("deep39-inner.eml");
  });
});
