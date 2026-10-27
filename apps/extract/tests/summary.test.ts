// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * summary.test.ts
 *
 * The summary hierarchy.
 *
 * Covers:
 *  - a section that closes produces exactly ONE section summary, from the
 *    closed section's own content (page summaries + block text)
 *  - chapter and document summaries are produced at document end
 *  - a resume does NOT re-call the text-LLM for an already-checkpointed summary
 *  - a stubbed client with no calls (SUMMARY_URL unset → generator absent)
 *    leaves the summaries empty and never calls the model
 *  - the summary client's transient retry and timeout behaviour
 *  - the summary prompt set is folded into the snapshot prompt hash and is
 *    stable / changes appropriately
 *
 * Driven against the in-memory fake store, the real stage runner, and a fake
 * summary client that records its calls — no HTTP, no database, no model.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { OutlineNode, PageRecord, SummaryNode } from "@atf/extract-contract/v2";
import { createFakeJobStore, type FakeJobStore } from "./job-store-fake.js";
import { testLogger } from "./helpers.js";
import { createLeaseGuard } from "../src/jobs/lease.js";
import { createStageRunner, unlimitedBudget, type StageRunner } from "../src/jobs/stage-runner.js";
import { createDocumentPass, type DocumentPass } from "../src/jobs/docpass/document-pass.js";
import { createSummaryGenerator } from "../src/summary/generator.js";
import { createSummaryClient, TransientSummaryFailure } from "../src/summary/client.js";
import type { SummarizeInput, SummaryClient, SummaryResult } from "../src/summary/client.js";
import { summaryPromptSet, SUMMARY_SYSTEM_PROMPTS } from "../src/summary/prompts.js";
import { buildSnapshot, promptHash } from "../src/jobs/snapshot.js";
import { pass1PromptSet, pass2PromptSet } from "../src/vision/prompts.js";
import type { SummaryConfig } from "../src/config.js";

// ── record builders ─────────────────────────────────────────────────────

function heading(page: number, id: string, text: string, numbering: string) {
  return { id, page, type: "heading" as const, level: numbering.split(".").length, text, numbering };
}

function paragraph(page: number, id: string, text: string) {
  return { id, page, type: "paragraph" as const, text };
}

function pageRecord(page: number, blocks: PageRecord["blocks"], summary?: string): PageRecord {
  return {
    type: "page",
    page,
    size: { wPt: 595, hPt: 842 },
    class: "text",
    blocks,
    assets: [],
    warnings: [],
    ...(summary !== undefined ? { summary } : {}),
  };
}

// ── fake summary client ───────────────────────────────────────────────────

interface FakeSummaryClient extends SummaryClient {
  calls: SummarizeInput[];
}

function fakeSummaryClient(): FakeSummaryClient {
  const calls: SummarizeInput[] = [];
  return {
    calls,
    async summarize(input: SummarizeInput): Promise<SummaryResult> {
      calls.push(input);
      return {
        text: `SUMMARY[${input.scope}]: ${input.content.slice(0, 40)}`,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        requests: 1,
      };
    },
    async probe() {
      return { available: true };
    },
  };
}

// ── generator harness ──────────────────────────────────────────────────────

interface Harness {
  store: FakeJobStore;
  jobId: string;
  stageRunner: StageRunner;
  client: FakeSummaryClient;
}

async function harness(): Promise<Harness> {
  const store = createFakeJobStore();
  const jobId = randomUUID();
  await store.createJob({ id: jobId, reference: "tests/doc.pdf", source_sha256: "a".repeat(64) });
  const claimed = await store.claimNextJob("worker-1", 60);
  if (claimed === null) throw new Error("expected a claim");
  const lease = createLeaseGuard(store, { jobId, holder: "worker-1", epoch: Number(claimed.lease_epoch) }, 60);
  const stageRunner = createStageRunner({ store, lease, logger: testLogger });
  return { store, jobId, stageRunner, client: fakeSummaryClient() };
}

function generatorFor(h: Harness, client: SummaryClient = h.client) {
  return createSummaryGenerator({
    client,
    stageRunner: h.stageRunner,
    logger: testLogger,
    jobId: h.jobId,
    sourceSha256: "a".repeat(64),
    model: "test-text-llm",
    budget: unlimitedBudget,
    tokenEstimate: 512,
  });
}

