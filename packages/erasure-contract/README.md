# @atf/erasure-contract

Cross-service erasure (DSAR) contract: the request, per-store result, response
and the signed `Erasure_Receipt` payload shared by the runtime orchestrator and
every store that must forget (`search`, `extract`, `gate`).

## Endpoints

All endpoints use service auth with scope `*.erasure` and are idempotent over
`requestId` — a repeated request returns the original result instead of
erasing twice.

| Service | Endpoint | Effect |
| ------- | ----------------------- | ---------------------------------------------------------------------------- |
| Search | `POST /v1/erasure` | Document cascade + `vs_search_stats` + ledger |
| Extract | `POST /v1/erasure` | Jobs, uploads, page images, persistence, then Search cascade |
| Gate | `POST /v1/erasure` | Redaction / deletion in the persistent audit sink (non append-only) |

## Store results

`ErasureStoreResult.status` is `ok`, `failed` or `not_configured`.
`not_configured` is a *deliberate* state: the orchestrator still reports
overall success, so a service without an optional store does not fail every
DSAR. Overall status is `complete` only when every store is `ok` or
`not_configured`.

## Receipts

`ErasureReceiptPayloadSchema` is the signed payload. It never contains subject
data in cleartext — only `sha256(tenantId + "|" + identifier)` via
`erasureSubjectHash()`. The byte source for signing is
`canonicalizeJson(payload)` (recursively sorted keys, no whitespace). Signing
is Ed25519 (`ERASURE_RECEIPT_SIGNING_KEY`) with the audit-anchor HMAC as
documented fallback; the algorithm lives in the envelope, not the payload.

## Usage

```ts
import { ErasureRequestSchema, erasureSubjectHash } from "@atf/erasure-contract";

const req = ErasureRequestSchema.parse(body);
const hash = erasureSubjectHash(req.tenantId, req.subject?.userId ?? "");
```
