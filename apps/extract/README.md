# @atf/extract

Document-to-Markdown extraction against the [`atf-extract`](../../packages/extract-contract)
contract. Converts PDF, DOCX, XLSX, PNG, JPEG and GIF into Markdown that
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

Requires `poppler-utils` (PDF) and `libreoffice` (DOCX/XLSX) on `PATH`. Without
LibreOffice the service is healthy but reports `degraded_formats: ["docx","xlsx"]`;
without poppler it is unhealthy, because nothing works.

```bash
cp .env.example .env          # set VISION_URL and VISION_MODEL
bun run --cwd apps/extract dev
open http://127.0.0.1:3004
```

The quickstart in `deploy/examples` brings up the whole stack with a deterministic
mock model, so a conversion can be exercised without a GPU.

## Search integration

Two paths exist and they differ in exactly one observable way.

**`POST /v1/ingest` here** — needs `SEARCH_URL`. Converts, indexes, and then
stores figure crops via `PUT /document-assets/:assetId`. Ingest must complete
first: Search resolves the owning document for every asset and answers
`404 Associated document is not visible` otherwise.

**`POST /ingest-file` in Search** — needs `CONVERTER_URL`. Proxies the upload
here, takes the Markdown, and runs Search's own ingest path unchanged. Figure
*descriptions* are indexed, so a search for what a diagram shows still finds it,
but figure *images* are not stored — forwarding Markdown does not carry bytes.
Responses say so with `X-Figure-Assets: not-stored`.

Use the first when figures should be viewable, the second when the simplest
possible wiring matters more.

## Response modes

Selected by request header, so a caller changes one header rather than one URL:

| Header | Mode |
| --- | --- |
| `X-Callback-URL: …` | 202 immediately, result POSTed to the callback |
| `Accept: text/event-stream` | pages stream in reading order as they complete |
| `Accept: text/markdown` | one Markdown response at the end |
| _(default)_ | one JSON envelope at the end |

JSON is the default because the envelope carries figure geometry, per-page
warnings and token usage. `X-Include-Figure-Data: true` embeds the crops as
base64; it is off by default because a document with many figures otherwise
produces a multi-megabyte body on a path where the bytes usually go straight to
Search.

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
