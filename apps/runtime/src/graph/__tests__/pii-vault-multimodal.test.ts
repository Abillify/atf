// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for multimodal (image/file) PII handling in the reversible PII vault
 * (ADR-0016): `src/graph/pii-image-scanner.ts` + the `withPiiVault` decorator's
 * attachment path in `src/graph/pii-vault-engine.ts`.
 *
 * Attachments cannot be reversibly tokenized like text, so the vault applies a
 * one-way control per deployment: `off` (pass through), `block` (strip before
 * the prompt reaches the provider), or `redact` (swap in a redacted copy).
 */

import { describe, it, expect } from "bun:test";
import {
  scanAttachmentBlock,
  createRemoteImageRedactor,
  createLlmImageDescriber,
  isAttachmentBlock,
  attachmentUrl,
  dataUrlMime,
  DEFAULT_WITHHELD_NOTICE,
  type PiiImageRedactor,
  type PiiImageDescriber,
  type GenerateDescriptionFn,
} from "../pii-image-scanner.js";
import { withPiiVault } from "../pii-vault-engine.js";
import { createPiiVault, InMemoryPiiVaultStore } from "../pii-vault.js";
import type { PiiVault, PiiVaultConfig, PiiVaultStore } from "../pii-vault.js";
import type { GraphEngineService } from "../graph-engine/state.js";
import type { ChatMessage, ContentBlock } from "../../types/openai.js";
import type { RequestContext } from "../../types/monitoring.js";

/** `createPiiVault` for a config known to enable the vault (never undefined). */
function mustCreatePiiVault(store: PiiVaultStore, config: PiiVaultConfig): PiiVault {
  const vault = createPiiVault(store, config);
  if (vault === undefined) throw new Error("expected the vault to be enabled");
  return vault;
}

const IMG: ContentBlock = {
  type: "image_url",
  image_url: { url: "data:image/png;base64,AAAA" },
};
const FILE: ContentBlock = {
  type: "file",
  file_url: { url: "data:application/pdf;base64,BBBB" },
};
const TEXT: ContentBlock = { type: "text", text: "hello a@b.com" };

// ---------------------------------------------------------------------------
// Block helpers
// ---------------------------------------------------------------------------

