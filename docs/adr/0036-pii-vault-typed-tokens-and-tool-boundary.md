# 36. Extend the PII vault past the model boundary: tool results, retrieved context, and stable tokens

Date: 2026-11-10

## Status

Accepted (2026-11-12). Steps 1–4 are implemented behind their flags: typed and consistent
placeholders on by default, tool-boundary detokenization (`PII_VAULT_DETOKENIZE_TOOLS`) and the
wider scope (`PII_VAULT_SCOPE=messages+context`) off by default.

## Context

ADR 0007 placed the reversible PII vault around `GraphEngineService` as a decorator, and
ADR 0015 made its detection pluggable. Both were written about the request path they cover:
inbound message text goes out tokenized, model output comes back detokenized. That design is
still correct for what it was scoped to.

Reading the code against the whole execution rather than the request path shows where its reach
ends, and the gap is not theoretical for a deployment that turns the vault on precisely because
personal data must not reach a provider:

- `withPiiVault` tokenizes `ChatMessage` content before `executeFlow` and detokenizes
  every `onChunk` delta and the final response. That is the entire integration
  (`apps/runtime/src/graph/pii-vault-engine.ts`).
- A tool call is built from model output, so its arguments already carry placeholders when the
  tool runs. `ticket_lookup(email="[[PII:3f9a1c2b8d4e6a77]]")` is what the tool actually
  receives — and what finds nothing in a real directory. Vault coverage and tool use therefore
  cancel each other out in practice.
- The result of that tool call is appended to the conversation as a `role: "tool"` message
  (`apps/runtime/src/graph/message-mapping.ts`) and re-enters the model context in plaintext. So
  does every chunk the `retrieval` node pulls from Search. Neither `agent-tools.ts` nor
  `handlers/retrieval.ts` references the vault; a grep for vault usage under `src/graph` returns
  `output-guardrails.ts`, `pii-vault.ts`, `pii-image-scanner.ts`, and `pii-vault-engine.ts` only.