/**
 * Feed a two-chapter document through a document pass, driving section-close
 * summaries as they happen, then finalize. Returns the pass and generator so a
 * test can inspect the produced summaries and the client's calls.
 *
 *   1 Antragseingang            (page 1) ── closes when "2" opens
 *     1.1 Anmeldung           (page 1) ── closes when "1.2" opens
 *     1.2 Prüfung             (page 2) ── closes when "2" opens
 *   2 Bescheidausgang            (page 2) ── open at end
 */
async function runTwoChapterDoc(h: Harness, pass: DocumentPass): Promise<{
  outline: OutlineNode[];
  pageCount: number;
}> {
  const generator = generatorFor(h);
  const pageCount = 2;

  const page1 = pageRecord(
    1,
    [
      heading(1, "h1", "Antragseingang", "1"),
      heading(1, "h1.1", "Anmeldung", "1.1"),
      paragraph(1, "p1", "Der Lieferant meldet den Antragseingang an."),
    ],
    "Seite 1 behandelt die Anmeldung des Antragseingangs.",
  );
  const applied1 = pass.applyPage(page1);
  await generator.onSectionsClosed(applied1.closedSections, pass);

  const page2 = pageRecord(
    2,
    [
      heading(2, "h1.2", "Prüfung", "1.2"),
      paragraph(2, "p2", "Die Ware wird auf Vollständigkeit geprüft."),
      heading(2, "h2", "Bescheidausgang", "2"),
      paragraph(2, "p3", "Der Bescheidausgang wird zusammengestellt."),
    ],
    "Seite 2 behandelt Prüfung und Bescheidausgang.",
  );
  const applied2 = pass.applyPage(page2);
  await generator.onSectionsClosed(applied2.closedSections, pass);

  const outline = pass.outline(pageCount);
  await generator.finalize(pass, outline, pageCount);
  return { outline, pageCount };
}

// ── (a) section-close → one section summary from the closed content ─────────

describe("summary hierarchy · section close", () => {
  it("produces exactly one section summary per closed section, from its content", async () => {
    const h = await harness();
    const pass = createDocumentPass();
    await runTwoChapterDoc(h, pass);

    const sectionCalls = h.client.calls.filter((c) => c.scope === "section");
    // Sections: 1.1 Anmeldung, 1.2 Prüfung, 1 Antragseingang, 2 Bescheidausgang — one
    // summary each, no duplicates.
    expect(sectionCalls.length).toBe(4);

    const summaries = pass.summaries().filter((s) => s.scope === "section");
    expect(summaries.length).toBe(4);

    // The 1.1 Anmeldung summary was built from that section's OWN content: its
    // page summary plus its paragraph, not the whole document.
    const anmeldungCall = sectionCalls.find((c) => c.title?.includes("Anmeldung"));
    expect(anmeldungCall).toBeDefined();
    expect(anmeldungCall?.content).toContain("Der Lieferant meldet den Antragseingang an.");
    // It must NOT contain a sibling section's text.
    expect(anmeldungCall?.content).not.toContain("zusammengestellt");
  });
});

// ── (b) chapter + document summaries at end ─────────────────────────────────

describe("summary hierarchy · chapter and document at end", () => {
  it("produces chapter summaries and one document summary at document end", async () => {
    const h = await harness();
    const pass = createDocumentPass();
    await runTwoChapterDoc(h, pass);

    const chapterCalls = h.client.calls.filter((c) => c.scope === "chapter");
    const documentCalls = h.client.calls.filter((c) => c.scope === "document");

    // Chapters are the level-1/2 headings: "1", "1.1", "1.2", "2".
    expect(chapterCalls.length).toBeGreaterThanOrEqual(2);
    expect(documentCalls.length).toBe(1);

    const summaries = pass.summaries();
    expect(summaries.some((s) => s.scope === "document" && s.id === "document")).toBe(true);
    // The document summary rolls up the chapter summaries.
    expect(documentCalls[0]?.content).toContain("SUMMARY[chapter]");
  });
});

// ── (c) resume does not re-call the text-LLM ────────────────────────────────

