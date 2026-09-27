# @atf/extract

Document-to-Markdown extraction against the [`atf-extract`](../../packages/extract-contract)
contract. Converts PDF, DOC, DOCX, XLS, XLSX, PNG, JPEG, GIF, TIFF, BMP and WebP into Markdown that
`@atf/search` can index with page numbers, figure entries and per-page summaries
intact.

```
POST /v1/convert   document in, canonical Markdown out
POST /v1/ingest    convert and index in Search, including figure crops
GET  /             operator upload UI, SSO login
GET  /health       liveness plus converter-binary and model reachability
GET  /metrics      Prometheus, including pages, token spend and queue depth
GET  /openapi.json
```

## How a page is converted

Every format funnels through one PDF page loop. A PDF is used directly; DOCX and
XLSX become a PDF via LibreOffice first; a single image becomes a one-page
document. That is why page numbers, page images and text offsets agree across
formats — and why a Word document has page numbers at all, which a direct OOXML
parser cannot provide because it never lays the document out.

Per page:

1. render at `RENDER_DPI` — what the model sees
2. extract the text layer with `pdftotext -layout` — what the model must not re-read
3. one vision call, returning `<summary>`, `<figures>` and `<markdown>`
4. render at `FIGURE_DPI` and cut crops, but only for pages that have figures

**The division of labour in step 3 is the substance of the whole service.** The
text layer is authoritative for *wording*: spelling, part numbers, dates,
units. The rendered page is authoritative for *structure*: heading hierarchy,
table geometry including merged cells, and where figures sit in the flow. A
vision model asked to read text it could instead be told verbatim will silently
"correct" an article number. Tables invert the rule, and the prompt says so — a
text layer linearises a table and loses every merge.

Step 4 renders the page twice on purpose. Crops are shown to a human in a search
result, so they should be sharper than the model's input, and re-rasterising a
page costs milliseconds next to a model call that costs seconds.

## Text-layer fidelity check

