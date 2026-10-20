# @atf/extract-contract

The document-extraction output contract. One normative definition of what a
converted document looks like, shared by the producer (`@atf/extract`) and every
consumer (`@atf/search`, runtime flows).

The package ships **two majors**:

- **v2** (`atf-extract/2.4.0`) — the default export. An NDJSON stream of
  zod-validated records (`document.begin`, `page`, `document.end`) with a typed
  block model, structured figure transcriptions, multi-kind asset references,
  the ingest/job API types, an NDJSON codec, `validateRecord`, and a
  `renderMarkdown` view. Import from `@atf/extract-contract`. Minor versions are
  additive: 2.1 adds `version`, `email` and `parentReference` to `document.begin`
  and the document-key / version-ordering rules (`documentKeyOf`,
  `compareDocumentVersions`); 2.2 adds the caller's document attributes (`title`,
  `tags`, `metadata`, `link`, `sourceLabel`) to the job request and
  `document.begin`, plus the `whoami` and `deleteDocument` response types and the
  `NOT_FOUND`/`FORBIDDEN` error shapes; 2.3 adds `continues`, `continuationOf` and
  `continuationText` to paragraph and list blocks; 2.4 makes `pages` on the job request
  a contiguous window (`"N"`, `"A-B"`, `"A-"`, `"-B"`, source page numbers) and adds
  the optional `firstPage` to `document.begin` and `document.end` (`pageCount` is then the
  stream's last page).
- **v1** (`atf-extract/1.1.0`) — the legacy Markdown marker grammar, kept for
  existing corpora. Import from `@atf/extract-contract/v1`. Everything below the
  "The grammar" heading documents v1.

Gate on the **major** version only; minor versions are additive by construction.

## v2 — the record stream

Where v1 shipped a Markdown body with in-band markers, v2 ships records:

```
document.begin   identity, source, pipeline
page             one per page (sent batched): typed blocks, furniture, assets,
                 fidelity — see the block model in design.md §4.2
document.end     outline, identifier index, summary hierarchy, refs, usage
```

Markdown is no longer the transport; `renderMarkdown(records, options)` derives
a reading view in which each figure renders **inline at its reading position**
as a `<figure>` element carrying its kind/page/asset, caption, summary and its
transcription rendered as a table or list.

Asset identity is unchanged from v1 for figures — `assetId = sha256(NFC(reference)
+ "\n" + NFC(localId))` with `localId = figureId` — so re-extracting an existing
corpus keeps every uploaded crop valid. v2 additionally addresses page images
(`page:p37`), tiles (`tile:p37-f1-r2c3`) and native source files (`native:…`).

```ts
import {
  encodeRecords, decodeRecordStream, validateRecord, renderMarkdown,
  buildAssetId, pageLocalId, type ExtractRecord,
} from "@atf/extract-contract";
```

Version 1.1 (v1) adds optional document timing fields (`timeToFirstPageMs`,
`avgVisionMsPerPage`, `perPageVisionMs`) and optional progress telemetry
(`total`, cumulative token counts, ETA, elapsed time and page timing). A 1.0
consumer remains compatible because all additions are optional and the
canonical Markdown grammar is unchanged. Timing values describe pipeline work,
not serialization or network-delivery latency.

## Why a contract package

Extraction output crosses a service boundary, and per `DEVELOPMENT.md` anything
that does belongs in a versioned `packages/` package rather than being
re-implemented on each side. Before this package existed, the same grammar was
implied by three independent places that disagreed with each other — two
producers and the consumer:

| Concern | Producer A | Producer B | Consumer (`apps/search`) |
| --- | --- | --- | --- |
| Page markers | none — pages joined with `---` only | `## Seite N` | expects `## Seite\|Page N` |
| Figures | none | `<figure id=0, bbox=[…]>` | expects `<figure id= bbox=>` |
| Figure ids | — | per-page, restarting at `0` | renames duplicates → asset binding breaks |
| bbox meaning | — | prompt says `[x1,y1,x2,y2]`, cropper reads `[x,y,w,h]` | four numbers, no semantics |
| Summary | none | `<summary>` | consumed as embedded summary |

The consequence was silent in both directions: Producer A's output indexed with
no page numbers and no figures at all, and Producer B's figure crops were
geometrically wrong unless the figure happened to start at the page origin.
Neither failure showed up in the conversion output.

## The grammar

A document is a sequence of pages joined by `\n\n---\n\n`. Each page:

```markdown
## Seite 1

<summary>Was die Seite enthält, in einem Absatz.</summary>

<figures>
<figure id="p1-f1" bbox="[0.1204, 0.3388, 0.4810, 0.7204]" page="1">Ablaufdiagramm der Inbetriebnahme: Gerät auspacken, Sichtkontrolle, Entscheidungspunkt "Beschädigt?", Reklamation oder Montage.</figure>
</figures>

# Einleitung

Vor der ersten Inbetriebnahme ist das Gerät auszupacken …

![figure_p1-f1]

<table>
  <tr><th rowspan="2">Merkmal</th><th>Einheit</th></tr>
  <tr><th>Bereich</th></tr>
  <tr><td>Länge</td><td>mm</td></tr>
</table>
```

### Block order is load-bearing

`## Seite N` → `<summary>` → `<figures>` → body. Search derives a figure's page
from the nearest **preceding** page marker, so the figures block must come before
the body. Otherwise a page whose body is a single full-page diagram — the case
where the figure matters most — attributes its figure to the previous page.

### Page markers

`## Seite <n>` or `## Page <n>` on its own line, 1-based. `Seite` is the default
because existing corpora and the upstream prompts are German; re-labelling would
make old and new ingests inconsistent. Both are accepted on parse.

Search turns these into `page_start` / `page_end` on every chunk, which is what
makes a retrieved passage citable.

### Figures

```
<figure id="<id>" bbox="[x1, y1, x2, y2]" page="<n>">description</figure>
```

- **`id`** is `p<page>-f<ordinal>`, both 1-based, and **globally unique within the
  document**. Uniqueness is not cosmetic: asset ids are derived from the figure
  id, and Search silently suffixes duplicates (`0`, `0-2`, `0-3`), which breaks
  the binding between an uploaded crop and the chunk that references it. Ids are
  restricted to `[a-zA-Z0-9._-]` and must not start with `figure_`, because
  Search rewrites both.
- **`bbox`** is `[x1, y1, x2, y2]`, **normalised to `[0,1]`**, origin top-left,
  four decimals. Normalised rather than pixels so geometry survives re-rendering
  the page at a different DPI. Corners are ordered and clamped by
  `normalizeBoundingBox`; a box with no area is a validation error, because that
  is a real extraction failure rather than rounding.
- **`description`** is self-contained prose. It is the *only* retrievable text
  for a figure, so for a diagram it must name the steps and decision points —
  someone reading only the description has to understand the figure without
  seeing it.
- **`![figure_<id>]`** in the body marks the reading-order position. Search
  strips it; direct renderers need it.

### Summary

`<summary>…</summary>`, one per page. Search concatenates all of them into the
document's embedded summary, so ingest sets `X-Summary-Mode: embedded` and does
not pay to regenerate what the extractor already produced from the *rendered*
page rather than from text alone.

### Tables

HTML `<table>` in the body, not Markdown pipe tables. Merged cells survive that
way, and Search's `normalizeHtmlTables` expands `rowspan`/`colspan` into a
rectangular Markdown table at ingest time. Emitting pipe tables directly would
throw the merge information away before Search ever sees it.

### No metadata in the body

Search indexes whatever it does not recognise as structure, so a
`<!-- version -->` comment or a `<pagemeta>` tag becomes retrievable text.
Provenance therefore travels only:

- on the wire as the `contract` envelope field and the `X-Extract-Contract`
  response header,
- into Search as `metadata.extract_*` via the `X-Metadata` header.

## Asset identity

```
assetId = sha256(reference.normalize("NFC") + "\n" + figureId.normalize("NFC"))
```

Derived from identity, not from image bytes, which makes the upload idempotent
and order-independent: an asset upload may run before or after the document that
references it (v1 used `PUT /document-assets/:assetId`, removed in 0.18.0; v2
uploads assets through the job pipeline and reads them at `GET /v2/assets/{id}`),
and re-rendering a figure at a higher DPI overwrites the same row instead of
orphaning the old one. NFC normalisation matters because a filename
with a composed vs. decomposed umlaut would otherwise hash differently depending
on the filesystem that produced it.

`buildDocumentAssetId` is duplicated in
`apps/search/src/document-structure.ts` — Search must recompute it to validate an
upload. `test/asset-id.test.ts` pins the expected digests so a divergence on
either side fails loudly instead of producing 400s in production.

## API

```ts
import {
  EXTRACT_CONTRACT_ID, isCompatibleContract,
  serializeDocument, serializePage,
  parseDocument,
  validateDocument, assertValidDocument,
  buildIngestHeaders, buildAssetHeaders, assetPath,
  buildDocumentAssetId,
  buildFigureId, normalizeBoundingBox, boundingBoxToPixels,
  parseConvertResponse,
} from "@atf/extract-contract";
```

Producing a document:

```ts
const markdown = serializeDocument(document);
assertValidDocument(document);

await fetch(`${searchUrl}/ingest`, {
  method: "POST",
  headers: { ...buildIngestHeaders(document, { collection: "specs" }), authorization },
  body: markdown,
});

for (const figure of collectFigures(document)) {
  await fetch(`${searchUrl}${assetPath(figure)}`, {
    method: "PUT",
    headers: { ...buildAssetHeaders(document, figure), authorization },
    body: crops.get(figure.id),
  });
}
```

Re-reading a document that only survived as Markdown:

```ts
const parsed = parseDocument(markdown, reference);
// parsed.pages[i].figures[j].assetId is recomputed from the reference
```

`parseDocument` never throws. A hand-edited or truncated document is still worth
indexing partially, so anything it cannot place lands in `parsed.warnings`.

## Validation severity

`validateDocument` returns issues, not a boolean, and severity is a judgement
about indexability:

- **`error`** — the document would be indexed *incorrectly*: duplicate figure id,
  stale `assetId`, page marker inside a body, residual `<figure>`/`<summary>`,
  degenerate bbox, NUL bytes, page count mismatch.
- **`warning`** — indexed correctly but with something missing: a page that
  produced neither text nor figures, an empty figure description.

## Tests

```
bun run --filter @atf/extract-contract test
```

Round-trip (`serialize` → `parse` → compare) is the only mechanical proof that
the serializer and the grammar agree, and it is a property test rather than a
fixture test because the interesting failures come from content that happens to
contain marker-like text.
