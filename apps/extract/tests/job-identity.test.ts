// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * job-identity.test.ts
 *
 * The job runner's identity steps (jobs/identity.ts), against the in-memory
 * store with stub render/vision and a scripted Search identifier:
 *
 *  - a duplicate found in the source phase ends the job before preparation;
 *  - a canonical reference re-points the job before anything reference-derived
 *    exists;
 *  - the content phase sends the text fingerprint, the detected version and an
 *    e-mail's Message-ID, and a duplicate there costs no vision call;
 *  - without Search the version is still detected (text, then file time), and a
 *    scan's version is read from the transcribed first page;
 *  - a Search outage pauses the job on dependency;
 *  - an e-mail's attachments become child jobs with the e-mail as parent.
 */

import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { IdentifyRequest, IdentifyResponse } from "@atf/extract-contract/v2";
import { buildEmailRecords, buildMboxRecords } from "../src/pipeline/native/index.js";
import { createFakeJobStore, type FakeJobStore } from "./job-store-fake.js";
import { testLogger, TINY_PNG } from "./helpers.js";
import { createLeaseGuard } from "../src/jobs/lease.js";
import { createJobEventBus } from "../src/jobs/events.js";
import { createJobRunner, type SourceIdentifier } from "../src/jobs/job-runner.js";
import type { PageRenderer, PreparedSource } from "../src/jobs/page-renderer.js";
import type { VisionClient } from "../src/vision/client.js";
import type { JobRow } from "../src/persistence/types.js";
import { RevisionTransientError } from "../src/revision-client.js";
import { identityOf, childJobId } from "../src/jobs/identity.js";
import type { SourceStore } from "../src/source-store.js";

const SOURCE_SHA = "b".repeat(64);

function mustPeek(store: FakeJobStore, id: string): JobRow {
  const row = store.peek(id);
  if (row === undefined) throw new Error(`job ${id} missing`);
  return row;
}

function pdfPrepared(options: { pageCount?: number; text?: string[] | null } = {}): PreparedSource & {
  prepareCalls: number;
} {
  const pageCount = options.pageCount ?? 1;
  return {
    prepareCalls: 0,
    pageCount,
    native: null,
    docxHeadingHints: null,
    vsdxStructure: null,
    pdfPath: null,
    home: "",
    format: { mimeType: "application/pdf", extensions: [".pdf"], kind: "pdf", family: "pdf", label: "PDF" },
    ...(options.text !== undefined
      ? {
          async readText() {
            return options.text ?? null;
          },
        }
      : {}),
    async render() {
      return {
        image: { buffer: TINY_PNG, mimeType: "image/png", width: 100, height: 140 },
        rawText: "",
        usedOcr: true,
      };
    },
    async pageSizePt() {
      return { widthPt: 612, heightPt: 792 };
    },
    async renderRegion() {
      throw new Error("renderRegion is not used by the job runner");
    },
    async renderFigureCrop() {
      return { buffer: TINY_PNG, mimeType: "image/png", width: 10, height: 10 };
    },
    async close() {},
  };
}

function recordingRenderer(prepared: PreparedSource): PageRenderer & { references: string[] } {
  const references: string[] = [];
  return {
    references,
    async prepare(args) {
      references.push(args.reference ?? "");
      return prepared;
    },
  };
}

function fakeVision(firstPageMarkdown = "Seite 1"): VisionClient & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    async analyzePage(input) {
      calls.push(input.page);
      const md = input.page === 1 ? firstPageMarkdown : `Seite ${input.page}`;
      return {
        raw: `<summary>S</summary><figures></figures><markdown>${md}</markdown>`,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        requests: 1,
        truncated: false,
        maxTokens: 8192,
      };
    },
    async analyzeFigure() {
      throw new Error("no figures");
    },
    async probe() {
      return { available: true };
    },
  };
}

type Script = (request: IdentifyRequest) => IdentifyResponse | null | Error;

