# @atf/extract

Document-to-Markdown extraction against the [`atf-extract`](../../packages/extract-contract)
contract. Converts PDF, DOC, DOCX, HTML, XLS, XLSX, PPTX, VSDX, BPMN, PNG, JPEG, GIF, TIFF, BMP and
WebP into Markdown (v1) or a v2 NDJSON record stream that `@atf/search` can index with page
numbers, figure entries and per-page summaries intact.

```
POST /v1/convert   document in, canonical Markdown out
POST /v1/ingest    convert and index in Search, including figure crops
POST /v2/uploads   resumable chunked upload or source_url pull   (needs EXTRACT_DATABASE_URL)
POST /v2/jobs      persistent, resumable extraction job           (needs EXTRACT_DATABASE_URL)
POST /v2/render    on-demand page or region render from a stored source
GET  /             operator console, SSO login; with EXTRACT_DATABASE_URL also new v2 jobs,
                   the job overview and page preview (/ui/uploads, /ui/jobs, /ui/render)
GET  /health       liveness plus converter-binary and model reachability
GET  /metrics      Prometheus, including pages, token spend and queue depth
GET  /openapi.json
```

## Supported formats

| Format | How it becomes pages |
| --- | --- |
| PDF | used directly |
| DOC, DOCX | LibreOffice → PDF. On the v2 job path the DOCX styles additionally give authoritative heading levels for the outline |
| HTML (`.html`, `.htm`, XHTML) | LibreOffice Writer → PDF, after every reference LibreOffice could follow is stripped: script, frame, object, embed, link and base elements, `<meta http-equiv>`, URL-bearing attributes (except `<a href>` and inline `data:` images) and CSS `url(…)`/`@import`. External images therefore do not appear. This closes request forgery and local file reads through the layout step (`src/pipeline/office.ts`) |
| XLS, XLSX | LibreOffice → PDF. On the v2 job path an XLSX is read natively into one `table` block per worksheet and only rendered when it embeds a chart or image |
| PPTX | LibreOffice → PDF |
| VSDX | LibreOffice → PDF for the page image; on the v2 job path the shape text and connector graph are also read natively from the package |
| BPMN 2.0 XML | parsed natively into a `process` transcription, no render and no model call; the original XML is kept as a `native:` asset. Only the v2 job path handles it |
| E-mail (EML, MSG, mbox) | parsed natively (MIME, RFC 2047/2231, any WHATWG charset; Outlook `.msg` via its CFB/MAPI properties) into one page per message: subject, sender/recipients/date and the message's own text — signature removed, quoted history removed only when the quoted message is already in the collection (else kept under "Zitierter Verlauf"), inline replies keep the quoted lines they answer. Attachments (and a `.msg`'s embedded messages) are ingested as documents of their own; an mbox with several messages is split into one child e-mail per message. No render, no model call. Only the v2 job path handles it |
| PNG, JPEG, GIF, TIFF, BMP, WebP | normalised to a one-page document by sharp |

Types are sniffed from magic bytes, extension and declared `Content-Type` together
(`src/formats.ts`); a declaration alone never routes bytes into a parser.

## How a page is converted

Every rendered format funnels through one PDF page loop. A PDF is used directly;
the Office formats (DOC, DOCX, XLS, XLSX, PPTX, VSDX) and HTML become a PDF via LibreOffice
first; a single image becomes a one-page document. That is why page numbers, page images and text offsets agree across
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

Requires `poppler-utils` (PDF) and `libreoffice` (DOC/DOCX/XLS/XLSX/PPTX/VSDX) on `PATH`.
Without LibreOffice the service is healthy but reports
`degraded_formats: ["doc","docx","xls","xlsx"]` (PPTX and VSDX need it too but are not listed
there); without poppler it is unhealthy, because nothing works.

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

