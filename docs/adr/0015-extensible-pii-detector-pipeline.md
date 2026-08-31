# 15. Extensible PII Detector Pipeline

Date: 2026-07-16

## Status

Accepted

## Context

The reversible PII tokenization vault (ADR-0007) tokenizes personally
identifiable information in outbound prompts before any LLM provider sees the
raw data. Detection relies entirely on the regex-based `findPiiMatches`
function in `output-guardrails.ts` — deterministic patterns with check-digit
validation (Luhn for cards, ISO 7064 MOD 11,10 for tax IDs, date plausibility
for social-insurance numbers).

This covers *structured* PII: emails, IBANs, credit-card numbers, tax IDs,
phone numbers, secrets/tokens. It fundamentally **cannot** cover
*unstructured*, context-dependent PII:

- Person names ("Herr Müller", "Anna Schmidt")
- Postal addresses / street names
- Organization names used as identifiers
- Ambiguous dates in free text that refer to a person

For a regulated debt-collection / B2B-compliance platform handling German
personal data, the recall gap for names and addresses is material. At the same
time, regex remains the optimal tool for structured patterns — it is fast,
deterministic, check-digit-auditable, and has zero external dependencies.

We needed a design that:

1. Adds NER-based detection (names, addresses) without replacing regex.
2. Keeps detection composable per flow — not every flow needs the latency of
   NER inference or a network call.
3. Allows operators to plug in external detection services (Presidio, spaCy,
   AWS Comprehend, Google DLP) without code changes.
4. Preserves backward compatibility — existing deployments without the new
   config continue to work identically.
5. Does not introduce latency into the streaming output guardrail path.

## Decision

Implement PII detection as an **extensible detector pipeline** (registry of
`PiiDetector` implementations) rather than three mutually exclusive modes.

### Architecture

```
                  ┌────────────────┐
  text ──────────►│ PiiDetector    │
                  │   Registry     │
                  ├────────────────┤
                  │ ┌────────────┐ │
                  │ │  Regex     │ │  priority=10 (deterministic, auditable)
                  │ │  Detector  │ │
                  │ └────────────┘ │
                  │ ┌────────────┐ │
                  │ │  BERT-NER  │ │  priority=20 (in-process ONNX, probabilistic)
                  │ │  Detector  │ │
                  │ └────────────┘ │
                  │ ┌────────────┐ │
                  │ │  Remote    │ │  priority=30 (HTTP, external service)
                  │ │  Detector  │ │
                  │ └────────────┘ │
                  └───────┬────────┘
                          │ merge (priority-based overlap resolution)
                          ▼
                  PiiMatch[] with provenance
```

### Key design decisions

1. **Detectors are composable, not exclusive.** The `PiiDetectorRegistry` runs
   all registered detectors concurrently and merges their spans. A deployment
   can run `regex` alone, `regex+ner`, or `regex+ner+remote`.

2. **Priority-based overlap resolution.** When spans from different detectors
   overlap, the detector with the lower priority number (higher trust) wins.
   Regex (priority 10) beats NER (20) beats remote (30) — because a
   check-digit-validated match is more trustworthy than a statistical one.

3. **Async at ingress only.** NER inference and remote HTTP calls are async.
   The pipeline runs at **vault ingress** (`PiiVault.tokenize` — full message
   text, one call per turn) and on non-streaming output paths. The
   **streaming output guardrail** (`GuardrailStream.push` → `redactText`)
   remains synchronous and regex-only. This is architecturally correct: the
   vault's purpose is hiding PII from the *provider*; if the vault already
   tokenized names at ingress, the streaming egress does not need to detect
   them again (it only re-substitutes tokens).