function scriptedIdentifier(script: Script): SourceIdentifier & { requests: IdentifyRequest[] } {
  const requests: IdentifyRequest[] = [];
  return {
    requests,
    async identify({ request }) {
      requests.push(request);
      const answer = script(request);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

async function seedJob(store: FakeJobStore, reference: string, config: Record<string, unknown> = {}) {
  const id = randomUUID();
  await store.createJob({ id, reference, source_sha256: SOURCE_SHA, config });
  const claimed = await store.claimNextJob("worker-1", 60);
  if (claimed === null) throw new Error("expected a claim");
  await store.setJobStatus(claimed.id, "preparing");
  return { ...claimed, status: "preparing" as const };
}

function ctx(store: FakeJobStore, job: JobRow) {
  const lease = createLeaseGuard(store, { jobId: job.id, holder: "worker-1", epoch: Number(job.lease_epoch) }, 60);
  return { job, lease, resume: { action: "continue-pinned", changed: false } as const, logger: testLogger };
}

function runner(
  store: FakeJobStore,
  renderer: PageRenderer,
  vision: VisionClient,
  extra: Partial<Parameters<typeof createJobRunner>[0]> = {},
) {
  return createJobRunner({
    store,
    vision,
    renderer,
    events: createJobEventBus(),
    config: {
      pageConcurrency: 2,
      visionTokenEstimate: 100,
      visionModel: "test-vlm",
      renderDpi: 200,
      figureDpi: 300,
      figurePass2Kinds: [],
      figurePass2MinArea: 0.02,
      labelCoverageMin: 60,
    },
    logger: testLogger,
    ...extra,
  });
}

const BODY =
  "Betriebshandbuch der Anlage. Es beschreibt Installation, Betrieb und Wartung ausführlich, " +
  "mit Sicherheitshinweisen und Fehlerbehebung für das Fachpersonal im Betrieb.";

describe("job identity · source phase", () => {
  it("a duplicate file ends the job before the source is even prepared", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store, "docs/copy.pdf");
    const prepared = pdfPrepared();
    const renderer = recordingRenderer(prepared);
    const vision = fakeVision();
    const identifier = scriptedIdentifier(() => ({
      decision: "duplicate",
      canonicalReference: "docs/copy.pdf",
      duplicateOf: { reference: "docs/original.pdf", sourceId: "j0", match: "sha256", filename: "original.pdf" },
    }));

    const outcome = await runner(store, renderer, vision, { identifier }).run(ctx(store, job));
    expect(outcome).toEqual({ status: "completed" });
    expect(renderer.references).toEqual([]);
    expect(vision.calls).toEqual([]);
    const row = mustPeek(store, job.id);
    expect(row.warnings.join()).toContain("Skipped: duplicate of docs/original.pdf (original.pdf), matched by sha256");
    expect(identityOf(row.config)).toMatchObject({ decision: "duplicate", registered: true });
    expect(identifier.requests.map((r) => r.phase)).toEqual(["source"]);
    expect(identifier.requests[0]).toMatchObject({ sourceId: job.id, documentKey: "docs/copy", sourceSha256: SOURCE_SHA });
  });

  it("identifies under the job's ACL", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store, "docs/privat.pdf", { acl: { allowedUsers: ["anna"], allowedGroups: ["team"] } });
    const identifier = scriptedIdentifier((r) => ({ decision: "new", canonicalReference: r.reference }));
    await runner(store, recordingRenderer(pdfPrepared({ text: [BODY] })), fakeVision(), { identifier }).run(ctx(store, job));
    for (const request of identifier.requests) {
      expect(request).toMatchObject({ allowedUsers: ["anna"], allowedGroups: ["team"] });
    }
  });

  it("re-points the job at the canonical reference before preparing", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store, "docs/handbuch.docx");
    const renderer = recordingRenderer(pdfPrepared({ text: [BODY] }));
    const identifier = scriptedIdentifier(() => ({
      decision: "new_version",
      canonicalReference: "docs/handbuch.pdf",
    }));

    const outcome = await runner(store, renderer, fakeVision(), { identifier }).run(ctx(store, job));
    expect(outcome).toEqual({ status: "completed" });
    expect(renderer.references).toEqual(["docs/handbuch.pdf"]);
    const row = mustPeek(store, job.id);
    expect(row.reference).toBe("docs/handbuch.pdf");
    expect(identityOf(row.config)).toMatchObject({
      requestedReference: "docs/handbuch.docx",
      canonicalReference: "docs/handbuch.pdf",
      decision: "new_version",
      complete: true,
    });
    // The content phase still identifies under the requested reference's key.
    expect(identifier.requests[1]).toMatchObject({ phase: "content", reference: "docs/handbuch.docx", documentKey: "docs/handbuch" });
  });
});