describe("summary hierarchy · resume", () => {
  it("does not re-call the text-LLM for an already-checkpointed summary", async () => {
    const h = await harness();

    // First run: produce all summaries against a persisted state.
    const pass1 = createDocumentPass();
    await runTwoChapterDoc(h, pass1);
    const firstCallCount = h.client.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    // Persist the pass state as the runner would (docpass_state) after the last
    // page. A real resume enters runDocumentPass with `lastPage` already at the
    // final page, so it does NOT re-apply pages — it rehydrates and re-runs the
    // document-end finalize. Model exactly that: rehydrate from the persisted
    // state and call finalize with a client that throws if touched. Every
    // summary must be served from its checkpoint / the rehydrated state → no
    // model call.
    await h.store.saveDocpassState(h.jobId, 2, pass1.snapshot());
    const persisted = await h.store.latestDocpassState(h.jobId);
    const pass2 = createDocumentPass(
      persisted?.state as ReturnType<DocumentPass["snapshot"]> | undefined,
    );

    let throwingCalls = 0;
    const throwingClient: SummaryClient = {
      async summarize() {
        throwingCalls++;
        throw new Error("text-LLM must not be called on resume");
      },
      async probe() {
        return { available: true };
      },
    };
    const generator = generatorFor(h, throwingClient);

    // The finalize re-runs the chapter/document stages; each is reused from its
    // checkpoint (identical input hash) or short-circuited by the rehydrated
    // hasSummary guard, with no model call.
    await generator.finalize(pass2, pass2.outline(2), 2);

    expect(throwingCalls).toBe(0);
    // The rehydrated pass already carries every summary from the first run.
    expect(pass2.summaries().length).toBe(pass1.summaries().length);
  });

  it("reuses a summary stage checkpoint even when the pass carries no summary", async () => {
    // A tighter resume case: the summary STAGE completed and was checkpointed,
    // but the pass state that would carry the produced node was lost (a crash
    // between the stage write and the docpass_state save). A fresh pass over the
    // same store must reuse the checkpoint by input hash — no model call — and
    // still land the node on the pass.
    const h = await harness();

    // First: produce a section summary against a fresh pass, populating the
    // checkpoint in the shared store.
    const passA = createDocumentPass();
    const genA = generatorFor(h);
    const p1 = pageRecord(
      1,
      [heading(1, "h1", "Antragseingang", "1"), heading(1, "h1.1", "Anmeldung", "1.1"), paragraph(1, "p1", "Anmeldetext.")],
      "S1.",
    );
    const p2 = pageRecord(2, [heading(2, "h2", "Bescheidausgang", "2"), paragraph(2, "p2", "Ausgang.")], "S2.");
    await genA.onSectionsClosed(passA.applyPage(p1).closedSections, passA);
    await genA.onSectionsClosed(passA.applyPage(p2).closedSections, passA);
    expect(h.client.calls.some((c) => c.title?.includes("Anmeldung"))).toBe(true);

    // Second: a brand-new pass (no summaries in state) over the SAME store, with
    // a throwing client. The section ids are minted identically (fresh seq), and
    // the section content is identical, so the stage input hash matches and the
    // checkpoint is reused with no model call.
    let throwingCalls = 0;
    const throwingClient: SummaryClient = {
      async summarize() {
        throwingCalls++;
        throw new Error("must not be called: checkpoint should be reused");
      },
      async probe() {
        return { available: true };
      },
    };
    const passB = createDocumentPass();
    const genB = generatorFor(h, throwingClient);
    // Section 1.1 closes on page 2 (when "1.2" opens), so both pages must be
    // folded to reproduce the close event whose checkpoint is reused.
    await genB.onSectionsClosed(passB.applyPage(p1).closedSections, passB);
    await genB.onSectionsClosed(passB.applyPage(p2).closedSections, passB);

    expect(throwingCalls).toBe(0);
    // The reused checkpoint's node landed on the fresh pass.
    const anmeldung = passB.summaries().find((s) => s.summary.includes("Anmelde"));
    expect(anmeldung).toBeDefined();
  });
});

// ── (d) no generator → no calls, summaries empty ────────────────────────────

describe("summary hierarchy · optional", () => {
  it("produces no summaries and makes no calls when the generator is absent", async () => {
    // The runner passes a null generator when SUMMARY_URL is unset. Modelling
    // that here: the document pass runs with no generator wired, so no summary
    // is ever produced and the client is never touched.
    const h = await harness();
    const pass = createDocumentPass();

    pass.applyPage(
      pageRecord(1, [heading(1, "h1", "Antragseingang", "1"), paragraph(1, "p1", "Text.")], "S1."),
    );
    pass.applyPage(
      pageRecord(2, [heading(2, "h2", "Bescheidausgang", "2"), paragraph(2, "p2", "Text.")], "S2."),
    );

    expect(pass.summaries()).toEqual([]);
    expect(h.client.calls.length).toBe(0);
  });
});