The prompt makes the text layer authoritative for wording, but that is enforced
by instruction alone — nothing stops a model from silently "correcting" an
article number or a date, and the result looks plausible. So when a page *has* a
text layer (`ocr: false`), a deterministic check compares the risky tokens of
that layer — numbers and mixed identifiers like `BA2b` or `WU-123` — against the
produced Markdown. If a page lost enough of them (both an absolute count and a
share of the page's tokens, so a dropped footer number never trips it), it gets
a page warning naming the missing values.

It never rewrites the output. A deterministic replacement would need a reliable
alignment between the restructured Markdown and the linearised text layer, which
does not exist, and would destroy the legitimate omissions the prompt asks for
(headers, page numbers). The warning is the honest primitive: it makes the
instruction measurable and surfaces the one failure class that matters, leaving
the human to judge. The signal is also aggregated at `/metrics` as
`extract_text_fidelity_checks_total`, `extract_text_fidelity_divergences_total`
and `extract_text_fidelity_missing_tokens_total`.

## Two retry axes

A page fails in two unrelated ways and conflating them handles both badly:

| Failure | Response | Why |
| --- | --- | --- |
| connection reset, 502, empty completion | retry in place with backoff | the request was fine, the world was not |
| `finish_reason: "length"` | escalate to the next `VISION_MAX_TOKEN_VARIANTS` budget | retrying identically produces the identical truncation |

Truncation matters more than it looks: a cut-off response loses the tail of the
page silently, so a page that looks successful is missing its last third. It is
therefore a distinct signal all the way out to
`extract_vision_truncations_total`.

When the largest budget still truncates, the partial response is kept with a
warning rather than discarded. A flagged 80% page beats a missing page. The same
reasoning applies one level up: a page whose model call fails outright becomes an
empty page carrying a warning, and the run continues — failing the document would
throw away 199 good pages because of one, after having already paid for them.

## Running it

Requires `poppler-utils` (PDF) and `libreoffice` (DOC/DOCX/XLS/XLSX) on `PATH`. Without
LibreOffice the service is healthy but reports
`degraded_formats: ["doc","docx","xls","xlsx"]`; without poppler it is unhealthy, because
nothing works.

```bash
cp .env.example .env          # set VISION_URL and VISION_MODEL
bun run --cwd apps/extract dev
open http://127.0.0.1:3004
```

The quickstart in `deploy/examples` brings up the whole stack with a deterministic
mock model, so a conversion can be exercised without a GPU.

## Search integration

Extract converts; Search chunks, embeds, versions and serves. Extract owns none
of Search's indexing logic and Search owns no document converter — Search would
otherwise need poppler and LibreOffice on its query path, a document-parser
attack surface and minutes-long CPU work competing with query latency. So on the
ingest path Extract orchestrates and calls Search over two thin HTTP requests.

### What one `POST /v1/ingest` does

`SEARCH_URL` must be set. In order:

1. **Convert** the upload to canonical Markdown plus figure crops (the crop
   bytes stay in memory). `X-Reference` is mandatory here, unlike `/v1/convert`:
   it is the row key Search stores under, so defaulting it to a filename would
   let two `scan.pdf` uploads overwrite each other.
2. **`POST /ingest` to Search** with the Markdown as the `text/markdown` body and
   the `X-…` headers the contract builds. Every ingest parameter Search accepts
   can be set on the request and is forwarded — routing (`X-Collection`,
   `X-Reference`, `X-Title`, `X-Source`, `X-Link`, `X-Version`, `X-Version-Mode`,
   `X-Valid-From`), access control (`X-Allowed-Users` / `X-Allowed-Groups`,
   narrowed to the caller), and the full chunking and structure surface
   (`X-Chunk-Size`, `X-Chunk-Overlap`, `X-Semantic-Chunking`,
   `X-Breakpoint-Percentile`, `X-Late-Chunking-Alpha`, `X-Context-Prefix-Size`,
   `X-Chapter-Split-Max-Chunks`, `X-Quantization`, `X-Summarize`,
   `X-Summary-Mode`, `X-Document-Structure`, `X-Fts-Language`, `X-Tags`,
   `X-Metadata`). Out-of-range values are rejected here with a 400 before a
   conversion is paid for, rather than surfacing as a late 400 from Search.
   Search then chunks the document, embeds every chunk, and upserts the rows.
   Crucially, each `<figure>`
   in the Markdown becomes its own *figure chunk* whose `chunk.asset_id` and
   `chunk.parent_ref` are written into the row — the hook the image will hang on.
3. **`PUT /document-assets/:assetId` to Search, once per figure.** Only now are
   the crops storable. The `assetId` is `sha256(reference + figureId)`, which
   Search re-derives and verifies, and the bytes land in a separate
   `vs_document_assets` table.

The response reports `page_count`, `figure_count`, `assets_stored`,
`assets_failed` and per-page `warnings`.

### Why the order is fixed, not a preference

The asset upload is a *conditional* insert: Search stores the crop only if a
visible chunk row already exists whose `chunk.asset_id` and `chunk.parent_ref`
match the request. That figure row is created by the `/ingest` run. Upload the
crops first and the condition matches nothing, so Search answers
`404 Associated document is not visible`. There is no foreign key — the link
*is* that JSONB match — so ingest must complete before any asset upload.

A crop that fails to store does not fail the ingest: the document is already
indexed and the figure descriptions are already retrievable, so only the
thumbnail is missing. The per-figure outcome is counted into `assets_failed`
rather than rolled back — a complete index minus one thumbnail beats no index.

### Chapter splitting does not orphan assets

Search may split a large document into chapter sub-documents — either from its
own `chapterSplitMaxChunks` default or when a caller sets
`X-Chapter-Split-Max-Chunks` on the ingest. When it does, only the *text* is
split: the chapter rows get derived references like `<reference>/1. Einleitung`,
and the text chunks follow them. The **figures do not move**. They are expanded once from the whole
document into a flat set of figure chunks, and every one keeps
`parent_ref = <original reference>` and its `asset_id = sha256(<original
reference> + figureId)` — independent of how many chapters the prose became.

That is exactly what makes the crop upload keep working. Extract stores every
figure against the one reference it converted, and sends that reference as
`X-Document-Reference` on each `PUT /document-assets/:assetId`. The asset's
visibility condition (`chunk.parent_ref = X-Document-Reference AND
chunk.asset_id = assetId`) resolves against those unchanged figure rows, whether
or not Search chaptered the prose. So a 400-page manual split into 30 chapters
still stores and serves every figure: splitting changes where the *text* is
addressable, never where the *images* are attached.

### The alternative: `POST /ingest-file` in Search

`CONVERTER_URL` must be set. Search proxies the upload here, takes the Markdown,
and runs its own ingest path unchanged. Figure *descriptions* are indexed, so a
search for what a diagram shows still finds it, but figure *images* are not
stored — forwarding Markdown does not carry bytes. Responses say so with
`X-Figure-Assets: not-stored`.

Use `POST /v1/ingest` here when figures should be viewable, `POST /ingest-file`
when the simplest possible wiring matters more.

## Response modes

Selected by request header, so a caller changes one header rather than one URL:

| Header | Mode |
| --- | --- |
| `X-Callback-URL: …` | 202 immediately, result POSTed to the callback |
| `X-Callback-URL: …` + `X-Callback-Events: extract` | additionally emits `queued`, `converting`, `progress`, `heartbeat` and `error` callback events |
| `Accept: text/event-stream` | pages stream in reading order with queue state, tokens, ETA and timing |
| `Accept: text/markdown` | one Markdown response at the end |
| _(default)_ | one JSON envelope at the end |

JSON is the default because the envelope carries figure geometry, per-page
warnings, token usage and timing telemetry. Completed responses expose the same
summary through `X-Token-Usage`, `X-Model` and the compatibility alias
`X-Vision-Model`. `timings.totalMs` measures the extraction pipeline through
page assembly; `timeToFirstPageMs` is the extraction duration plus the first
ordered page's processing time, not network delivery latency.

SSE emits `accepted`, `queued`, `converting`, `progress`, `heartbeat`, `error`
and `done` in that lifecycle order; clients must ignore event names they do not
recognise for forward compatibility. Progress pages are emitted in reading
order. With `X-Callback-Events`, intermediate callback POSTs use the same event
names, carry both `jobId` and `job_id`, are serialized per job, have no retries
and are best-effort. At most one in-flight event and the latest pending event are
kept, so slow receivers may miss intermediate progress but cannot build an
unbounded backlog. Their delivery runs independently of conversion work; the
terminal `completed` or `failed` callback waits for at most those two queued
attempts and retains `CALLBACK_MAX_RETRIES`. Every callback attempt is bounded
by `CALLBACK_TIMEOUT_MS`.

`X-Include-Figure-Data: true` embeds the crops as base64; it is off by default
because a document with many figures otherwise produces a multi-megabyte body
on a path where the bytes usually go straight to Search.

## Security

`X-Callback-URL` is a blind server-side request forgery primitive: it makes this
service issue a request to a caller-chosen address. Link-local and metadata
addresses (`169.254.0.0/16`, `metadata.google.internal`) are refused
unconditionally. Everything else the container can reach is permitted unless
`CALLBACK_ALLOWED_HOSTS` is set — the empty default keeps the feature usable out
of the box, and the production readiness gate flags it so the trade-off is a
decision rather than an inheritance.

Other properties worth knowing:

- **Converters get a minimal environment.** `VISION_API_KEY`, `SEARCH_TOKEN`,
  `API_TOKEN` and `OIDC_CLIENT_SECRET` are not in it. A document parser that can
  be made to read its environment should find nothing there.
- **Filenames never reach a process argument.** `office.ts` generates its own
  input filename; the uploaded one is only a hint for format resolution and a
  default title.
- **Uploads are type-sniffed, not trusted.** A `.zip` renamed to `.pdf` is
  refused before `pdfinfo` sees it, and a declaration cannot route arbitrary
  bytes into LibreOffice.
- **Images are bounded by decoded pixels, not bytes.** A 100 KiB PNG can declare
  30 000 × 30 000 pixels; `MAX_UPLOAD_BYTES` does not catch that.
- **`/v1/*` accepts only machine credentials, `/ui/*` only the session cookie.**
  A cookie authenticating an API call turns a CSRF into a document upload; a
  bearer token authenticating the UI makes the UI credential a full programmatic
  one.
- **The ingest ACL can only narrow.** `X-Allowed-Users` / `X-Allowed-Groups` are
  intersected with the caller's own identity, never passed through.

`checkProductionReadiness` refuses to start in production with any of the
permissive development defaults. Run with `NODE_ENV=development` to accept them
explicitly; the same findings are then printed as warnings, so the list is
visible before a config is promoted.

## Configuration

Full reference: [`docs/CONFIGURATION.md`](../../docs/CONFIGURATION.md), generated
from `src/config.ts`. Only `VISION_URL` and `VISION_MODEL` are required. The ones
worth deciding deliberately:

| Variable | Default | Why it matters |
| --- | --- | --- |
| `RENDER_DPI` | 200 | Below it small table text stops being legible; above it image cost grows without better transcription |
| `FIGURE_DPI` | 300 | Must be ≥ `RENDER_DPI`; a crop coarser than the model's input is never wanted |
| `VISION_MAX_TOKEN_VARIANTS` | 8192,16384,32768 | The truncation escalation ladder |
| `MAX_PAGES` | 0 (unlimited) | Production requires a ceiling: tokens are spent per page |
| `CONVERT_CONCURRENCY` | 2 | Each conversion holds a LibreOffice process and page buffers |
| `PAGE_CONCURRENCY` | 4 | Pages of one document in flight against the model |
| `QUEUE_MAX_DEPTH` | 32 | Beyond it uploads get 503 with `Retry-After`, which a caller can act on |
| `CALLBACK_ALLOWED_HOSTS` | (empty) | Closes the SSRF surface described above |

## Tests

```bash
bun run --filter @atf/extract test
```

`tests/pipeline.test.ts` exercises the real orchestrator end to end using a PNG,
so it needs neither poppler nor LibreOffice and runs anywhere. Only the vision
call is stubbed. Its crop-geometry assertion is the regression test for the defect
this service replaces: the earlier cropper read `[x1, y1, x2, y2]` as
`[x, y, w, h]`, so every crop of a figure not starting at the page origin was of
the wrong region — and looked plausible.