describe("job identity · content phase", () => {
  it("sends fingerprint and version; a duplicate costs no vision call", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store, "docs/manual.docx", { sourceModifiedAt: "2025-02-01T10:00:00Z" });
    const vision = fakeVision();
    const identifier = scriptedIdentifier((r) =>
      r.phase === "source"
        ? { decision: "new", canonicalReference: r.reference }
        : {
            decision: "duplicate",
            canonicalReference: r.reference,
            duplicateOf: { reference: "docs/manual.pdf", sourceId: "j1", match: "similar", similarity: 0.98 },
          },
    );
    const renderer = recordingRenderer(pdfPrepared({ pageCount: 2, text: [`Handbuch\nVersion 2.1\n${BODY}`, BODY] }));

    const outcome = await runner(store, renderer, vision, { identifier }).run(ctx(store, job));
    expect(outcome).toEqual({ status: "completed" });
    expect(vision.calls).toEqual([]);
    const content = identifier.requests[1];
    if (content === undefined) throw new Error("expected a content-phase request");
    expect(content.textHash).toMatch(/^[0-9a-f]{64}$/);
    expect(content.minhash).toHaveLength(64);
    expect(content.version).toEqual({ label: "2.1", source: "page_label" });
    expect(mustPeek(store, job.id).warnings.join()).toContain("matched by similar");
  });

  it("without Search: detects the version from the text, else takes the file time", async () => {
    const store = createFakeJobStore();
    const labelled = await seedJob(store, "a.pdf");
    await runner(store, recordingRenderer(pdfPrepared({ text: [`Stand: 03.04.2025\n${BODY}`] })), fakeVision()).run(
      ctx(store, labelled),
    );
    expect(identityOf(mustPeek(store, labelled.id).config)).toMatchObject({
      decision: "unidentified",
      registered: false,
      version: { date: "2025-04-03", source: "page_date" },
    });

    const store2 = createFakeJobStore();
    const plain = await seedJob(store2, "b.pdf", { sourceModifiedAt: "2024-12-24T08:00:00+01:00" });
    await runner(store2, recordingRenderer(pdfPrepared({ text: [BODY] })), fakeVision()).run(ctx(store2, plain));
    expect(identityOf(mustPeek(store2, plain.id).config)?.version).toEqual({
      date: "2024-12-24T07:00:00.000Z",
      source: "source_modified",
    });
  });

  it("an explicit version wins over everything", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store, "c.pdf", { version: "7.0" });
    await runner(store, recordingRenderer(pdfPrepared({ text: [`Version 2.1\n${BODY}`] })), fakeVision()).run(
      ctx(store, job),
    );
    expect(identityOf(mustPeek(store, job.id).config)?.version).toEqual({ label: "7.0", source: "explicit" });
  });

  it("reads a scan's version from the transcribed first page", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store, "scan.pdf");
    const vision = fakeVision("Prüfbericht\n\nRevision 3.0");
    await runner(store, recordingRenderer(pdfPrepared({ text: [""] })), vision).run(ctx(store, job));
    expect(vision.calls).toEqual([1]);
    expect(identityOf(mustPeek(store, job.id).config)?.version).toEqual({ label: "3.0", source: "page_label" });
  });

  it("a Search outage pauses the job on dependency", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store, "d.pdf");
    const identifier = scriptedIdentifier(() => new RevisionTransientError("connect ECONNREFUSED", 503));
    const outcome = await runner(store, recordingRenderer(pdfPrepared()), fakeVision(), { identifier }).run(
      ctx(store, job),
    );
    expect(outcome).toMatchObject({ status: "paused", reason: "dependency" });
    expect(identityOf(mustPeek(store, job.id).config)).toBeUndefined();
  });

  it("a rejected identify ingests without dedup", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store, "e.pdf");
    const identifier = scriptedIdentifier(() => new Error("400 bad request"));
    const outcome = await runner(store, recordingRenderer(pdfPrepared({ text: [BODY] })), fakeVision(), {
      identifier,
    }).run(ctx(store, job));
    expect(outcome).toEqual({ status: "completed" });
    expect(identityOf(mustPeek(store, job.id).config)).toMatchObject({ decision: "unidentified", registered: false });
    // Not registered: the content phase does not ask again.
    expect(identifier.requests).toHaveLength(1);
  });
});

