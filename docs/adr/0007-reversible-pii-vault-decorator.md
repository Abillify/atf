# 7. Reversible PII tokenization vault as a GraphEngineService decorator

Date: 2026-07-10

## Status

Accepted

## Context

The existing output guardrail (`src/graph/output-guardrails.ts`) redacts PII in
model *output* — a one-way `[REDACTED_EMAIL]` marker. That protects an end
user from seeing a leak in the response, but does nothing about the actual
exposure: the real value already went to the LLM provider in the *prompt*. A
provider that logs prompts, or a model that memorizes training-adjacent data,
has already seen the customer's email, IBAN, or phone number by the time the
guardrail runs.

We wanted a control that keeps PII out of the outbound request entirely,
without:

- touching every call site that reaches the graph engine (`routes/chat.ts`,
  `routes/chat/streaming.ts`, `routes/triggers.ts`, `graph/replay.ts`,
  `mcp/flow-mcp-server.ts`, the red-team executor, shadow mode) — six+
  independent entry points that all eventually call
  `GraphEngineService.executeFlow`;
- adding PII-awareness to any node handler (`llm.ts`, `tool.ts`, …), which
  would spread a cross-cutting concern into business logic;
- persisting plaintext PII anywhere outside an encrypted, short-lived vault.

## Decision

Implement the vault as a **decorator over `GraphEngineService`**
(`src/graph/pii-vault-engine.ts`, `withPiiVault(engine, vault)`), wired once at
bootstrap in `src/index.ts`:

```ts
const graphEngine = piiVault !== undefined
  ? withPiiVault(rawGraphEngine, piiVault)
  : rawGraphEngine;
```

Every downstream consumer keeps calling `graphEngine.executeFlow(...)`
completely unaware of the vault. The decorator:

1. **Ingress** — tokenizes every outbound `ChatMessage`'s text content
   (`tokenizeText()` in `src/graph/pii-vault.ts`) before delegating to the real
   engine. Each detected PII span becomes a fixed-width placeholder token
   (`[[PII:<16 hex chars>]]`) — a fresh token per *occurrence*, not per value,
   so a mapping bug cannot conflate two different subjects via a shared token.
2. **Storage** — the token→value mapping is encrypted at rest with
   `SecretCipher` (the same AES-256-GCM primitive as BYOK provider keys, see
   `src/graph/secret-cipher.ts`) and scoped to the single execution that
   created it (`pii_vault_entries` table, keyed by `execution_id`).
3. **Egress** — every streamed chunk the real engine emits passes through a
   `DetokenizeStream`, which restores the real values before the caller's
   `onChunk` sees them. Streaming-safe: a token split across two SSE chunks is
   still caught (`safeCutIndex()` walks back to an unclosed `[[PII:` prefix
   rather than using a naive fixed-width window, which — a real bug this
   design caught during testing — can still slice a token in half even with a
   large-enough buffer).
4. **Cleanup** — the vault's mapping for the execution is released
   (`vault.release(executionId)`) once the run finishes streaming or throws,
   via a `finally` block in the decorator. Nothing outlives the request that
   created it; a database-backed deployment also sweeps orphaned entries from
   a crashed run via the existing retention service (`pii_vault` target).

The vault is orthogonal to and composable with the output guardrail: the
guardrail is a backstop for PII the model *invents* in its response (which the
vault cannot have tokenized, since it never existed in the prompt); the vault
is the primary control preventing real user PII from reaching the provider at
all. A deployment can run either, both, or neither.

## Consequences

- Adding the killer feature required touching exactly one wiring line in
  `src/index.ts` plus two new files — no changes to any router, node handler,
  or the six+ independent call paths into the graph engine.
- The same decorator pattern is now available as a template for future
  cross-cutting request/response transforms that must apply uniformly across
  every entry point into `GraphEngineService` without becoming part of its
  interface.
- Vault entries are deliberately NOT queryable/auditable in bulk (no "list all
  PII ever tokenized" view) — they exist only for the duration of one request.
  Compliance evidence about the vault's *posture* (enabled, durable, which PII
  types) is exposed read-only via `GET /admin/pii-vault/status`
  (`src/routes/pii-vault.ts`), not usage metrics, since there is nothing
  meaningful to count beyond "a run in progress right now".
- A future streaming consumer added outside `GraphEngineService.executeFlow`
  (there are currently none) would bypass the vault entirely — this is an
  accepted risk of the decorator approach, mitigated by the fact that
  `executeFlow` is the single documented integration point for the engine
  (see `src/graph/graph-engine.ts`'s facade comment).