describe("pii-image-scanner helpers", () => {
  it("classifies attachment vs text blocks", () => {
    expect(isAttachmentBlock(IMG)).toBe(true);
    expect(isAttachmentBlock(FILE)).toBe(true);
    expect(isAttachmentBlock(TEXT)).toBe(false);
  });

  it("extracts the source URL from image and file blocks", () => {
    expect(attachmentUrl(IMG)).toBe("data:image/png;base64,AAAA");
    expect(attachmentUrl(FILE)).toBe("data:application/pdf;base64,BBBB");
    expect(attachmentUrl(TEXT)).toBeUndefined();
  });

  it("parses the MIME type from a data URL", () => {
    expect(dataUrlMime("data:image/png;base64,AAAA")).toBe("image/png");
    expect(dataUrlMime("data:application/pdf;base64,BBBB")).toBe(
      "application/pdf",
    );
    expect(dataUrlMime("https://example.com/x.png")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// scanAttachmentBlock
// ---------------------------------------------------------------------------

describe("scanAttachmentBlock", () => {
  it("passes attachments through unchanged in 'off' mode", async () => {
    const r = await scanAttachmentBlock(IMG, { mode: "off" });
    expect(r.action).toBe("passed");
    expect(r.block).toEqual(IMG);
  });

  it("leaves text blocks untouched regardless of mode", async () => {
    const r = await scanAttachmentBlock(TEXT, { mode: "block" });
    expect(r.action).toBe("passed");
    expect(r.block).toEqual(TEXT);
  });

  it("strips attachments to a text notice in 'block' mode", async () => {
    const r = await scanAttachmentBlock(IMG, { mode: "block" });
    expect(r.action).toBe("blocked");
    expect(r.block).toEqual({ type: "text", text: DEFAULT_WITHHELD_NOTICE });
  });

  it("swaps in the redacted image in 'redact' mode", async () => {
    const redactor: PiiImageRedactor = {
      async redact() {
        return "data:image/png;base64,REDACTED";
      },
    };
    const r = await scanAttachmentBlock(IMG, { mode: "redact", redactor });
    expect(r.action).toBe("redacted");
    expect(attachmentUrl(r.block)).toBe("data:image/png;base64,REDACTED");
    // shape is preserved
    expect(r.block.type).toBe("image_url");
  });

  it("degrades 'redact' to strip when no redactor is configured", async () => {
    const r = await scanAttachmentBlock(IMG, { mode: "redact" });
    expect(r.action).toBe("blocked");
    expect(r.block).toEqual({ type: "text", text: DEFAULT_WITHHELD_NOTICE });
  });

  it("fail-open: strips the attachment when the redactor throws", async () => {
    const redactor: PiiImageRedactor = {
      async redact() {
        throw new Error("service down");
      },
    };
    const r = await scanAttachmentBlock(IMG, {
      mode: "redact",
      redactor,
      failMode: "open",
    });
    expect(r.action).toBe("blocked");
    expect(r.block.type).toBe("text");
  });

  it("fail-closed: rethrows when the redactor throws", async () => {
    const redactor: PiiImageRedactor = {
      async redact() {
        throw new Error("service down");
      },
    };
    await expect(
      scanAttachmentBlock(IMG, {
        mode: "redact",
        redactor,
        failMode: "closed",
      }),
    ).rejects.toThrow("service down");
  });

  it("never forwards a raw attachment: an empty URL is stripped", async () => {
    const empty: ContentBlock = { type: "image_url", image_url: { url: "" } };
    const redactor: PiiImageRedactor = {
      async redact() {
        return "data:image/png;base64,X";
      },
    };
    const r = await scanAttachmentBlock(empty, { mode: "redact", redactor });
    expect(r.action).toBe("blocked");
  });

  it("converts the attachment to a text block in 'describe' mode", async () => {
    const describer: PiiImageDescriber = {
      async describe() {
        return "An invoice addressed to Jane Doe, IBAN DE89370400440532013000.";
      },
    };
    const r = await scanAttachmentBlock(IMG, { mode: "describe", describer });
    expect(r.action).toBe("described");
    expect(r.block.type).toBe("text");
    expect((r.block as { text: string }).text).toContain("Jane Doe");
  });

  it("degrades 'describe' to strip when no describer is configured", async () => {
    const r = await scanAttachmentBlock(IMG, { mode: "describe" });
    expect(r.action).toBe("blocked");
  });

  it("describe fail-open strips on describer error; fail-closed rethrows", async () => {
    const describer: PiiImageDescriber = {
      async describe() {
        throw new Error("vision model offline");
      },
    };
    const open = await scanAttachmentBlock(IMG, {
      mode: "describe",
      describer,
      failMode: "open",
    });
    expect(open.action).toBe("blocked");
    await expect(
      scanAttachmentBlock(IMG, { mode: "describe", describer, failMode: "closed" }),
    ).rejects.toThrow("vision model offline");
  });

  it("describe strips when the description is empty", async () => {
    const describer: PiiImageDescriber = {
      async describe() {
        return "   ";
      },
    };
    const r = await scanAttachmentBlock(IMG, { mode: "describe", describer });
    expect(r.action).toBe("blocked");
  });

  it("describe strips a non-image (file) block instead of describing it", async () => {
    let called = false;
    const describer: PiiImageDescriber = {
      async describe() {
        called = true;
        return "should not be called";
      },
    };
    const r = await scanAttachmentBlock(FILE, { mode: "describe", describer });
    expect(r.action).toBe("blocked");
    expect(called).toBe(false); // a PDF is never sent to a vision image part
  });
});

// ---------------------------------------------------------------------------
// createLlmImageDescriber
// ---------------------------------------------------------------------------

describe("createLlmImageDescriber", () => {
  it("passes the image as a real image part and returns the model text", async () => {
    let seen: unknown;
    const generate: GenerateDescriptionFn = async (args) => {
      seen = args.messages;
      return { text: "a scanned letter" };
    };
    const describer = createLlmImageDescriber({} as never, { generate });
    const out = await describer.describe(
      "data:image/png;base64,AAAA",
      "image/png",
    );
    expect(out).toBe("a scanned letter");
    expect(seen).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this attachment:" },
          { type: "image", image: "data:image/png;base64,AAAA" },
        ],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// createRemoteImageRedactor
// ---------------------------------------------------------------------------

describe("createRemoteImageRedactor", () => {
  it("posts the image and returns the redacted data URL", async () => {
    let sentBody: unknown;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ image: "data:image/png;base64,CLEAN" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const redactor = createRemoteImageRedactor({
      endpoint: "http://redactor.internal/redact",
      fetchImpl,
    });
    const out = await redactor.redact("data:image/png;base64,AAAA", "image/png");
    expect(out).toBe("data:image/png;base64,CLEAN");
    expect(sentBody).toEqual({
      image: "data:image/png;base64,AAAA",
      mime: "image/png",
    });
  });

  it("accepts the alternate 'redactedImage' field name", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ redactedImage: "data:image/png;base64,Z" }), {
        status: 200,
      })) as unknown as typeof fetch;
    const redactor = createRemoteImageRedactor({
      endpoint: "http://r/redact",
      fetchImpl,
    });
    expect(await redactor.redact("data:image/png;base64,A", "image/png")).toBe(
      "data:image/png;base64,Z",
    );
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const redactor = createRemoteImageRedactor({
      endpoint: "http://r/redact",
      fetchImpl,
    });
    await expect(
      redactor.redact("data:image/png;base64,A", "image/png"),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("throws when the response has no image field", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ nope: true }), {
        status: 200,
      })) as unknown as typeof fetch;
    const redactor = createRemoteImageRedactor({
      endpoint: "http://r/redact",
      fetchImpl,
    });
    await expect(
      redactor.redact("data:image/png;base64,A", "image/png"),
    ).rejects.toThrow(/missing an image/);
  });
});

// ---------------------------------------------------------------------------
// withPiiVault integration (attachment path)
// ---------------------------------------------------------------------------

function fakeEngine(capture: { received?: ChatMessage[] }): GraphEngineService {
  return {
    buildGraph: () => ({}) as never,
    async executeFlow(_flowId, messages, _ctx, onChunk, onDone) {
      capture.received = messages;
      await onChunk({
        id: "c1",
        object: "chat.completion.chunk",
        created: 0,
        model: "m",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
      });
      await onDone({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    },
    invalidateCache: () => {},
    hasCapacity: () => true,
    getQueueState: () => ({ active: 0, waiting: 0, available: 1, queueLimit: 1 }),
  };
}

function ctx(): RequestContext {
  return { ssoToken: "", executionId: "exec-mm" };
}

/** The first captured message, asserting the engine actually received one. */
function firstReceived(capture: { received?: ChatMessage[] }): ChatMessage {
  const msg = capture.received?.[0];
  if (msg === undefined) throw new Error("expected a first received message");
  return msg;
}

async function run(
  engine: GraphEngineService,
  messages: ChatMessage[],
): Promise<void> {
  await engine.executeFlow(
    "flow",
    messages,
    ctx(),
    async () => {},
    async () => {},
  );
}

describe("withPiiVault — multimodal attachment handling", () => {
  const mixedMessage: ChatMessage = {
    role: "user",
    content: [
      { type: "text", text: "here is my card, email a@b.com" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ],
  };

  it("passes attachments through when multimodal is off (backward compatible)", async () => {
    const vault = mustCreatePiiVault(new InMemoryPiiVaultStore(), { enabled: true });
    const capture: { received?: ChatMessage[] } = {};
    const engine = withPiiVault(fakeEngine(capture), vault); // no multimodal opts
    await run(engine, [mixedMessage]);

    const blocks = firstReceived(capture).content as ContentBlock[];
    expect(blocks[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAA" },
    });
  });

  it("strips the image AND tokenizes the text in 'block' mode", async () => {
    const vault = mustCreatePiiVault(new InMemoryPiiVaultStore(), { enabled: true });
    const capture: { received?: ChatMessage[] } = {};
    const engine = withPiiVault(fakeEngine(capture), vault, { mode: "block" });
    await run(engine, [mixedMessage]);

    const blocks = firstReceived(capture).content as Array<{
      type: string;
      text?: string;
    }>;
    const [textBlock, imageBlock] = blocks;
    if (textBlock === undefined || imageBlock === undefined) {
      throw new Error("expected two content blocks");
    }
    // text block tokenized (no raw email)
    expect(textBlock.text).not.toContain("a@b.com");
    expect(textBlock.text).toMatch(/\[\[PII:[a-f0-9]{16}\]\]/);
    // image block replaced by a text notice
    expect(imageBlock.type).toBe("text");
    expect(imageBlock.text).toBe(DEFAULT_WITHHELD_NOTICE);
  });

  it("redacts the image via the configured redactor in 'redact' mode", async () => {
    const vault = mustCreatePiiVault(new InMemoryPiiVaultStore(), { enabled: true });
    const capture: { received?: ChatMessage[] } = {};
    const redactor: PiiImageRedactor = {
      async redact() {
        return "data:image/png;base64,CLEAN";
      },
    };
    const engine = withPiiVault(fakeEngine(capture), vault, {
      mode: "redact",
      redactor,
    });
    await run(engine, [mixedMessage]);

    const blocks = firstReceived(capture).content as ContentBlock[];
    const imageBlock = blocks[1];
    if (imageBlock === undefined) throw new Error("expected an image block");
    expect(attachmentUrl(imageBlock)).toBe("data:image/png;base64,CLEAN");
  });

  it("describes the image and TOKENIZES the description (PII redacted) in 'describe' mode", async () => {
    const vault = mustCreatePiiVault(new InMemoryPiiVaultStore(), { enabled: true });
    const capture: { received?: ChatMessage[] } = {};
    const describer: PiiImageDescriber = {
      async describe() {
        // The vision model transcribes an email out of the image.
        return "Letter to contact person, reply to jane@example.com.";
      },
    };
    const engine = withPiiVault(fakeEngine(capture), vault, {
      mode: "describe",
      describer,
    });
    await run(engine, [mixedMessage]);

    const blocks = firstReceived(capture).content as Array<{
      type: string;
      text?: string;
    }>;
    const [textBlock, imageBlock] = blocks;
    if (textBlock === undefined || imageBlock === undefined) {
      throw new Error("expected two content blocks");
    }
    // original text block tokenized
    expect(textBlock.text).not.toContain("a@b.com");
    // image replaced by its description — and the description's PII is tokenized
    expect(imageBlock.type).toBe("text");
    expect(imageBlock.text).toContain("[image description]");
    expect(imageBlock.text).not.toContain("jane@example.com");
    expect(imageBlock.text).toMatch(/\[\[PII:[a-f0-9]{16}\]\]/);
  });

  it("fail-closed redactor error aborts the whole run", async () => {
    const vault = mustCreatePiiVault(new InMemoryPiiVaultStore(), { enabled: true });
    const redactor: PiiImageRedactor = {
      async redact() {
        throw new Error("redactor offline");
      },
    };
    const engine = withPiiVault(fakeEngine({}), vault, {
      mode: "redact",
      redactor,
      failMode: "closed",
    });
    await expect(run(engine, [mixedMessage])).rejects.toThrow("redactor offline");
  });
});