describe("embedded objects of a rendered document", () => {
  it("queues each embedded file as a child job with the document as its parent", async () => {
    const bpmn = new TextEncoder().encode('<?xml version="1.0"?><definitions/>');
    const prepared: PreparedSource = {
      ...pdfPrepared(),
      embeddedSources: [{ filename: "Prozess.bpmn", mimeType: "application/bpmn+xml", content: bpmn, inline: false }],
    };
    const store = createFakeJobStore();
    const job = await seedJob(store, "specs/Spezifikation.docx", { collection: "docs", tags: ["kunde-a"] });
    const identifier = scriptedIdentifier((r) => ({ decision: "new", canonicalReference: r.reference }));
    const outcome = await runner(store, recordingRenderer(prepared), fakeVision(), {
      identifier,
      sourceStore: {
        async putStream() {
          return { sha256: "b".repeat(64), size: bpmn.length, existed: false };
        },
      } as unknown as SourceStore,
    }).run(ctx(store, job));
    expect(outcome).toEqual({ status: "completed" });
    expect(store.peek(childJobId(job.id, 0))).toMatchObject({
      reference: "specs/Spezifikation.docx/Prozess.bpmn",
      status: "queued",
      config: {
        parent: { reference: "specs/Spezifikation.docx", jobId: job.id },
        tags: ["kunde-a"],
        source: { filename: "Prozess.bpmn", mimeType: "application/bpmn+xml" },
      },
    });
  });
});