4. **Per-flow detector AND type selection** via `guardrails.yaml`, resolved at
   request time by a `PiiDetectorResolver` that the vault consults with the flow
   id. The resolver returns a **plan** — which detectors to run (`detectors`)
   AND which PII types to tokenize (`piiTypes`) — both scoped to the flow:
   ```yaml
   - flow: helpdesk
     detectors: [regex, ner]        # regulated: add NER for names/addresses
     piiTypes: [email, iban, person, location]  # narrow what THIS flow tokenizes
   - flow: userstory
     detectors: []                  # explicit empty → disable vault tokenization
   - flow: "*"
     # (no `detectors`/`piiTypes` key) → inherit global PII_DETECTORS / PII_VAULT_TYPES
   ```
   Resolution for a flow: an explicit per-flow `detectors` list wins (including
   `[]`, which yields a zero-detector registry that tokenizes nothing); absent
   that, the global `PII_DETECTORS` set applies; absent that too, the vault uses
   its legacy sync regex-only path. Independently, an explicit per-flow
   `piiTypes` list narrows which types that flow tokenizes (overriding
   `PII_VAULT_TYPES`); absent, the global type subset applies. Unknown type
   names are dropped. Note `piiTypes` here scopes the **vault** and is distinct
   from the nested `output.piiTypes` / `egress.piiTypes` which scope those
   guardrails. Built registries are memoised per detector-set and invalidated
   when the guardrail policy hot-reloads (tracked via
   `GuardrailPolicyService.generation()`).

   **Wiring note (bootstrap ordering).** The vault is constructed in
   `bootstrap/persistence.ts`, before the guardrail policy exists. Persistence
   therefore exposes a `PiiDetectorFactory` (names → registry); the composition
   root (`index.ts`) builds the `FlowPiiDetectorResolver` once the guardrail
   policy is ready and injects it via `piiVault.setDetectorResolver(...)` — the
   same late-binding pattern used for `setToolAuthzEngine`. The flow id is
   threaded from `withPiiVault`'s `executeFlow` through `tokenize`.

5. **Fail mode is explicit and configurable.** A detector signals failure by
   **throwing** (a load failure, inference error, HTTP error, or open circuit);
   returning an empty array means "ran, found nothing". The registry
   distinguishes the two via `Promise.allSettled`. `PII_DETECTOR_FAIL_MODE`:
   - `open` (default): skip the failed detector(s), proceed with the remaining
     results (availability over coverage).
   - `closed`: throw `PiiDetectionError` so the vault **refuses to forward
     un-tokenized text** to the provider — the request fails instead
     (coverage over availability). This is the correct fail-closed behaviour for
     a privacy control: on `closed`, a detector outage blocks the request rather
     than leaking raw PII. Note this applies even to benign messages, so it is
     opt-in per deployment/flow.

6. **Each match carries provenance** (`detector` field on `PiiMatchWithProvenance`)
   for audit/compliance trails — which detector (and implicitly which model
   version / rule set) produced the finding. This is **persisted and consumed**:
   - **Persisted** per entry: the `pii_vault_entries` table gains a nullable
     `detector` column (migration 22); the vault records it on every tokenized
     span (the legacy regex-only path tags entries `"regex"`). Because entries
     are released as soon as a run finishes, this column is per-run audit data,
     not a durable aggregate.
   - **Consumed as a runtime metric**: the vault emits
     `aiperator_pii_vault_tokens_total{detector,type}` on every tokenized span
     (via a late-bound `PiiVaultMetrics` sink), giving a durable, scrapable
     per-detector activity time series that outlives the ephemeral entries.
   - **Consumed as compliance evidence**: the EU AI Act / GDPR dossier
     (`src/compliance/dossier.ts`) gains a **PII vault posture** section —
     durable configuration evidence (enabled, durable-at-rest, active detectors,
     covered PII types) that an auditor can cite alongside the runtime metric.

