<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Metrics and retention

One reference for two operational questions: what each service exports on its
`/metrics` endpoint, and where data is kept, for how long, and under which
setting. Metric meanings come from the registration code; every retention
default below was confirmed in the source. See
[CONFIGURATION.md](CONFIGURATION.md) for the full variable reference and
[runbooks/backup-restore.md](runbooks/backup-restore.md) for what to back up.

## Metrics

Prometheus format. Counters only ever increase; gauges reflect the current
value; histograms expose `_bucket`, `_count` and `_sum` series per metric.

"Suggested alert" lists only the metrics worth alerting on out of the box;
`—` means no default alert recommendation.

| Metric | Service | Type | Meaning | Suggested alert |
| --- | --- | --- | --- | --- |
| aiperator_requests_total | runtime | counter | Total HTTP/API requests by route and status. | — |
| aiperator_request_duration_ms | runtime | histogram | Request duration in milliseconds by route. | — |
| aiperator_node_executions_total | runtime | counter | Total workflow-node executions by flow, node, and status. | — |
| aiperator_node_errors_total | runtime | counter | Total workflow-node execution errors. | — |
| aiperator_node_latency_ms | runtime | histogram | Workflow-node latency in milliseconds. | — |
| aiperator_llm_calls_total | runtime | counter | Total LLM calls by provider, model, and status. | — |
| aiperator_llm_errors_total | runtime | counter | Total failed LLM calls by provider and model. | — |
| aiperator_llm_tokens_total | runtime | counter | LLM prompt, cached-prompt, and completion tokens. | — |
| aiperator_llm_cost_total | runtime | counter | Accumulated LLM cost by provider and model. | — |
| aiperator_llm_retries_total | runtime | counter | Total LLM retries by provider and model. | — |
| aiperator_llm_fallbacks_total | runtime | counter | Total LLM fallback events by provider and model. | — |
| aiperator_requests_rejected_total | runtime | counter | Requests rejected by reason. | — |
| aiperator_response_cache_total | runtime | counter | Response-cache hits and misses by result. | — |
| aiperator_guardrail_redactions_total | runtime | counter | Guardrail redactions by finding type. | — |
| aiperator_active_executions | runtime | gauge | Number of currently active executions. | — |
| aiperator_queue_depth | runtime | gauge | Current execution queue depth. | warn when steadily increasing |
| aiperator_flow_load_failures | runtime | gauge | Number of flow files currently failing to load. | warn when > 0 |
| aiperator_groundedness_total | runtime | counter | Groundedness-gate outcomes by result. | — |
| aiperator_approvals_total | runtime | counter | Approval-gate decisions by decision. | — |
| aiperator_audit_write_failures_total | runtime | counter | Audit-log write failures. | — |
| aiperator_degraded_total | runtime | counter | Degraded or fail-open component events. | — |
| aiperator_history_compaction_skipped | runtime | counter | History compaction attempts skipped. | — |
| aiperator_history_compaction_total | runtime | counter | History compaction operations. | — |
| aiperator_history_dedupe_total | runtime | counter | History deduplication operations. | — |
| aiperator_image_offload_bytes_total | runtime | counter | Total image bytes offloaded. | — |
| aiperator_image_offload_total | runtime | counter | Total image offload operations. | — |
| aiperator_indirect_injection_total | runtime | counter | Indirect prompt-injection findings. | — |
| aiperator_input_guardrail_model_total | runtime | counter | Input-guardrail model invocations. | — |
| aiperator_input_guardrail_model_degraded_total | runtime | counter | Input-guardrail model degraded events. | — |
| aiperator_input_guardrail_model_chunked_total | runtime | counter | Input-guardrail model chunked-processing events. | — |
| aiperator_input_guardrail_total | runtime | counter | Input-guardrail outcomes. | — |
| aiperator_llm_output_limit_aborted_total | runtime | counter | LLM outputs aborted because of output limits. | — |
| aiperator_llm_repetition_aborted_total | runtime | counter | LLM outputs aborted because of repetition. | — |
| aiperator_llm_structured_empty_retry_total | runtime | counter | Structured-output retries caused by empty responses. | — |
| aiperator_llm_structured_salvaged_total | runtime | counter | Structured outputs successfully salvaged. | — |
| aiperator_llm_structured_unparsable_total | runtime | counter | Structured outputs that could not be parsed. | — |
| aiperator_objective_solver_total | runtime | counter | Objective-solver events by outcome. | — |
| aiperator_pii_vault_tokens_total | runtime | counter | PII tokens stored in the vault. | — |
| aiperator_policy_stale_total | runtime | counter | Stale-policy detections. | — |
| aiperator_prompt_prefix_chars_total | runtime | counter | Characters processed in prompt prefixes. | — |
| aiperator_prompt_prefix_observations_total | runtime | counter | Prompt-prefix observations. | — |
| aiperator_require_tool_use_total | runtime | counter | Require-tool-use policy outcomes. | — |
| aiperator_stream_fallback_total | runtime | counter | Streaming fallback events. | — |
| aiperator_taint_approvals_total | runtime | counter | Taint-related approval decisions. | — |
| aiperator_flow_slo_breach_total | runtime | counter | Flow service objectives that changed from met to breached, by flow and objective (`flow_id`, `objective`). Each replica counts its own. | warn when increasing |
| aiperator_cascade_escalations_total | runtime | counter | LLM answers regenerated by the stronger model of `config.cascade`, by flow and node. | — |
| aiperator_thread_history_reconciled_total | runtime | counter | Thread-history reconciliation operations. | — |
| aiperator_tool_egress_findings_total | runtime | counter | Tool-egress security findings. | — |
| aiperator_tool_loop_guard_total | runtime | counter | Tool-loop-guard events. | — |
| aiperator_tool_result_budget_total | runtime | counter | Tool-result budget events. | — |
| aiperator_tool_result_chars_saved_total | runtime | counter | Tool-result characters saved by reduction. | — |
| aiperator_tool_selection_total | runtime | counter | Tool-selection events by outcome. | — |
| aiperator_untrusted_source_total | runtime | counter | Untrusted-source detections. | info |
| mcpgate_connections_total | gate | counter | MCP sessions established. | — |
| mcpgate_disconnections_total | gate | counter | MCP sessions closed. | — |
| mcpgate_auth_failures_total | gate | counter | Failed authentication attempts. | — |
| mcpgate_errors_total | gate | counter | Tool or session errors. | — |
| mcpgate_llm_requests_total | gate | counter | LLM routing or interpretation requests. | — |
| mcpgate_tool_calls_total | gate | counter | Tool invocations by tool and status. | — |
| mcpgate_tool_duration_ms | gate | histogram | Tool execution duration in milliseconds. | — |
| vectorsearch_ingest_total | search | counter | Total ingest operations recorded since startup. | — |
| vectorsearch_search_total | search | counter | Total search operations recorded since startup. | — |
| vectorsearch_http_requests_total | search | counter | HTTP requests by route and status class. | — |
| vectorsearch_http_errors_total | search | counter | HTTP server errors by route. | — |
| vectorsearch_http_request_duration_seconds | search | histogram | HTTP request duration in seconds. | — |
| vectorsearch_batch_ticks_total | search | counter | Batch-worker ticks by outcome. | — |
| vectorsearch_batch_duration_seconds | search | histogram | Duration of non-idle batch-worker ticks. | — |
| vectorsearch_batch_units_total | search | counter | Retrieval units upserted by processed batches. | — |
| vectorsearch_batch_pending | search | gauge | Staged batches not yet processed. | — |
| vectorsearch_http_in_flight_requests | search | gauge | Requests currently in flight. | — |
| vectorsearch_nodejs_event_loop_lag_seconds | search | gauge | Mean Node.js event-loop lag. | — |
| vectorsearch_query_embedding_cache_entries | search | gauge | Current number of cached query embeddings. | — |
| vectorsearch_stats_flush_errors_total | search | counter | Failed statistics-flush attempts since startup. | — |
| vectorsearch_circuit_breaker_state | search | gauge | Circuit-breaker state per downstream service. | — |
| vectorsearch_circuit_breaker_failures | search | gauge | Consecutive failures per circuit breaker. | — |
| vectorsearch_process_uptime_seconds | search | gauge | Process uptime in seconds. | — |
| vectorsearch_nodejs_heap_used_bytes | search | gauge | V8 heap memory currently used. | — |
| vectorsearch_nodejs_heap_total_bytes | search | gauge | Total V8 heap memory allocated. | — |
| vectorsearch_nodejs_rss_bytes | search | gauge | Process resident-set memory usage. | — |
| extract_http_requests_total | extract | counter | HTTP requests by route and status class. | — |
| extract_http_errors_total | extract | counter | HTTP server errors by route. | — |
| extract_http_request_duration_seconds | extract | histogram | HTTP request duration in seconds. | — |
| extract_documents_total | extract | counter | Documents converted by source type and outcome. | — |
| extract_documents_deleted_total | extract | counter | Documents removed through the delete endpoint. | — |
| extract_pages_total | extract | counter | Pages converted by source type. | — |
| extract_page_duration_seconds | extract | histogram | End-to-end duration of one page. | — |
| extract_vision_requests_total | extract | counter | Vision-model requests. | — |
| extract_vision_failures_total | extract | counter | Vision requests that ultimately failed. | — |
| extract_vision_truncations_total | extract | counter | Vision responses truncated by the token budget. | — |
| extract_vision_tokens_total | extract | counter | Vision input and output tokens. | — |
| extract_figures_total | extract | counter | Figures processed by stage. | — |
| extract_text_fidelity_checks_total | extract | counter | Pages checked against model-produced text. | — |
| extract_text_fidelity_divergences_total | extract | counter | Pages flagged for excessive text-layer token loss. | — |
| extract_text_fidelity_missing_tokens_total | extract | counter | Risky tokens missing across flagged pages. | — |
| extract_pages_fast_path_total | extract | counter | Pages processed through fast-path or vision routes. | — |
| extract_queue_depth | extract | gauge | Conversions waiting for a processing slot. | — |
| extract_queue_active | extract | gauge | Conversions currently running. | — |
| extract_queue_rejected_total | extract | counter | Uploads rejected because the queue was full. | — |
| extract_emit_outbox_pending | extract | gauge | Emit-outbox rows awaiting Search acknowledgement. | — |
| extract_http_in_flight_requests | extract | gauge | Requests currently in flight. | — |
| extract_nodejs_event_loop_lag_seconds | extract | gauge | Mean Node.js event-loop lag. | — |
| extract_stage_duration_seconds | extract | histogram | Duration of one v2 pipeline-stage execution. | — |
| extract_stage_total | extract | counter | v2 pipeline-stage executions by stage and outcome. | — |
| extract_stage_tokens_total | extract | counter | Model tokens consumed by v2 pipeline stage. | — |

