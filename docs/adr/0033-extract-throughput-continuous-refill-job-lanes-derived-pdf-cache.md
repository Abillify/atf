<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# 33. Extract throughput: continuous page refill, parallel job lanes, derived-PDF cache

Date: 2026-10-20

## Status

Accepted

## Context

The Extract v2 pipeline (content-addressed `SourceStore` → Postgres queue →
`drivePages` page scheduler → per-page stages → emitter) had three
independent throughput ceilings, all confirmed against the code before this
ADR:

- **The page scheduler advanced in lockstep batches.** `drivePages` claimed
  a batch of `PAGE_CONCURRENCY` pages, awaited **all** of them, then claimed
  the next batch. One slow page — an OCR-heavy scan, a rate-limited vision
  call — idled every other slot for the whole batch. With
  `PAGE_CONCURRENCY` default 4, a job's throughput was set by its slowest
  page in every group of four, and the gap grew with concurrency.
- **One job per worker process.** `WorkerConfig` had no job-level
  concurrency: `loop()` claimed a single job, processed it to completion,
  and only then polled again. A deployment that wanted parallel jobs needed
  one container per job, each paying full startup, connection-pool, and
  converter-sidecar overhead.
- **Every run re-derived the same PDF.** `prepare()` copied the source
  bytes from the `SourceStore` into the per-run work directory even for PDF
  sources (poppler only reads), and an office conversion (`soffice`) ran
  from scratch on every run — including job retries after a transient
  failure and re-ingestion of a file whose sha256 was already converted.
  LibreOffice startup plus conversion is seconds per document, repeated
  needlessly.

The strict page-order emission contract (documented in `events.ts`: page
events must reach Search in ascending page number) constrains the first
fix: refilling slots out of completion order must not reorder the event
stream.

## Decision

1. **`drivePages` refills continuously behind an ordered publish buffer.**
   The scheduler keeps an `inFlight` map (page → promise) and a `settled`
   map (page → result or error). Whenever a slot frees, it claims only the
   number of free slots (`nextRunnablePages`, client-side filtered against
   `inFlight`, `settled`, and a local backoff map) and starts pages
   immediately. A publish loop emits the smallest settled page only when no
   in-flight page has a smaller number, so the event stream stays in
   ascending page order regardless of completion order (a page that failed
   transiently is consumed as settled and does not hold back later pages;
   if it succeeds on a retry its event follows its successors on the in-process
   bus; the emitter drains the staged outbox by page range, `emitBatchesInRange`);
   cumulative `usage` totals
   accumulate at publish time, not at completion time, so per-event totals
   match the ordered stream. Early outcomes are honored in page order: the
   ordered prefix is flushed first, then in-flight pages are drained
   (`allSettled`, results discarded) before the run returns
   paused/failed/lease-lost. A `LeaseLostError` aborts the run's signal and
   is rethrown in page order. Pages that failed without a persisted retry
   timestamp get a per-page `untrackedBackoff` entry so the claim loop
   cannot hot-spin on them.

2. **`JOB_CONCURRENCY` (default 1, range 1–32) gives a worker parallel job
   lanes.** `loop()` maintains a set of lanes; while below the limit it
   claims the next job (same `claimNextJob` SQL, so the large-job lane cap
   `LARGE_JOB_MAX_CONCURRENCY` stays fleet-wide) and runs `processJob`
   concurrently. When no job is claimable and lanes are busy, the loop waits
   on the first lane completion or the poll interval, whichever comes
   first — it never busy-polls while jobs are running. `stop()` sets
   `running = false` and resolves only after every lane drains, so a
   graceful shutdown never abandons a claimed lease mid-job. `tick()` is
   unchanged and still processes exactly one job, keeping the test seam and
   any single-shot callers intact. The default of 1 preserves the previous
   one-job-per-process behaviour byte-for-byte.

3. **`DERIVED_PDF_CACHE` (default true) reuses derived PDFs across runs
   under `TEMP_DIR`.** Two derivations are cached. (a) A PDF source whose
   content-addressed store file lives under the scratch root is rendered
   **in place** — the per-run copy is skipped entirely (poppler only reads;
   `close()` removes only the per-run work directory, never the store
   file). A store outside the scratch root, or the cache disabled, falls
   back to the old copy. (b) A LibreOffice conversion is published once to
   `TEMP_DIR/derived-pdf/<sha256>-<h>.pdf`, where `h` is the first 16 hex
   digits of `sha256(extension ‖ NUL ‖ soffice-identity)` (an HTML source
   additionally carries the sanitizer revision, so a hardening change never
   serves a PDF rendered from the old rewrite); the identity is
   `soffice --version` probed through the configured exec transport and
   remembered once it succeeded. While the probe fails there is no safe key,
   so the conversion runs uncached rather than under a constant `"unknown"`
   key. The conversion still runs
   in the per-run work directory and is published with an atomic
   `link(2)`; `EEXIST` means a concurrent run won and its file is used.
   The key includes the converter identity so a LibreOffice upgrade
   invalidates old conversions automatically.

4. **Both knobs default to the previous behaviour's cost profile, not its
   shape.** `JOB_CONCURRENCY` defaults to 1 (sequential, as before).
   `DERIVED_PDF_CACHE` defaults to true because the cache is content- and
   converter-version-keyed and lives under the same `TEMP_DIR` lifecycle;
   setting it to `false` restores copying and per-run conversion exactly.
   **Retention.** "The same `TEMP_DIR` lifecycle" is only a bounded lifecycle
   when `TEMP_DIR` is an `emptyDir`/tmpfs that disappears with the pod. The
   cache holds the full content of converted documents, has no size or age
   limit, and is not reached by document deletion or subject erasure; on a
   persistent `TEMP_DIR` (which `CONVERTER_MODE=isolated` shares with the
   sidecar) the operator needs a cleanup job and a place for it in the erasure
   procedure (`docs/UPGRADE.md`, "0.18 → next"). A size/TTL eviction and an
   erasure hook are not implemented.
   Under `CONVERTER_MODE=isolated` the cache still works because the
   scratch directory is mounted at an identical absolute path in both the
   service and the converter sidecar (ADR 0028).

## Consequences

- A job's page throughput is set by `PAGE_CONCURRENCY` sustained, not by
  its slowest page per batch: a single 60-second OCR page no longer idles
  the other slots while pages behind it could already be running. Peak
  in-flight stays ≤ `PAGE_CONCURRENCY` (pinned by a test).
- The ordered publish buffer adds one data-structure cost inside the
  scheduler and keeps the emission contract testable: page events and
  cumulative usage totals are asserted to arrive in ascending page order
  even when a later page finishes first.
- One Extract container can now ingest several jobs in parallel
  (`JOB_CONCURRENCY > 1`) without extra pods; memory and converter-sidecar
  capacity become the binding constraint instead, and the large-job lane
  cap still bounds how many huge jobs run fleet-wide.
- Re-ingesting an unchanged office document converts once, ever (per
  converter version); job retries after transient failures reuse the
  conversion. PDF sources lose their per-run copy entirely when the store
  is under the scratch root.
- `TEMP_DIR/derived-pdf` grows across converter versions and is **not**
  garbage-collected by this change — it inherits whatever lifecycle
  `TEMP_DIR` has in the deployment. A cache eviction policy is a follow-up
  operational item, not part of this decision.
- The cache is a pure performance layer: disabling it or running with
  `JOB_CONCURRENCY=1` reproduces pre-Phase-11 behaviour, so a deployment
  can bisect any regression through configuration alone.
