# 16. Multimodal (image/file) PII handling in the reversible vault

Date: 2026-07-17

## Status

Accepted

## Context

The reversible PII tokenization vault (ADR-0007) and its extensible detector
pipeline (ADR-0015) protect PII in message **text**: a detected span is replaced
with a `[[PII:…]]` placeholder before the prompt reaches the provider and
transparently restored in the streamed response.

That reversible round-trip only works for text. The vault's `tokenizeMessages`
step iterated a message's content blocks and processed `text` blocks, passing
every other block (`image`, `image_url`, `file`) through **unchanged**. For a
document-heavy deployment — the driving debt-collection (Inkasso) use
case routinely sends scanned IDs, invoices, and Mahnbescheide to a vision model
— this meant raw PII embedded in an image reached the provider untouched. The
platform's flagship privacy control had a blind spot in exactly the use case
that most needed it.

The obvious fix — "tokenize the image like text" — is not possible: the model
consumes pixels, and there is no placeholder that can be swapped back into a
picture on the way out. Whatever we do to an attachment is inherently one-way.

## Decision

Add a **one-way** multimodal control to the same `withPiiVault` decorator, so it
inherits the vault's single-integration-point property (ADR-0007): it applies
across every entry point (chat streaming/non-streaming, async jobs, webhook and
scheduled triggers, replay, the flow-as-MCP-server) with no per-call-site
change.

The control is selected by `PII_VAULT_MULTIMODAL_MODE`:

- **`off`** (default) — attachments pass through unchanged. Fully backward
  compatible; a deployment that does not set the flag is unaffected.
- **`block`** — every image/file block is stripped before the prompt is sent
  and replaced with a text notice. Dependency-free; a hard guarantee that no
  un-scanned pixels leave the system. The correct default for a regulated flow
  that does not need the image content.
- **`redact`** — each attachment is sent to an external image-redaction service
  (a `PiiImageRedactor`; the shipped implementation targets a
  presidio-image-redactor-style HTTP sidecar) which returns a redacted copy that
  replaces the original, preserving visual context minus the PII.
- **`describe`** — a vision model (`PiiImageDescriber`, an injectable
  `LanguageModel`) converts the attachment into a factual text description; that
  description is then routed through the **same text tokenization/redaction** as
  normal message content before the prompt is sent. This reframes the
  un-reversible-image problem as the already-solved text problem: the downstream
  provider receives redacted *text* instead of pixels. **Trust boundary:** the
  describer model sees the raw image, so it must be a trusted/local model (e.g.
  Ollama `llava`) — pointing it at the same third-party provider being shielded
  defeats the purpose; the platform logs a warning when the describer provider
  is not local. When no describer model is configured, `describe` degrades to
  `block`.

A redactor/describer failure is governed by `PII_VAULT_MULTIMODAL_FAIL_MODE`:

- **`open`** (default) degrades to `block` — the attachment is stripped, so a
  raw image is **never** forwarded even during a redactor outage (availability
  without leaking).
- **`closed`** rethrows, failing the whole request (coverage over availability).

When `redact` is configured without an endpoint, the vault logs a warning and
falls back to `block` rather than silently passing the raw image through.

### Why not in-process OCR + NER on images?

We considered running OCR (e.g. Tesseract or a vision model) in-process, then
detecting PII in the extracted text. Rejected for this iteration:

1. **It is still one-way.** Even with perfect OCR we cannot restore the original
   image around the model, so the outcome for the caller is the same as
   `block`/`redact` — the extra machinery buys detection granularity, not
   reversibility.
2. **Heavy, unverifiable dependency.** A document OCR stack is a large binary
   dependency whose real-world accuracy we could not validate inside the test
   suite, mirroring the reason the NER backend (ADR-0015) is opt-in and its
   real-model path lives outside `bun test`.
3. **The `redact` and `describe` seams already cover it.** An operator who wants
   OCR-based redaction points `PII_IMAGE_REMOTE_ENDPOINT` at a service (Presidio
   does exactly this). An operator who wants the image's *content* as redacted
   text uses `describe` mode with a local vision model — effectively LLM-based
   OCR+description whose output re-enters the proven text tokenization path —
   keeping the heavy, GPU-optional work in a model/sidecar the operator
   controls, consistent with the `remote` detector backend from ADR-0015. Either
   way the heavy dependency stays out of the core and off the default path.

## Consequences

- **Positive.** The vault's blind spot is closed with a strong, dependency-free
  default (`block`) and an extensible path (`redact`) for deployments that need
  the image. The mode is surfaced at `GET /admin/pii-vault/status` and in the
  compliance dossier's PII-vault posture, so it is auditable configuration
  evidence. Backward compatible (off by default). The per-block transform and
  the remote redactor are pure/injectable and unit-tested
  (`src/graph/__tests__/pii-vault-multimodal.test.ts`).
- **Negative / residual.** `block` loses the attachment's information for the
  model (acceptable for flows that do not need it; a flow that does should use
  `redact`). `redact` quality is only as good as the external service. The
  control is currently a **global** mode, not yet per-flow like the text
  detectors (`guardrails.yaml`'s `detectors`/`piiTypes`); a per-flow override is
  a natural follow-up, wired through the same guardrail-policy resolver.
- **Remote URL attachments.** An attachment referenced by an `http(s)://` URL
  (rather than a `data:` URI) is handed to the redactor as-is in `redact` mode
  (the service is expected to fetch it) and stripped in `block` mode; it is never
  fetched-and-forwarded by aiperator itself.

## Implementation

- `src/graph/pii-image-scanner.ts` — `scanAttachmentBlock` (per-block
  transform), `createRemoteImageRedactor` (injectable-fetch HTTP redactor),
  `createLlmImageDescriber` (injectable vision-model describer), and block
  helpers.
- `src/graph/pii-vault-engine.ts` — `withPiiVault` accepts optional
  `MultimodalOptions`; `tokenizeMessages` applies the control to non-text blocks
  and routes a `described` result back through text tokenization.
- `src/config/schema.ts` / `load.ts` — `PII_VAULT_MULTIMODAL_MODE`
  (`off`/`block`/`redact`/`describe`), `PII_VAULT_MULTIMODAL_FAIL_MODE`,
  `PII_IMAGE_REMOTE_ENDPOINT`, `PII_IMAGE_REMOTE_API_KEY`,
  `PII_IMAGE_REMOTE_TIMEOUT_MS`, `PII_IMAGE_DESCRIBE_MODEL`,
  `PII_IMAGE_DESCRIBE_PROMPT`.
- `src/index.ts` — builds the redactor + options and passes them to
  `withPiiVault`; feeds the mode into the PII-vault status route and dossier
  posture.