The consequence is a control whose documentation has to say "retrieved content and tool output
reach the provider in plaintext" — accurate, but the opposite of why an operator enabled it.
That boundary is written into `docs/CAPABILITIES.md` now (see "Boundaries — what the vault covers
today") so the gap is at least visible.

Two smaller properties of the current token scheme matter for any widening of scope. Tokens are
minted per occurrence (`tokenizeText` in `apps/runtime/src/graph/pii-vault.ts`: "A distinct token
is minted for every occurrence, even a repeated value"), which is a deliberate safety property —
with no shared token, a mapping bug cannot conflate two subjects — but it also means the model
sees two mentions of one person as two unrelated entities, so coreference and answer quality
suffer. And a placeholder carries no type, so the model cannot tell an IBAN from a name.

Widening the scope interacts with three subsystems that read the same text before the model does:
the prompt-injection scan, citation registration, and the groundedness check
(`rag-grounding.ts`, `answer-sources-check.ts`, `groundedness.ts`). Tokenizing before those see
the text would either break citations or register placeholders as evidence. That ordering is the
hard part of this proposal, not the vault call itself.

## Decision

Proposed, in four independently shippable steps, each behind a flag that preserves today's
behaviour as the default. All four steps are implemented.

1. **Typed placeholders** — `[[PII:<TYPE>:<16 hex>]]`, with `TYPE` the uppercase `PiiType`.
   `TOKEN_PATTERN` accepts both formats so in-flight executions and stored answers keep
   detokenizing; the streaming window widens to the longest possible token while `safeCutIndex`
   keeps its no-token-split-across-deltas guarantee; `vaultAad` keeps binding `executionId` plus
   the 16-hex id and not the type. Flag `PII_VAULT_TYPED_TOKENS`, default on.
2. **One value, one token per execution** — a per-`executionId` map keyed by `type + "\0" + value`
   returns the existing token instead of minting a second one, capped so a pathological
   execution cannot grow it without bound, cleared in `release()`. Never shared across executions
   or tenants. This keeps the safety property that matters (no cross-tenant, cross-execution
   linkage) while restoring coreference inside a run. Flag `PII_VAULT_CONSISTENT_TOKENS`, default
   on.
3. **Detokenization at the tool boundary, per allowlist** — `PII_VAULT_DETOKENIZE_TOOLS` takes
   patterns in the same format `APPROVAL_REQUIRE_TOOLS` already parses. For a listed tool,
   placeholders inside string values of the arguments (recursively through objects and arrays) are
   replaced with real values immediately before `callTool`, through a narrow
   `{ detokenize(executionId, text) }` interface reached via the existing runtime context rather
   than new global state. The order at the boundary is fixed: required-parameter check → egress
   DLP on the model-supplied arguments → taint and approval check → **then** detokenization →
   `callTool`. Approval prompts, audit records, debug traces, and receipts keep seeing
   placeholders, never the detokenized values; those are the artifacts an auditor and sometimes a
   third party read, and moving plaintext into them would trade one leak for another. Default
   empty, i.e. today's behaviour.
4. **Tokenize tool results and retrieved content** — `PII_VAULT_SCOPE`: `messages` (default,
   today) or `messages+context`. In the wider scope, tool output and retrieval chunks are
   tokenized after the injection scan, citation registration, and groundedness check have taken
   their copy, and before the text enters the next model message. Entries belong to the same
   `executionId`, so response detokenization restores the values for the caller. Detection
   failure honours `PII_DETECTOR_FAIL_MODE=closed` the same way the message path does.

## Consequences

- **For operators:** with the flags at their defaults nothing changes; a deployment that needs
  "no plaintext leaves this system" can turn the wider scope on explicitly and know which extra
  paths that covers. `docs/CAPABILITIES.md` gets a "Tool boundary" entry and the Boundaries list
  shrinks accordingly, so this ADR must be updated together with that section rather than after it.
- **For privacy review:** step 2 stores plaintext values in process memory for the duration of an
  execution rather than only in the encrypted store. It is bounded by the execution and by the cap,
  never logged, never written to metrics — but it is a real change in the data-at-rest story and
  should be read as such, not as a performance tweak.
- **For answer quality:** steps 1 and 2 are expected to improve it (the model learns what kind of
  value a placeholder is, and that two mentions are one entity). Any claim about how much needs a
  measurement, not an estimate; the same applies to the added latency of step 4, to be reported per
  10 000 characters of context with the regex detector.
- **Risk that decides step 3:** detokenizing at the tool boundary hands real personal data to
  whatever the tool talks to, including an MCP server on another host. An allowlist makes that a
  per-tool operator decision, but it cannot make it safe — the list is the security boundary, and
  an empty default is the only defensible starting configuration.
- **Risk that decides step 4:** tokenizing retrieved content changes what citations point into.
  If groundedness and citation code cannot be made to work on plaintext copies cleanly, the
  correct outcome is to ship steps 1–3 and leave `messages` as the ceiling, rather than weaken
  grounding to move the vault boundary.
- **Not decided here:** whether tool results are scanned for injection before or after
  detokenization in a combined step-3-plus-step-4 configuration. That combination is out of scope
  until both flags exist independently.

## Implementation notes

- Typed tags are derived from `PiiType` in upper snake case (`creditCard` → `CREDIT_CARD`),
  at most 16 characters. The streaming window grew from 24 to 41 characters accordingly.
- Steps 1 and 2 default to **on**, unlike step 3: they change only what the model sees, never
  what leaves the Runtime, so the safer default for answer quality is to enable them.
  `PII_VAULT_TYPED_TOKENS=false` / `PII_VAULT_CONSISTENT_TOKENS=false` restore the old shape.
- Token ids are redrawn when they contain four or more consecutive digits. A digit run of seven
  or more is a phone number to the regex detector, and a second detection pass over tokenized
  text (tool output, trace redaction, the output guardrail) then cut a placeholder in half. The
  cost is roughly two of the 64 random bits.
- The consistent-token map is capped at 10 000 distinct values per execution; beyond that a
  value still gets a placeholder, just not a reusable one.
- The tool boundary is registered process-wide at bootstrap (`setPiiToolBoundary`, the same
  pattern as `getTransactionOrchestrator`), because the vault wraps the engine from the outside
  and the tool call sites have no reference to it. It runs after the effective-arguments trace
  and before the evidence contract, the transaction token and `callTool`, so the hashes that bind
  a call cover what is actually sent. The tool journal keeps the placeholder form.
- Metric: `aiperator_pii_vault_tool_detokenized_total{tool}` counts calls whose arguments got
  real values back.
- Step 4 (`PII_VAULT_SCOPE=messages+context`) tokenizes at three points, each after the
  injection scan, taint labels, citation registration and ref-handle masking have taken their
  copy: the value the LLM tool loop returns to the model (`agent-tools.ts`), the result of a
  `tool` node before it is stored and streamed (`handlers/tool.ts`), and the chunks a
  `retrieval` node injects plus its stored tool result (`handlers/retrieval.ts`). The
  groundedness gate scores the tokenized copy; with consistent placeholders the answer and its
  sources carry the same token for the same value, so lexical support still matches.
- Citations the `tool` node builds from a tokenized search result are restored before they are
  streamed to the caller (`PiiContextScope.restoreValue`), so the sources a user sees carry the
  real text. Tool-detail frames and the debug trace keep the placeholders.
- A detector failure under `PII_DETECTOR_FAIL_MODE=closed` throws at these points like on the
  message path: the tool call or retrieval fails instead of sending plaintext.
- Not covered: the `retrieval` node's first `onToolResult` frame and its node-I/O summary (ids,
  titles, scores — no chunk text in the summary, the chunk list in the tool frame) are emitted
  before tokenization. They go to the operator plane, not to the provider.
