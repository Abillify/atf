<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# 32. Propagating Search content-trust labels into execution taint

Date: 2026-10-23

## Status

Accepted

## Context

Indirect prompt injection travels with the documents: text that tries to steer
the model is ingested by Extract, indexed by Search, forwarded by the Gate's
MCP proxy and finally read by the Runtime's LLM nodes. ATF defends against it
at two independent places. Search runs a cheap deterministic scan over the
stored text at query time (`content-trust.ts`: German and English override
phrases, chat-template tokens, concealment and exfiltration patterns) and
labels every response `content_trust: "untrusted"` plus an `injection_risk`
hint. The Runtime runs its own regex scan on tool output
(`tool-output-validator.ts`) and, on a finding, neutralises the payload and
taints the execution (`execution-taint.ts`) so subsequent write tools need
human approval.

The two signal lists deliberately diverge — Search scans German phrasing and
chat-template tokens the Runtime's list does not carry — so a payload Search
flags can pass the Runtime's own scan unnoticed. That only works out if
Search's verdict actually reaches the Runtime, and it did not: the taint
signal broke in three places along the chain.

- **Search** labelled `search`, but the document-read tools
  (`get_document`, `get_thread`, `get_documents`, `get_summary`,
  `get_summaries`) and the navigation reads (`get_section`, `get_pages`,
  `get_context`, `get_table`, `follow_ref`) returned the stored text with no
  label at all. A caller reading a flagged document through these tools saw
  the same unlabelled JSON as one reading a clean document.
- **Runtime** dropped the labels it did receive: `parseVectorSearchResults`
  mapped search hits into `RagChunk` field by field and silently discarded
  `injection_risk` / `content_trust`, so even a labelled `search` response
  produced unlabelled chunks. Nothing in the graph consulted a Search label —
  taint was driven exclusively by the Runtime's own validator.
- **Gate** forwards MCP tool text byte-for-byte (which is correct), but
  nothing pinned that contract, so a future "helpful" transformation in the
  proxy (re-serialisation, trimming, envelope rewriting) would have severed
  the chain without a failing test.

A residual stays open by design: Extract does not scan at ingest time. Search
scans at query time over the returned text, which covers every read path; an
ingest-time scan would additionally catch payloads that never round-trip into
a response, and is recorded as a follow-up in the threat model rather than
solved here.

## Decision

1. **Search labels every document-read response.** The catalog reads
   (`get_document`, `get_documents`, `get_thread`, `get_summary`,
   `get_summaries`) spread `trustLabels(text)` into each per-item object and
   `responseTrustLabels(texts)` into the response envelope (worst hit wins);
   the navigation reads (`get_section`, `get_pages`, `get_context`,
   `get_table`, `follow_ref`) carry the envelope label computed from the
   returned unit texts. Pure metadata reads (`get_outline`, `list_figures`,
   `find_identifier`) stay unlabelled — they return no document body. The
   label is computed at query time from the text actually returned, so
   truncation and paging can never label content the caller did not receive.

2. **The Runtime parses the labels into `RagChunk`.**
   `parseVectorSearchResults` accepts `injection_risk` (only `none` /
   `suspected`; anything else yields no label rather than a wrong one) and
   `content_trust` per hit, falling back to the response envelope. Absent
   labels keep the chunk object byte-identical to before (conditional
   spreads), so every consumer that compares chunks is unaffected.

3. **A Search `suspected` label taints the run like a local finding.**
   `markTaintFromSearchLabels` (`injection-findings.ts`) scans a tool payload
   for `injection_risk: "suspected"` anywhere in it — envelope, per-item, or
   nested inside the MCP text-wrapper JSON string (depth-capped at 12,
   fail-safe to "no taint" on parse failure or depth exhaustion) — and on a
   hit calls `taint.mark(sourceRef)`, emits the node diagnostic
   `indirect_prompt_injection`, and records
   `aiperator_indirect_injection_total{source="search_label"}`. It is wired
   at both tool-execution paths (the graph tool node and the agent-loop tool
   setup) *before* validator redaction, so the scan sees the payload as
   Search produced it. The payload itself is never modified: unlike a
   validator finding, a Search label is a pure trust signal, not a content
   rewrite. The consequence is identical — the run is tainted and write
   tools require approval — because the divergence of the two signal lists
   is exactly the reason to trust the other side's verdict.

4. **The Gate's passthrough is a tested contract.** A regression test drives
   the real `McpProxyToolExecutor` (only the SDK wire call stubbed) and pins
   that labelled text is forwarded byte-identical, multi-part text keeps its
   order, `structuredContent` passes through untouched, and unlabelled
   responses gain no invented labels.

## Consequences

- A German-phrase injection that Search flags and the Runtime's regex list
  misses now taints the execution end to end; the approval gate on write
  tools fires on Search's verdict alone.
- The taint can now be raised by content the Runtime's own scan rates
  harmless. That is intended (fail towards more taint) but makes
  `aiperator_indirect_injection_total{source="search_label"}` the metric to
  watch when triaging unexpected approval prompts.
- Every document-read response grows two small fields; consumers that
  deep-compare tool JSON must tolerate them (none in this repo do — the
  existing strict comparisons are on unlabelled fixtures).
- The label scan is heuristic on both sides and bounded (20 000 scanned
  chars in Search, depth 12 in the Runtime bridge). A payload crafted to sit
  below both bounds still passes; spotlighting and approval remain the
  backstop.
- Extract-side ingest scanning stays an open threat-model item: a document
  can sit in the index unscanned until a read surfaces it. The read-path
  label closes the exploitable window (content only matters when it reaches
  a prompt); ingest scanning would add defense-in-depth and a chance to
  reject at the boundary.