7. **BERT-NER runs in-process** via `@huggingface/transformers` (transformers.js
   v3, ONNX Runtime) to avoid a Python sidecar dependency. The older
   `@xenova/transformers` was rejected: it pins `onnxruntime-web@1.14 →
   onnx-proto → protobufjs@6`, which carries known CVEs (critical/high) that
   fail `bun audit`; the v3 successor drops that chain (audit clean). It is a
   **declared dependency**. Its native components install platform-specific prebuilt binaries. A clean `bun install --frozen-lockfile` and the standalone NER smoke command must be validated on each supported deployment platform. The dynamic `import()` remains guarded so a load
   failure (missing native binary, unsupported platform) degrades gracefully —
   the detector throws → the registry fail-mode applies. The model **must be an
   ONNX build** (transformers.js cannot load raw PyTorch weights): the default
   `Xenova/bert-base-multilingual-cased-ner-hrl` (config key `PII_NER_MODEL`) is
   the ONNX conversion of Davlan's model and covers German + English with a
   single model — preferred over per-language models (no language detection on
   the hot path, handles code-switched text). Lazy-loaded on first detection
   call.

   **transformers.js token-classification is a raw per-token stream** — it emits
   BIO tags (`B-PER`/`I-PER`/`B-LOC`) with `start`/`end` = `null` and does not
   aggregate multi-token entities. The detector therefore aggregates
   consecutive `B-`/`I-` tokens of the same type (plus `##` subword
   continuations) into whole entities and **reconstructs character offsets** by
   locating each entity's words in the source text (forward cursor scan);
   entities that cannot be located are dropped rather than emitted with a bogus
   span. This logic is a pure, unit-tested function (`nerTokensToMatches`).

8. **Remote detector is a thin REST client** with timeout + circuit breaker.
   Contract is language-agnostic JSON POST/response. Trust boundary: the raw
   text is sent to this service — must be an operator-controlled, in-cluster
   service, never a third-party internet endpoint.

9. **Backward compatible.** When `PII_DETECTORS` is unset, no registry is
   built and the vault falls through to the existing sync `tokenizeText`
   (regex-only) path. Existing tests and deployments are unaffected.

### New PII types (NER-only)

The NER detector introduces entity types that regex cannot cover:

| PiiType        | Source     | Description                     |
|----------------|------------|---------------------------------|
| `person`       | NER/Remote | Person names (PER entity)       |
| `location`     | NER/Remote | Addresses, places (LOC entity)  |
| `organization` | NER/Remote | Organization names (ORG entity) |

These are added to the `PiiType` union in `output-guardrails.ts` and can be
used in `PII_VAULT_TYPES` / `piiTypes` per-flow config.

### Configuration (env)

| Variable                   | Default                                       | Description                                              |
|----------------------------|-----------------------------------------------|----------------------------------------------------------|
| `PII_DETECTORS`            | *(unset — legacy regex path)*                 | Comma-separated: `regex`, `ner`, `remote`                |
| `PII_NER_MODEL`            | `Xenova/bert-base-multilingual-cased-ner-hrl` | ONNX model ID (HF hub) or local path                     |
| `PII_NER_CONFIDENCE`       | `0.75`                                        | Minimum NER entity score (0–1)                           |
| `PII_NER_CACHE_DIR`        | *(transformers.js default)*                   | Model cache directory                                    |
| `PII_REMOTE_ENDPOINT`      | *(required when "remote" in PII_DETECTORS)*   | Base URL of remote PII detection service                 |
| `PII_REMOTE_API_KEY`       | *(optional)*                                  | Bearer token for remote service                          |
| `PII_REMOTE_TIMEOUT_MS`    | `3000`                                        | Per-request timeout                                      |
| `PII_REMOTE_LANGUAGE`      | `de`                                          | Language hint sent to remote service                     |
| `PII_DETECTOR_FAIL_MODE`   | `open`                                        | `open` (skip failures) or `closed` (fail detection)      |
| `PII_DETECTOR_TIMEOUT_MS`  | `5000`                                        | Per-detector timeout in registry                         |

### Remote service contract

```
POST <PII_REMOTE_ENDPOINT>
Content-Type: application/json
Authorization: Bearer <PII_REMOTE_API_KEY>  (if set)

{ "text": "...", "language": "de", "types": ["person","email",...] }

→ 200
{ "matches": [{ "type": "person", "value": "...", "start": 0, "end": 5 }] }
```

Any service implementing this shape works: Presidio, spaCy wrapper, AWS
Comprehend adapter, Google DLP adapter.

## Consequences

### Positive

- Names and addresses are now detectable before reaching the LLM provider —
  closes the material recall gap for German personal data.
- Operators can choose the right cost/latency/recall trade-off per flow.
- No Python runtime dependency for NER (in-process ONNX).
- Fully backward compatible — zero behavioral change for existing deployments.
- Provenance on every match enables compliance reporting per-detector and
  per-model-version.
- Remote service contract is generic — no vendor lock-in.

### Negative / risks