describe("job identity · e-mail", () => {
  const PDF = Buffer.from(`%PDF-1.4\n${"y".repeat(6000)}\n%%EOF`);
  const EML = [
    "From: Anna <anna@example.com>",
    "To: team@example.com",
    "Subject: Angebot",
    "Date: Tue, 4 Mar 2025 10:00:00 +0000",
    "Message-ID: <m1@example.com>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Anbei das Angebot.",
    "--b",
    'Content-Type: application/pdf; name="angebot.pdf"',
    'Content-Disposition: attachment; filename="angebot.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    PDF.toString("base64"),
    "--b",
    'Content-Type: application/x-unknown; name="data.bin"',
    'Content-Disposition: attachment; filename="data.bin"',
    "",
    "zzz",
    "--b--",
    "",
  ].join("\r\n");

  function emailPrepared(): PreparedSource {
    const built = buildEmailRecords(new TextEncoder().encode(EML));
    return {
      pageCount: 1,
      native: {
        records: built.records,
        nativeAssets: [],
        warnings: built.warnings,
        email: built.email,
        title: built.title,
        attachments: built.attachments,
        text: built.text,
      },
      docxHeadingHints: null,
      vsdxStructure: null,
      pdfPath: null,
      home: "",
      format: { mimeType: "message/rfc822", extensions: [".eml"], kind: "email", family: "email", label: "E-Mail (EML)" },
      async readText() {
        return [built.text];
      },
      async render() {
        throw new Error("no render for e-mail");
      },
      async pageSizePt() {
        return { widthPt: 612, heightPt: 792 };
      },
      async renderRegion() {
        throw new Error("renderRegion is not used by the job runner");
      },
      async renderFigureCrop() {
        throw new Error("no crops for e-mail");
      },
      async close() {},
    };
  }

  function memorySourceStore(): SourceStore & { stored: Buffer[] } {
    const stored: Buffer[] = [];
    return {
      stored,
      async putStream(stream: Readable) {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
        const buffer = Buffer.concat(chunks);
        stored.push(buffer);
        const { createHash } = await import("node:crypto");
        return { sha256: createHash("sha256").update(buffer).digest("hex"), size: buffer.length, existed: false };
      },
    } as unknown as SourceStore & { stored: Buffer[] };
  }

  it("records headers, identifies by Message-ID and queues attachments as child jobs", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store, "mail/angebot.eml", { collection: "docs", acl: { allowedUsers: ["u1"], allowedGroups: [] } });
    const identifier = scriptedIdentifier((r) => ({ decision: "new", canonicalReference: r.reference }));
    const sourceStore = memorySourceStore();
    const vision = fakeVision();

    const outcome = await runner(store, recordingRenderer(emailPrepared()), vision, {
      identifier,
      sourceStore,
    }).run(ctx(store, job));
    expect(outcome).toEqual({ status: "completed" });
    expect(vision.calls).toEqual([]);

    const row = mustPeek(store, job.id);
    expect(row.config.email).toMatchObject({ messageId: "m1@example.com", attachments: ["angebot.pdf", "data.bin"] });
    expect(row.config.title).toBe("Angebot");
    expect(identifier.requests[1]).toMatchObject({ phase: "content", messageId: "m1@example.com" });
    expect(identityOf(row.config)?.version).toBeUndefined();

    // The PDF became a child job; the unknown binary only a warning.
    const child = store.peek(childJobId(job.id, 0));
    expect(child).toMatchObject({ reference: "mail/angebot.eml/angebot.pdf", status: "queued" });
    expect(child?.config).toMatchObject({
      parent: { reference: "mail/angebot.eml", jobId: job.id },
      sourceModifiedAt: "2025-03-04T10:00:00.000Z",
      acl: { allowedUsers: ["u1"] },
      source: { filename: "angebot.pdf", mimeType: "application/pdf" },
    });
    expect(store.peek(childJobId(job.id, 1))).toBeUndefined();
    expect(row.warnings.join()).toContain('Attachment "data.bin" not ingested');
    expect(sourceStore.stored[0]?.equals(PDF)).toBe(true);
  });

  const REPLY = [
    "From: Jürgen <j@example.com>",
    "To: anna@example.com",
    "Subject: AW: Angebot",
    "Date: Wed, 5 Mar 2025 10:00:00 +0000",
    "Message-ID: <m2@example.com>",
    "In-Reply-To: <m1@example.com>",
    "References: <m1@example.com>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Passt so.",
    "",
    "Am 04.03.2025 um 10:00 schrieb Anna <anna@example.com>:",
    "> Anbei das Angebot mit Position WE-07.",
    "",
  ].join("\r\n");

  function replyPrepared(): PreparedSource {
    const built = buildEmailRecords(new TextEncoder().encode(REPLY));
    const base = emailPrepared();
    return {
      ...base,
      native: {
        records: built.records,
        nativeAssets: [],
        warnings: built.warnings,
        email: built.email,
        title: built.title,
        attachments: [],
        text: built.text,
        ...(built.quotedHistory !== undefined ? { quotedHistory: built.quotedHistory } : {}),
      },
      async readText() {
        return [built.text];
      },
    };
  }

  async function stagedText(store: ReturnType<typeof createFakeJobStore>, jobId: string): Promise<string> {
    const row = await store.getEmitBatch(jobId, 1);
    const record = (row?.payload as { record?: { blocks: Array<{ text?: string }> } } | null)?.record;
    return (record?.blocks ?? []).map((b) => b.text ?? "").join("\n");
  }

  it("keeps the quoted history of a reply whose parent is not in the corpus", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store, "mail/reply.eml", { collection: "docs" });
    const identifier = scriptedIdentifier((r) => ({ decision: "new", canonicalReference: r.reference }));
    const outcome = await runner(store, recordingRenderer(replyPrepared()), fakeVision(), { identifier }).run(ctx(store, job));
    expect(outcome).toEqual({ status: "completed" });
    const text = await stagedText(store, job.id);
    expect(text).toContain("Passt so.");
    expect(text).toContain("Zitierter Verlauf");
    expect(text).toContain("Anbei das Angebot mit Position WE-07.");
  });

  it("queues every message of an mbox as a child e-mail that knows its siblings", async () => {
    const mbox = buildMboxRecords([new TextEncoder().encode(EML), new TextEncoder().encode(REPLY)]);
    const base = emailPrepared();
    const prepared: PreparedSource = {
      ...base,
      native: {
        records: mbox.records,
        nativeAssets: [],
        warnings: mbox.warnings,
        attachments: mbox.attachments,
        text: mbox.text,
        childConfig: { mboxMessageIds: mbox.messageIds },
      },
      async readText() {
        return [mbox.text];
      },
    };
    const store = createFakeJobStore();
    const job = await seedJob(store, "mail/export.mbox", { collection: "docs" });
    const identifier = scriptedIdentifier((r) => ({ decision: "new", canonicalReference: r.reference }));
    const outcome = await runner(store, recordingRenderer(prepared), fakeVision(), { identifier, sourceStore: memorySourceStore() }).run(ctx(store, job));
    expect(outcome).toEqual({ status: "completed" });
    expect(store.peek(childJobId(job.id, 0))).toMatchObject({
      reference: "mail/export.mbox/1 Angebot.eml",
      config: { mboxMessageIds: ["m1@example.com", "m2@example.com"], source: { mimeType: "message/rfc822" } },
    });
    expect(store.peek(childJobId(job.id, 1))?.reference).toBe("mail/export.mbox/2 AW_ Angebot.eml");
  });

  it("counts a parent in the same mbox as known", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store, "mail/export.mbox/2 AW_ Angebot.eml", {
      collection: "docs",
      mboxMessageIds: ["m1@example.com", "m2@example.com"],
    });
    const identifier = scriptedIdentifier((r) => ({ decision: "new", canonicalReference: r.reference }));
    await runner(store, recordingRenderer(replyPrepared()), fakeVision(), { identifier }).run(ctx(store, job));
    expect(await stagedText(store, job.id)).not.toContain("Zitierter Verlauf");
  });

  it("drops the quoted history when the parent message is already ingested", async () => {
    const store = createFakeJobStore();
    await seedJob(store, "mail/angebot.eml", { collection: "docs", email: { messageId: "m1@example.com" } });
    const job = await seedJob(store, "mail/reply.eml", { collection: "docs" });
    const identifier = scriptedIdentifier((r) => ({ decision: "new", canonicalReference: r.reference }));
    const outcome = await runner(store, recordingRenderer(replyPrepared()), fakeVision(), { identifier }).run(ctx(store, job));
    expect(outcome).toEqual({ status: "completed" });
    const text = await stagedText(store, job.id);
    expect(text).toContain("Passt so.");
    expect(text).not.toContain("Zitierter Verlauf");
    expect(text).not.toContain("WE-07");
  });
});