`SEARCH_URL` must be set. When `EXTRACT_DATABASE_URL` is set as well, `/v1/ingest` is a
thin wrapper around a v2 job: the upload is stored in the source store, a job is created
and, for a small document, driven inline so the synchronous response is preserved; the
job's emitter writes the revision and figure assets through Search's v2 revision API (see
[v2 jobs](#v2-persistent-jobs)). Without a database the original synchronous path below
runs. In order:

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

`CONVERTER_URL` must be set in Search, and this service needs `EXTRACT_DATABASE_URL`.
Search uploads the bytes here through `/v2/uploads` (one chunk), creates a job with
`POST /v2/jobs` and answers `202` with the `job_id` and a `Location` pointing at
`/v2/jobs/{id}`. The job's emitter stores the revision *and* the figure images in
Search, so the former `X-Figure-Assets: not-stored` gap is closed. `CONVERTER_TOKEN`
therefore needs `extract.ingest` (and `extract.admin` for Search's `/v2/render` zoom
path).

Use `POST /v1/ingest` when the caller wants a synchronous result, `POST /ingest-file`
when Search should be the only entry point and polling a job is fine.

## v2 persistent jobs

The v1 routes convert in process: a crash loses the conversion, and a 10 000-page source
cannot arrive in one POST. v2 adds durable sources and jobs. The upload and job routes are
mounted only when `EXTRACT_DATABASE_URL` is set; all v2 state lives in a dedicated `extract`
schema on that Postgres, created by Extract's own migration runner.
Without it the service stays database-free and serves the v1 paths only. Migration steps:
[`docs/document-intelligence-v2-migration.md`](../../docs/document-intelligence-v2-migration.md).

### Sources: `/v2/uploads`

| Route | Purpose |
| --- | --- |
| `POST /v2/uploads` | Open a resumable session (`reference` via `X-Reference` or body, optional `size` and whole-file `sha256` / `X-Checksum-Sha256`). A JSON body with `source_url` instead pulls the source in one shot; its 201 also reports the response `content_type` and a derived `filename` (final URL segment, or an extension from a supported `Content-Type`) to pass on to `POST /v2/jobs` |
| `HEAD /v2/uploads/{id}` | Report the confirmed byte offset in `Upload-Offset`, so a client resumes exactly there |
| `PATCH /v2/uploads/{id}` | Append one chunk. `Upload-Offset` must equal the confirmed offset (otherwise 409 with the true offset); an optional `X-Chunk-Checksum-Sha256` is verified before the chunk touches the session file |
| `POST /v2/uploads/{id}/complete` | Verify the whole-file sha256 and move the file into the content-addressed store. Idempotent on replay |

Chunks stream through `UPLOAD_TMP_DIR`; only a verified file lands in `SOURCE_STORE_DIR`,
under a path derived from its sha256, so identical bytes dedupe and a job can always
re-render from the one durable copy. `MAX_UPLOAD_BYTES` bounds a session. The offset lives
in Postgres and the bytes on the volume, so both directories must be persistent and shared
by every replica.

A `source_url` pull is the same SSRF primitive as `X-Callback-URL`, with stricter address
rules. Only http(s) without credentials; link-local and metadata names are refused; when
`SOURCE_URL_ALLOWED_HOSTS` is set the host must match it (`.example.com` matches
subdomains); every resolved A/AAAA address must be public, even for an allowlisted host,
so a source cannot live on a private, loopback, CGNAT or ULA address. The connection is
pinned to the validated address, at most three redirects are followed and each hop is
re-validated. The body streams into the store with `SOURCE_URL_MAX_BYTES` and
`SOURCE_URL_TIMEOUT_MS` as bounds. With the database enabled, the production gate flags an
empty `SOURCE_URL_ALLOWED_HOSTS`.

### Jobs: `/v2/jobs`

| Route | Purpose |
| --- | --- |
| `POST /v2/jobs` | Create a job for a stored source: `reference`, `sourceSha256` (required), optional `filename` (types the source; defaults to the reference), `collection`, `pages`, `tokenBudget`, `priority`, `visibility`, `resumePolicy`, `callbackUrl`, `version`, `sourceModifiedAt`, `dedup`, `allowedUsers`, `allowedGroups`, `title`, `tags`, `metadata`, `link`, `sourceLabel`. 201 with the queued job |
| `GET /v2/jobs` | List jobs newest first (`limit` 1–100, default 25; `offset`) |
| `GET /v2/jobs/{id}` | Status, per-stage progress, warnings (a failed job carries its cause), tokens, cost and ETA. A non-UUID id is a 404 |
| `GET /v2/jobs/{id}/figures` | The figure blocks of the staged page records (`figureId`, `page`, `bbox`, `kind`, `caption`, `description`, `assetId`) and the `sourceSha256`; crops render on demand via `POST /v2/render` |
| `POST /v2/jobs/{id}/pause` | Hold a queued or running job |
| `POST /v2/jobs/{id}/resume` | Re-queue a paused job; optional body `{ resumePolicy, restartStage }` |
| `POST /v2/jobs/{id}/cancel` | Abandon a non-terminal job |
| `POST /v2/jobs/{id}/retry-failed` | Re-queue only the failed units |
| `POST /v2/jobs/{id}/reparse` | Re-apply the parser to persisted raw model responses, with no new model calls |

`GET /v2/jobs` and `GET /v2/jobs/{id}/figures` need `extract.admin`. `GET /v2/jobs/{id}`
needs `extract.admin`, or `extract.ingest` when the caller created the job: jobs record their
originator (`created_by_subject`, `created_by_tenant`, schema migration 3), and a job of
another subject or tenant answers with the same 404 as an unknown id. Jobs created before
the migration carry no owner and stay admin-only. Everything else needs `extract.ingest`.
`/ui/jobs` serves the same
router to the operator console through the session cookie; its writes additionally pass
the CSRF guard and require `UI_OPERATOR_GROUP`. `/ui/uploads` does the same for
`/v2/uploads` (every method CSRF-guarded, operator and `extract.ingest`), and `/ui/render`
serves `/v2/render` for the page preview (CSRF-guarded, `extract.admin`, `RENDER_RATE_LIMIT`).
A job read also reports `sourceSha256`, `sourceFilename`, `collection`, `visibility`,
`resumePolicy` and `priority`.

### Identity and deletion: `/v1/whoami`, `/v2/documents/{reference}`

`GET /v1/whoami` needs only a valid token and reports the authenticated principal
(`subject`, `tenantId`, `source`, `issuer`, `audience`, `scopes`), the service version, the
`features` flags (`ingest`, `resumableUploads`, `deleteByReference`, `ownJobRead`) and
`limits.maxUploadBytes`. Clients such as the Extract Outpost use it to verify a connection.

`DELETE /v2/documents/{reference}` (header `X-Collection`) needs the scope `extract.delete`;
without it the call is a 403 before any job or Search call. It cancels active jobs of the
same reference and collection, then removes the document from Search. `200
{status: "deleted", reference, collection, deleted}` when Search removed chunks, `404
NOT_FOUND` otherwise (also for never-existing references), `400` for an invalid collection
and `502` when Search fails. Deletions are counted in `extract_documents_deleted_total`.

A job moves through `queued → preparing → processing → emitting → committing → completed`,
or ends `failed` / `cancelled`. `paused` carries a reason: `budget` (the `tokenBudget`
would be exceeded by the next call, estimated with `VISION_TOKEN_ESTIMATE`), `dependency`
(vision, text LLM or Search stayed unreachable for `JOB_MAX_TRANSIENT_WAIT_MS`; resumes
automatically on recovery) or `manual`. Illegal transitions are a 409.

Workers claim jobs from `extract.jobs` under a lease (`JOB_LEASE_SECONDS`) renewed on a
heartbeat (`JOB_HEARTBEAT_INTERVAL_MS`). Every write is fenced on the lease epoch, and
every operator action revokes the lease, so a partitioned worker can neither overwrite a
job another worker took over nor keep spending model calls after a cancel. Stages are
checkpointed, so a resume continues at the first unfinished unit. Creation freezes the
config and the pipeline/prompt hash onto the job; when they differ on resume,
`resumePolicy` decides: `pin`, `continue` or `restart-stage`. Jobs above
`LARGE_JOB_PAGE_THRESHOLD` pages run in a separate lane capped at
`LARGE_JOB_MAX_CONCURRENCY` across the fleet, so small uploads do not wait days behind a
large plan.

**Readers.** A job's ACL (`X-Allowed-Users/-Groups` on `/v1/ingest`, `allowedUsers/-Groups`
on `/v2/jobs`) is narrowed to the caller's own identity — a caller can restrict, never widen —
and sent with the revision, so Search writes it onto every unit; assets are readable only
through those units. E-mail attachments inherit their e-mail's ACL.

The emitter streams staged pages to Search's revision API in batches of
`EMIT_BATCH_PAGES`, commits a segment every `SEGMENT_PAGES` pages, uploads assets with
`ASSET_UPLOAD_CONCURRENCY` and reconciles against the revision state on resume, so nothing
is sent twice or lost. It needs `SEARCH_URL`; without it a job is processed but nothing is
emitted.

### Duplicates, versions and e-mail threads

Before any work a job asks Search which document its source is
(`POST /v2/sources/identify`), in two cheap phases:

1. **Source phase** (file hash only, before the source is prepared). A document is
   identified by its reference **without file extension**: `handbuch.docx` resolves to an
   indexed `handbuch.pdf`, the job is re-pointed at that reference and becomes a new
   revision of it. The same file bytes anywhere in the collection end the job at once.
2. **Content phase** (after preparing, before any model call). The text layer is read in
   one `pdftotext` call and fingerprinted: a sha256 of the normalised text (whitespace,
   hyphenation, soft hyphens, ligatures, case, punctuation and page numbers folded away) and
   a 64-slot MinHash over 4-word shingles. The same text anywhere in the collection is a
   duplicate; a near-identical text (`DEDUP_NEAR_THRESHOLD` in Search) of the same document
   is a duplicate when the versions match — or are unknown and the texts nearly identical —
   and a new version otherwise.

A duplicate job completes without extracting anything; the job carries `duplicateOf`, the
warning names the indexed source, and Search keeps it as an additional source of that
document (`GET /v2/documents/{ref}/sources`). `dedup: exact` skips only identical
files/texts, `off` never skips. Without Search, or when Search rejects the request, the job
ingests as before.

**Version.** Without an explicit `version` it is read from the first page: a label
("Version 2.1", "Rev. C", "Fassung 3", "v1.4.2"), else a labelled date ("Stand:
12.03.2024", "Revision date: March 4, 2025"), else an unambiguous date near the top; when
the patterns find nothing and a text LLM is configured (`SUMMARY_URL`) it reads the page;
last comes `sourceModifiedAt`. A scan's version is read from its transcribed first page.
The version travels on `document.begin` (contract 2.1); Search only makes a newer version
the latest.

**E-mail.** An `.eml` becomes one page per message. `document.begin.email` carries
Message-ID, In-Reply-To, References and Outlook's Thread-Index root, so Search threads
messages ingested in any order, by independent calls. Each attachment in a supported
format is stored and queued as a job of its own under `<e-mail reference>/<file name>`,
with the e-mail as `parentReference` and its date as version fallback; the same PDF
forwarded five times is indexed once. `/v1/ingest` takes the same inputs as `X-Version`,
`X-Source-Modified` and `X-Dedup`, and answers a duplicate with `status: skipped`.

**Embedded objects.** A DOCX's `word/embeddings/` — OOXML packages (Excel, Visio, Word,
PowerPoint), OLE package objects (`\x01Ole10Native`, e.g. a `.bpmn` or `.pdf`), OOXML inside OLE
(`Package`) and legacy DOC/XLS storages — are queued as child jobs under
`<document reference>/<file name>` with the document as `parentReference`, so each is read by
its native parser instead of only as the preview picture on the page.

**Paragraphs over a page break.** The document pass reads page N+1's staged base record while
folding page N; a paragraph or list that continues gets `continues` and `continuationText` (the
continuation's first sentence) and the next page's first block `continuationOf`. The decision is
deterministic, so a resume makes the same one.

### On-demand render: `/v2/render`

`POST /v2/render` with `{ source, page, bbox?, targetPixels?, filename? }` renders a page,
or a normalised `[x0,y0,x1,y1]` region of it, from the stored source and returns a PNG.
Full-resolution images are never pre-stored; Search calls this route for zoom and caches
the result as an asset variant. Output is clamped to `RENDER_MAX_PIXELS`, the route has
its own `RENDER_RATE_LIMIT` and needs `extract.admin`. It does not require the database.

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
service issue a request to a caller-chosen address. The controls
(`src/handlers/callback.ts`):

- Only http(s), no credentials in the URL.
- Link-local and metadata addresses (`169.254.0.0/16`, IPv6 `fe80:`, their
  IPv4-mapped forms, `metadata.google.internal`) are refused unconditionally.
- **Without `CALLBACK_ALLOWED_HOSTS`, only public addresses are reachable.** Every
  resolved A/AAAA address must be public unicast; private, loopback, CGNAT, ULA,
  multicast and IPv4-embedded forms of those are refused. An IP literal is rejected
  with a 400 at request time, a DNS name at delivery time (terminal, not retried).
  An internal orchestrator therefore has to be listed.
- **With `CALLBACK_ALLOWED_HOSTS`**, the host must match an entry (`.example.com`
  matches subdomains). An allowlisted host may resolve to private space, never to a
  link-local or metadata address.
- The connection is pinned to the validated address, so a second DNS answer (DNS
  rebinding) cannot redirect it; TLS still verifies the host name. Every retry
  resolves and validates again.

The production readiness gate flags an empty `CALLBACK_ALLOWED_HOSTS`, because
callbacks could then target any public host and internal receivers are refused.
The v2 `source_url` pull reuses these controls with a stricter rule (see
[Sources](#sources-v2uploads)).

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
- **`/v1/*` and `/v2/*` accept only machine credentials, `/ui/*` only the session cookie.**
  A cookie authenticating an API call turns a CSRF into a document upload; a
  bearer token authenticating the UI makes the UI credential a full programmatic
  one.
- **The ingest ACL can only narrow.** `X-Allowed-Users` / `X-Allowed-Groups` are
  intersected with the caller's own identity, never passed through.
- **ZIP containers are checked before they are unpacked.** XLSX, VSDX, DOCX, PPTX and
  OOXML packages embedded in a DOCX must pass the `ZIP_MAX_*` limits, read from the
  central directory alone; a violation is `DOCUMENT_TOO_COMPLEX` (422), never retried.
- **XML entities are not expanded.** Every XML parser is built in
  `src/pipeline/safe-xml.ts` with entity processing off (XXE, Billion Laughs); only the
  five predefined entities are decoded.
- **Native parsers run in a Worker thread** with a heap ceiling (`PARSE_ISOLATED`,
  `PARSE_MEMORY_LIMIT_MB`), so a pathological document fails its parse instead of the
  service. If the Worker cannot start, a forked child and then an in-process call with a
  warning take over.
- **LibreOffice runs with a hardened profile.** Macros are disabled, links from untrusted
  locations are blocked and linked content is never updated on load.
- **Converter binaries can run in a separate process.** With `CONVERTER_MODE=isolated`
  every poppler/LibreOffice/Tesseract call goes as newline-delimited JSON over the Unix
  socket `CONVERTER_SOCKET` to `node dist/converter/server.js`, intended for a container
  without network, with a read-only root filesystem and a non-root user. Only the command
  line and its output cross the socket; documents stay on a scratch volume that both
  processes mount at the same path (`TEMP_DIR`). The socket has no authentication of its
  own: only the two processes may be able to reach its directory.

`checkProductionReadiness` refuses to start in production with any of the
permissive development defaults. Run with `NODE_ENV=development` to accept them
explicitly; the same findings are then printed as warnings, so the list is
visible before a config is promoted.

## Configuration

Full reference: [`docs/CONFIGURATION.md`](../../docs/CONFIGURATION.md), generated
from `src/config.ts`; rollout order for the v2 variables:
[`docs/document-intelligence-v2-migration.md`](../../docs/document-intelligence-v2-migration.md). Only `VISION_URL` and `VISION_MODEL` are required. The ones
worth deciding deliberately:

| Variable | Default | Why it matters |
| --- | --- | --- |
| `RENDER_DPI` | 200 | Below it small table text stops being legible; above it image cost grows without better transcription |
| `FIGURE_DPI` | 300 | Must be ≥ `RENDER_DPI`; a crop coarser than the model's input is never wanted |
| `VISION_MAX_TOKEN_VARIANTS` | 8192,16384,32768 | The truncation escalation ladder |
| `MAX_PAGES` | 500 | Tokens are spent per page; the ceiling ships on (0 = unlimited) |
| `VISION_BUDGET_PAGES_PER_DAY` | 0 (unlimited) | Caps a tenant's VLM pages per UTC day across all its jobs; over the cap the job fails with `BUDGET_EXCEEDED` |
| `CONVERT_CONCURRENCY` | 2 | Each conversion holds a LibreOffice process and page buffers |
| `PAGE_CONCURRENCY` | 4 | Pages of one document in flight against the model |
| `QUEUE_MAX_DEPTH` | 32 | Beyond it uploads get 503 with `Retry-After`, which a caller can act on |
| `CALLBACK_ALLOWED_HOSTS` | (empty) | Empty allows public hosts only; list internal receivers explicitly |
| `SUBPROCESS_TIMEOUT_MS` | 120000 | Turns a hung poppler/LibreOffice call into a warning or retryable failure; 0 disables, which the production gate refuses |
| `SUBPROCESS_MEMORY_LIMIT_MB` | 0 (off) | `prlimit --as` per converter call on Linux; in a container use the cgroup memory limit instead |
| `SUBPROCESS_CPU_LIMIT_S` | 900 | `prlimit --cpu` per converter call on Linux, SIGKILL on breach; 0 disables |
| `UPLOAD_MEMORY_THRESHOLD_BYTES` | 8388608 | Larger multipart uploads are spooled to `TEMP_DIR/uploads` instead of the heap; 0 spools every upload |
| `VISION_SUPPORTS_JSON_SCHEMA` | false | Sends `response_format: json_schema`; a provider that rejects it falls back to the tag format |

Hardening against hostile documents (see [Security](#security)):

| Variable | Default | Why it matters |
| --- | --- | --- |
| `ZIP_MAX_ENTRIES` | 10000 | Entry count a ZIP-based container may declare |
| `ZIP_MAX_TOTAL_BYTES` | 536870912 | Sum of declared uncompressed sizes (512 MiB) |
| `ZIP_MAX_ENTRY_BYTES` | 209715200 | Largest declared uncompressed entry (200 MiB) |
| `ZIP_MAX_RATIO` | 100 | Largest compression ratio of one deflated entry |
| `MAX_EMBED_DEPTH` | 2 | Nesting depth of embedded `.msg` messages; deeper ones are skipped with a warning |
| `PARSE_ISOLATED` | true | Native parsers run in a Worker thread with a heap ceiling |
| `PARSE_MEMORY_LIMIT_MB` | 512 | Heap ceiling of that thread (enforced by Node, ignored by Bun); a breach fails with `DOCUMENT_TOO_COMPLEX` |
| `CONVERTER_MODE` | local | `isolated` forwards every poppler/LibreOffice/Tesseract call to a separate converter process |
| `CONVERTER_SOCKET` | `/run/atf-converter/converter.sock` | Unix socket of that converter; both processes need the directory |
| `OCR_FALLBACK` | off | `tesseract` gives a scanned page OCR text (with a page warning) while the vision model is down |
| `TESSERACT_BIN` | tesseract | Binary for the OCR fallback; not part of `deploy/examples/Dockerfile` |
| `OCR_LANG` | deu | Tesseract language(s), e.g. `deu+eng`; the traineddata must be installed |

The v2 groups. Worker, lane, emitter and source-store values are validated at startup even
without a database, so a bad value fails early:

| Variable | Default | Why it matters |
| --- | --- | --- |
| **Database** | | |
| `EXTRACT_DATABASE_URL` | (unset) | Enables v2 uploads, jobs and the job worker; schema `extract`. Unset keeps the service database-free |
| `EXTRACT_DB_POOL_MAX` | 10 | Pooled connections (1–128) |
| `EXTRACT_DB_STATEMENT_TIMEOUT_MS` | 30000 | Per-query ceiling; 0 disables |
| **Job worker** | | |
| `JOB_LEASE_SECONDS` | 60 | Lease before another worker may take a job over (5–3600) |
| `JOB_HEARTBEAT_INTERVAL_MS` | 20000 | Must stay well below the lease |
| `JOB_POLL_INTERVAL_MS` | 2000 | Wait after an empty queue poll |
| `JOB_MAX_TRANSIENT_WAIT_MS` | 900000 | Dependency outage tolerated before `paused(reason=dependency)` |
| `VISION_TOKEN_ESTIMATE` | 4096 | Per-page estimate the budget guard checks before a vision call |
| **Source store and uploads** | | |
| `SOURCE_STORE_DIR` | `${TEMP_DIR}/sources` | Content-addressed sources; use a persistent, shared volume |
| `UPLOAD_TMP_DIR` | `${TEMP_DIR}/uploads` | In-progress upload scratch; persistent, since resumable offsets live in Postgres |
| `SOURCE_URL_ALLOWED_HOSTS` | (empty) | `source_url` allowlist; the gate flags it empty once the database is on |
| `SOURCE_URL_MAX_BYTES` | 2147483648 | Largest pulled source (2 GiB) |
| `SOURCE_URL_TIMEOUT_MS` | 300000 | Per-attempt pull timeout |
| **Large-job lane** | | |
| `LARGE_JOB_PAGE_THRESHOLD` | 1000 | Jobs with more pages run in the large lane |
| `LARGE_JOB_MAX_CONCURRENCY` | 1 | Large jobs leased fleet-wide at once |
| **Emitter** | | |
| `EMIT_BATCH_PAGES` | 20 | Pages per NDJSON batch to Search; bounds emitter memory |
| `SEGMENT_PAGES` | 250 | Pages between segment commits (what `progressive` visibility exposes early); also the inline limit of the v2 `/v1/ingest` wrapper |
| `ASSET_UPLOAD_CONCURRENCY` | 4 | Parallel crop/page uploads to Search (1–64) |
| `FINALIZE_PASS` | true | Model-free outline correction at document end; Search re-embeds only units whose section path changed |
| **Figure Pass 2** | | |
| `FIGURE_PASS2_KINDS` | `bpmn,flowchart,ui_mask,technical_drawing,chart,table_image` | Figure kinds that get a structured second transcription |
| `FIGURE_PASS2_MIN_AREA` | 0.02 | Smallest figure (fraction of page area) worth a Pass-2 call |
| `LABEL_COVERAGE_MIN` | 60 | Percent of figure labels the transcription must contain; below it a warning and one retry |
| **Tiling (large-format pages)** | | |
| `TILE_TARGET_PIXELS` | 2000 | Long edge a tile is rendered towards; drives tile count and DPI |
| `TILE_OVERLAP_FRACTION` | 0.1 | Overlap between adjacent tiles (0–0.5) |
| `TILE_MAX_PER_PAGE` | 16 | Ceiling on tiles per page, a budget guard |
| **Text fast path** | | |
| `TEXT_FAST_PATH` | true | Text-only pages with usable bbox geometry skip the vision call |
| `TEXT_FAST_PATH_MAX_INK_RATIO` | 0.04 | Max ink outside text blocks; above it the page goes to vision |
| **On-demand render** | | |
| `RENDER_MAX_PIXELS` | 40000000 | Pixel ceiling of a `/v2/render` response |
| `RENDER_RATE_LIMIT` | 240 | Requests/min/IP for `/v2/render`; 0 disables |
| **Summary text LLM (optional)** | | |
| `SUMMARY_URL` | (unset) | Full chat-completions URL, used as-is. Unset skips the summary hierarchy |
| `SUMMARY_MODEL` | (unset) | Required when `SUMMARY_URL` is set |
| `SUMMARY_API_KEY` | (unset) | Optional bearer credential |
| `SUMMARY_TIMEOUT_MS` | 120000 | 0 disables |
| `SUMMARY_TEMPERATURE` | 0.1 | |
| `SUMMARY_MAX_TOKENS` | 512 | Output budget per summary |
| `SUMMARY_MAX_RETRIES` | 3 | |
| `SUMMARY_REASONING_EFFORT` | (unset) | Forwarded as `chat_template_kwargs` only when set |

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