- NER is non-deterministic: false positives (a word misclassified as a name)
  and false negatives (a name missed). Mitigation: regex always runs alongside
  as the deterministic baseline; NER only adds recall for types regex cannot
  cover.
- ONNX model adds ~200–400 MB memory per replica once loaded. Mitigation:
  lazy-loading (only loads on first use when "ner" is in PII_DETECTORS).
- Remote detector sends raw text over the network. Mitigation: MUST be an
  in-cluster service (documented as requirement); trust boundary is identical
  to the LLM provider call itself.
- `PII_DETECTOR_FAIL_MODE=open` means a silently failing NER model degrades
  to regex-only without alerting. Mitigation: logger.warn on every failure;
  circuit breaker state is observable; operators can set `closed` for
  regulated flows.

### Files changed

| File                                        | Change                                                 |
|---------------------------------------------|--------------------------------------------------------|
| `src/graph/pii-detector.ts`                 | New: PiiDetector interface, registry, merge logic      |
| `src/graph/pii-detector-regex.ts`           | New: RegexPiiDetector wrapping findPiiMatches          |
| `src/graph/pii-detector-ner.ts`             | New: BertNerDetector (ONNX/transformers.js)            |
| `src/graph/pii-detector-remote.ts`          | New: RemotePiiDetector (REST + circuit breaker)        |
| `src/graph/pii-vault.ts`                    | Extended: per-flow `detectorResolver` + `setDetectorResolver`, `flowId` on `tokenize`, provenance on entries, fail-closed propagation |
| `src/graph/pii-vault-engine.ts`             | Extended: threads `flowId` into `tokenize`             |
| `src/graph/output-guardrails.ts`            | Extended: PiiType union + ALL_PII_TYPES                |
| `src/graph/guardrail-policy.ts`             | Extended: `detectors` field on rule schema             |
| `src/config/schema.ts`                      | Extended: new env vars in AppConfig + EnvSchema        |
| `src/config/load.ts`                        | Extended: mapping new env vars to AppConfig            |
| `src/bootstrap/persistence.ts`              | Extended: `buildPiiDetectorFactory`, exposes `piiDetectorFactory` |
| `src/index.ts`                              | Builds `FlowPiiDetectorResolver`, injects via `setDetectorResolver` + `setMetrics` |
| `src/db/migrations.ts`                      | Migration 22: `pii_vault_entries.detector` column      |
| `src/routes/pii-vault.ts`                   | Status endpoint reports active detectors               |
| `src/graph/pii-vault.ts`                    | `PiiVaultMetrics` sink + `aiperator_pii_vault_tokens_total` metric |
| `src/compliance/dossier.ts`                 | `PiiVaultPosture` evidence section                     |
| `src/routes/compliance.ts`                  | Passes PII vault posture into the dossier              |
| `package.json`                              | `@huggingface/transformers` dependency and `smoke:ner` script             |
| Deployment-owned flow examples             | Optional detector selection; no production flow is shipped here         |
| `src/graph/__tests__/pii-detector.test.ts`  | New: registry / resolver / remote detector tests       |
| `scripts/ner-smoke.ts`                      | New: standalone real-inference NER validation (`bun run --filter @atf/runtime smoke:ner`) |

## Testing

Unit tests cover the registry (merge, overlap, fail-open/closed, timeout), the
per-flow resolver, the remote adapter (mocked fetch, circuit breaker, untrusted
offset validation), the NER token→span logic (`nerTokensToMatches`: BIO
aggregation, `##` subwords, confidence, offset reconstruction, unlocatable-drop),
and the vault integration (per-flow selection, provenance metric, fail-closed
propagation). Real-model NER inference is validated by a standalone script
(`bun run --filter @atf/runtime smoke:ner`) rather than a `bun test` file: transformers.js v3's native
`onnxruntime-node` backend crashes Bun's test runner (a bun-test + native-addon
issue), though it runs fine in the plain runtime that serves production.

## Related

- ADR-0007: Reversible PII tokenization vault (the layer this extends)
- ADR-0003: Safe condition evaluator (similar composable-evaluator pattern)
- ADR-0009: Compliance policy-as-code (the dossier now carries a PII vault
  posture section fed by this pipeline's detector configuration + provenance)