## Retention

Every location where ATF keeps data, what bounds it by default, and whether a
cross-service erasure ([adr/0025](adr/0025-cross-service-erasure.md)) removes
it.

| Data | Service | Where | Default retention | Setting | Deleted by erasure |
| --- | --- | --- | --- | --- | --- |
| Extract jobs (terminal) | extract | Job rows (persisted page responses and outboxes) | Forever (`0` = unlimited); finished jobs are swept `JOB_RETENTION_DAYS` after their last change | `JOB_RETENTION_DAYS` (Extract) | Yes |
| Upload sessions | extract | Resumable upload session and its `.part` file on disk | 72 h after the last chunk (`0` = forever) | `UPLOAD_SESSION_MAX_AGE_HOURS` (Extract) | Yes — the sessions of the erased jobs (matched through their references) |
| Derived PDFs | extract | Derived-PDF cache on disk | 168 h since last use and 2048 MB LRU ceiling (`0` = unlimited each) | `DERIVED_PDF_CACHE_MAX_AGE_HOURS`, `DERIVED_PDF_CACHE_MAX_MB` (Extract) | Yes |
| Source blobs | extract | Content-addressed source store | Until the document is deleted (`DELETE /v2/documents`) or an erasure removes the last job referencing the digest | — (no time-based retention) | Yes |
| Search revisions | search | Revision store | 1 209 600 s (14 days), swept hourly | `REVISION_TTL` (seconds), `REVISION_TTL_SWEEP_MS` (Search) | Yes |
| Search statistics | search | `vs_ingest_stats` / `vs_search_stats` tables | 90 days | `STATS_RETENTION_DAYS` (Search) | Yes — tenant scope removes all rows; subject scope only rows whose `query_hash` matches a subject identifier (stats carry no subject column) |
| Answer citations | runtime | `answer_citations` table (opt-in, `CITATION_INDEX_ENABLED`) | Until swept; no default age | `RETENTION_MAX_AGE_DAYS` (key `answer_citations`), `RETENTION_ENABLED` (Runtime) | Yes — rows of the subject's user ids; a subject without user ids erases the tenant |
| Semantic cache | runtime | `semantic_cache` table (with `DATABASE_URL`), else process memory | `SEMANTIC_CACHE_TTL_SECONDS` (300 s); expired entries swept every `SEMANTIC_CACHE_PURGE_INTERVAL_SECONDS` (300 s, minimum 30); with a database also by age through `RETENTION_MAX_AGE_DAYS` (key `semantic_cache`) | `SEMANTIC_CACHE_TTL_SECONDS`, `SEMANTIC_CACHE_PURGE_INTERVAL_SECONDS`, `RETENTION_MAX_AGE_DAYS` (Runtime) | Yes — per tenant and user, from every replica; entries written before user scoping are dropped on the first erasure |
| Runtime audit log | runtime | `audit_log` table | Append-only, never deleted or purged ([adr/0025](adr/0025-cross-service-erasure.md)) | — | No (append-only by design) |
| Erasure requests | runtime | `erasure_requests` table | Row kept; the `subject` is set to `NULL` once the erasure completes | — | n/a (the request record itself; subject redacted on completion) |
| Gate audit events | gate | JSONL audit file (`audit.file`) | No expiry — rotation is the operator's job (e.g. `logrotate`) | `audit.enabled`, `audit.file` (Gate) | Rewritten by erasure unless `appendOnly` commits it to retention |

Notes:

- The Extract retention sweep runs every `RETENTION_SWEEP_INTERVAL_MINUTES`
  (default 60) and covers jobs, upload sessions and the derived-PDF cache.
- Source bytes are explicitly **not** subject to `JOB_RETENTION_DAYS`; they
  leave only with a document delete or an erasure.
- The Runtime `RetentionService` additionally age-purges replay snapshots,
  execution history, long-term memory and the PII vault per
  `RETENTION_MAX_AGE_DAYS`; see [CAPABILITIES.md](CAPABILITIES.md) for those
  targets.
