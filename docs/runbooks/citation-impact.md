<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Runbook: Citation impact

Answers cite chunks of indexed documents. When a document is re-ingested, a cited
chunk can move to a newer revision or disappear — the answer may still read
correctly while its source no longer exists in the form it was quoted from. The
citation impact feature finds those answers: the Runtime records the cited chunks of
each execution (`answer_citations`), asks Search whether each pair is still current
(`POST /v2/citations/check`), and reports the executions whose sources changed or
were removed. The report is signed with the evidence key so it can be handed to an
auditor and verified offline.

## Setup

| Variable | Service | Value |
| --- | --- | --- |
| `CITATION_INDEX_ENABLED` | Runtime | `true` — writes the `answer_citations` index (needs `DATABASE_URL`); off by default |
| `DATABASE_URL` | Runtime | PostgreSQL; migration 50 creates the table |
| `CITATION_CHECK_URL` | Runtime | Base URL of the Search service, e.g. `http://search:3002` — enables `GET /monitoring/citation-impact` |
| `CITATION_CHECK_TOKEN` | Runtime | Search service token used as the bearer for the check call |
| `EVIDENCE_SIGNING_KEY` | Runtime | Ed25519 key; without it the report stays unsigned |

The index is opt-in and only records executions started after it is enabled; there
is no backfill. Rows hold references only (tenant, user, execution, flow,
`base_ref`, `chunk_id`, revision) — never answer or chunk text. Retention sweeps and
subject erasure cover the table (see `docs/DSFA-VORLAGE.md`).

## Regular run

The CLI runs the same report as the route and signals findings through its exit
code, which makes it the cron entry point:

```cron
# daily at 06:00, alarm when any answer's sources changed
0 6 * * * cd /opt/atf && bun run scripts/cli.ts citations impact --since 1d \
  --out /var/lib/atf/citation-impact/$(date +\%F).json || \
  /usr/local/bin/notify "citation impact: $(date +\%F) has affected answers"
```

Exit codes: `0` — no affected executions; `2` — at least one execution is affected;
`1` — usage or connection error. Add `--base-ref <ref>` to watch one document (for
example after a planned re-ingest), `--json` to print the raw report to stdout, and
`--server <url>` to query a running instance instead of the local configuration.

## Handling findings

1. Open the report (`--out` file, `GET /monitoring/citation-impact`, or the Control
   page). The summary counts executions checked and affected, plus a per-status
   breakdown (`current`, `carried`, `changed`, `removed`, `unknown`, `unverified`).
2. Work through the affected executions: each entry names the execution, flow and
   the chunks that are `changed` or `removed`. `carried` is not a finding — the
   content survives unchanged in the current revision. `unverified` is not a finding
   either, but it is not a clean result: the cited document has more than 5000 units, so
   Search could not compare its content. Check those sources by hand.
3. Decide per case: re-run the question against the current sources, correct or
   withdraw the answer where it was published, or accept it when the changed passage
   does not carry the claim.
4. To verify a handed-off report without the platform: `atf-verify
   --citation-impact <file> --jwks <url|file>` (add `--kid` when the JWKS holds
   several keys). `RESULT: VALID` means the signature matches the evidence key and
   the report is complete.

## Cross-tenant runs

A request without `tenant_id` covers every tenant and requires an admin actor on
the operator plane; the CLI passes the tenant of its configured credentials. Keep
`monitoring:read` restricted to operators — the report contains execution ids, user
ids and document references (see `docs/THREAT-MODEL.md`, Runtime).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Route answers 503 "citation check is not configured" | `CITATION_CHECK_URL` is unset — set it to the Search base URL |
| Route answers 503 about the citation index | `CITATION_INDEX_ENABLED` or `DATABASE_URL` missing — the report reads `answer_citations`, it cannot work without it |
| 502 `upstream_error` | Search unreachable or the token rejected — check `CITATION_CHECK_URL`/`CITATION_CHECK_TOKEN` and Search health |
| Report is unsigned | `EVIDENCE_SIGNING_KEY` not configured; `atf-verify` then refuses with "report is not signed" |
| Everything `unknown` | The check token cannot see the documents — Search reports `unknown` for pairs outside its ACL; use a token with the right scope |