// ── (e) summary client retry / timeout behaviour ────────────────────────────

describe("summary client · transport", () => {
  const baseConfig: SummaryConfig = {
    url: "http://localhost:0/v1/chat/completions",
    model: "test-text-llm",
    apiKey: null,
    timeoutMs: 50,
    temperature: 0.1,
    maxTokens: 256,
    maxRetries: 2,
    reasoningEffort: null,
  };

  it("retries a transient 5xx and then succeeds", async () => {
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        return new Response("boom", { status: 503 });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Eine Zusammenfassung." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    try {
      const client = createSummaryClient(baseConfig, testLogger);
      const result = await client.summarize({ scope: "section", content: "Text." });
      expect(result.text).toBe("Eine Zusammenfassung.");
      expect(calls).toBe(2); // one 503, one success
      expect(result.requests).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("gives up transiently after exhausting retries on a persistent 5xx", async () => {
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("still down", { status: 502 });
    }) as unknown as typeof fetch;
    try {
      const client = createSummaryClient(baseConfig, testLogger);
      await expect(client.summarize({ scope: "document", content: "Text." })).rejects.toBeInstanceOf(
        TransientSummaryFailure,
      );
      // 1 initial + maxRetries(2) = 3 attempts.
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not retry a permanent 4xx", async () => {
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("bad model", { status: 400 });
    }) as unknown as typeof fetch;
    try {
      const client = createSummaryClient(baseConfig, testLogger);
      await expect(client.summarize({ scope: "section", content: "Text." })).rejects.toThrow();
      expect(calls).toBe(1); // no retry on 4xx
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("times out and surfaces a transient failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      // Never resolve until aborted by the client's timeout.
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;
    try {
      const client = createSummaryClient({ ...baseConfig, maxRetries: 0, timeoutMs: 20 }, testLogger);
      await expect(client.summarize({ scope: "section", content: "Text." })).rejects.toBeInstanceOf(
        TransientSummaryFailure,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── (f) prompt hash includes the summary prompts ────────────────────────────

describe("summary prompts · snapshot hash", () => {
  it("folds the summary prompt set into the snapshot prompt hash", () => {
    const descriptor = {
      extractor: "poppler",
      renderer: "pdftoppm",
      visionModel: "vlm",
      renderDpi: 200,
      figureDpi: 300,
    };
    const withoutSummary = buildSnapshot(descriptor, { ...pass1PromptSet(), ...pass2PromptSet() });
    const withSummary = buildSnapshot(descriptor, {
      ...pass1PromptSet(),
      ...pass2PromptSet(),
      ...summaryPromptSet(),
    });
    // Adding the summary prompts changes the prompt hash (they are covered).
    expect(withSummary.promptHash).not.toBe(withoutSummary.promptHash);
    // The pipeline hash is unaffected (prompts are not pipeline).
    expect(withSummary.pipelineHash).toBe(withoutSummary.pipelineHash);
  });

  it("is stable across calls and changes when a prompt changes", () => {
    const stable = promptHash(summaryPromptSet());
    expect(promptHash(summaryPromptSet())).toBe(stable);

    const mutated = { ...summaryPromptSet(), "summary.system.section": "different prompt" };
    expect(promptHash(mutated)).not.toBe(stable);
  });

  it("includes a system prompt per scope", () => {
    const set = summaryPromptSet();
    expect(set["summary.system.section"]).toBe(SUMMARY_SYSTEM_PROMPTS.section);
    expect(set["summary.system.chapter"]).toBe(SUMMARY_SYSTEM_PROMPTS.chapter);
    expect(set["summary.system.document"]).toBe(SUMMARY_SYSTEM_PROMPTS.document);
  });
});

// ── section summary lands on document.end via the pass summaries() ──────────

describe("summary hierarchy · document.end payload", () => {
  it("collects page-range metadata on the section summary nodes", async () => {
    const h = await harness();
    const pass = createDocumentPass();
    await runTwoChapterDoc(h, pass);

    const summaries: SummaryNode[] = pass.summaries();
    const section = summaries.find((s) => s.scope === "section");
    expect(section).toBeDefined();
    expect(typeof section?.pageStart).toBe("number");
    // The document node spans the whole document.
    const doc = summaries.find((s) => s.scope === "document");
    expect(doc?.pageStart).toBe(1);
    expect(doc?.pageEnd).toBe(2);
  });
});
