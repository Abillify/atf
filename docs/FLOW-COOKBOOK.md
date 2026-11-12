<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Flow cookbook

Twelve patterns, one per recipe, each with the failure mode it prevents. [FLOWS.md](FLOWS.md)
is the reference — every field, bound and operator. This document is the other half: which
settings belong together, what a field does when the thing it depends on is missing, and why a
recipe is wired the way it is.

Every excerpt below is taken from a complete flow under
[`../deploy/examples/flows/cookbook/`](../deploy/examples/flows/cookbook/) and every recipe
passes the flow validator in CI:

```bash
cd apps/runtime
bun run scripts/cli.ts validate ../../deploy/examples/flows/cookbook/ --require-version
# 12 file(s) checked — 12 valid, 0 invalid, 0 warning(s)
```

So a snippet here is not a fragment that merely looks right. If a field changes, the recipe
stops validating, and CI says so — which is the reason the recipes exist as files rather than
as prose.

## Before the recipes

**These flows are not served by the quickstart stack.** The Runtime scans `FLOWS_DIR` one level
deep and does not recurse, so a subdirectory of the flows directory is invisible to it. The
cookbook therefore gets validated without ever appearing in `GET /v1/models` of a running
deployment. To use a recipe, copy the file up into your own flows directory and give it an `id`
that does not collide — the ids here are prefixed `cb-` for exactly that reason.

**Each recipe has its own shortcuts file.** A flow directory needs `model-shortcuts.yaml` to be
a flow root, and `llm.shortcut` resolves against it. The CLI walks *up* from a flow file until
it finds one, so
[`cookbook/model-shortcuts.yaml`](../deploy/examples/flows/cookbook/model-shortcuts.yaml) makes
the cookbook independent of the examples above it: a recipe cannot silently start depending on a
shortcut that someone else adds. The engines there name a *protocol* (`openai`) rather than a
`PROVIDERS` instance, which is why the cookbook validates with no registry configured at all.
A real deployment points those engines at its own entries, and switching inference stays a
one-file change.

**Nothing here uses `{{const.*}}`.** `constants.yaml` is deployment-wide and read by the
Runtime's loader; the CLI validator does not read it. A recipe built on a constant would pass
in production and fail offline — the worst property an example can have.
[Recipe 07](#recipe-07-variables-constants-and-calculations) covers where a constant would go,
and `constants.example.yaml` shows the file's shape without a flow depending on it.

---

## Recipe 01 — routing per classifier

📄 [`01-classifier-routing.yaml`](../deploy/examples/flows/cookbook/01-classifier-routing.yaml)

**Problem.** A graph that branches on the *meaning* of a message has to test that branch
somewhere. If the decision is made by a prompt ("if the user seems angry, …"), nothing checks
it, and the branches are untestable.

```yaml
nodes:
  - id: triage
    type: classifier
    label: Triage
    classifierSchema:
      classKey: intent
      schema:
        type: object
        properties:
          intent: { type: string, enum: [incident, question, action, other] }
        required: [intent]
    config:
      fallback: { intent: other }

  - id: route
    type: router
    label: Route

edges:
  - { source: triage, target: route }
  - { source: route, target: answer, conditions: "classification.intent == 'question'" }
  - { source: route, target: act, conditions: "classification.intent == 'action'" }
  - { source: route, target: clarify, conditions: "classification.intent != 'question' && classification.intent != 'action'" }
```

**How it works.** A `classifier` writes validated JSON to `state.classification` under its
`classKey`. Because the schema has an `enum`, the field is guaranteed to be one of four strings,
so an edge condition compares against a closed set. A `router` does nothing itself: its
outgoing edges *are* the routing table, which keeps the decision visible on the canvas instead
of inside a prompt.

**Pitfalls.**

- **There is no `else`.** Conditional edges leaving a node are evaluated in file order and the
  first true one wins; if none is true, the run ends at that node and no step executes. So
  `== 'other'` on the last edge would silently drop every `incident` — the catch-all has to be a
  negation of everything before it. This is the single most common way a routing flow loses
  requests.
- `config.fallback` is what keeps an unparseable model reply from failing the turn. Without it
  the node throws, and the default `errorStrategy` is `fail-fast`.
- A `transform` node before the classifier can copy an identifier out of the message into
  `classification`, so a condition can test something the model was not asked about. See
  [FLOWS.md § `transform`](FLOWS.md#transform-transform).

**Reference.** [Classifier](FLOWS.md#classifier-classifier) ·
[Router](FLOWS.md#router-router) · [Edges and conditions](FLOWS.md#edges-and-conditions)

---

## Recipe 02 — fallback chain and sticky model pool

📄 [`02-model-pool-sticky.yaml`](../deploy/examples/flows/cookbook/02-model-pool-sticky.yaml) ·
shortcuts in [`model-shortcuts.yaml`](../deploy/examples/flows/cookbook/model-shortcuts.yaml)

**Problem.** One node, several models: one that answers, others for when it is down, and a way
to spend a cheap model's budget first — without any flow file naming a model id.

```yaml
# model-shortcuts.yaml — the pool lives here, not in the flow
shortcuts:
  chat:
    pool:
      strategy: fallback
      members:
        - { engine: local, model: small-chat }
        - { engine: local, model: strong-chat }
        - { engine: hosted, model: strong-chat }
  balanced:
    pool:
      strategy: round-robin
      sticky: conversation
      members:
        - { engine: local, model: small-chat, weight: 3 }
        - { engine: local, model: strong-chat, weight: 1 }
```

```yaml
nodes:
  - id: summarise
    type: llm
    llm: { shortcut: balanced }
    config:
      routing:
        strategy: quality-aware
        minQualityScore: 0.8
        candidates:
          - { shortcut: structured }
          - { shortcut: chat }
```

**How it works.** A node asks for a *shortcut*, and the shortcut decides. `fallback` walks the
members in order — the next one is tried when a model is unreachable, overloaded, or returns
output a structured node cannot parse. `round-robin` spreads load by `weight`, and
`sticky: conversation` is the part worth configuring deliberately: without it the second message
of a thread lands on a different model, which changes tone and tool behaviour and invalidates
the provider's prompt cache for that conversation.

**Pitfalls.**

- `config.routing` and `config.objective` are *per-request* decisions over measured cost and
  quality — a third mechanism on top of the pool's static order. `objective` generalises
  `routing` and wins when both are set. A model with fewer samples than `minQualitySamples`
  counts as unproven and stays eligible, so a newly added model still gets traffic instead of
  starving.
- Generation parameters ( `maxTokens`, `temperature`) belong in `llm.parameters`, not in
  `config`: they are settings of the call, while `config` steers the node around the call.
  Precedence is node → pool member → preset.

**Reference.** [The `llm` block](FLOWS.md#the-llm-block) ·
[Flow fields — `pricing`](FLOWS.md#flow-fields)

---

## Recipe 03 — cascade from a cheap to a strong model

📄 [`03-cascade-cheap-to-strong.yaml`](../deploy/examples/flows/cookbook/03-cascade-cheap-to-strong.yaml)

**Problem.** "Use the big model for hard questions" is not implementable — nobody can say which
questions are hard beforehand. What *is* implementable is a measurable property of the *answer*.

```yaml
budgets:
  maxTokens: 40000
  maxWallMs: 120000

nodes:
  - id: answer
    type: llm
    llm: { shortcut: structured }
    config:
      sourcesCheck:
        completeSection: true
        heading: "## Quellen"
        rejectOutOfRangeMarkers: true
      cascade:
        escalateTo: { shortcut: chat }
        when:
          minCitations: 2
          sourcesCheckFailed: true
          maxTopScore: 0.45
          finishReasonLength: true
```

**How it works.** The cheap model answers first. `when` is a disjunction over signals the
runtime already computes — number of distinct `[n]` citations, whether the source check failed,
the best grounding score of the run, whether the answer was cut off at the output limit. If any
of them fires, the same node re-runs once against a stronger shortcut, tool loop included, and
the second answer replaces the first completely.

**Pitfalls.**

- Both attempts count toward the flow's `budgets`. A cascading flow whose ceiling only covers
  one pass will trip its own budget exactly on the requests that needed the cascade.
- `maxTopScore` has no default: many runs have no grounding score at all, so omitting it is the
  way to skip that check rather than inherit a threshold that silently fires.
- Pair the cascade with `sourcesCheck`. Without it, an invented `[12]` reaches the client on the
  first pass and the escalation signal is a lie.

**Reference.** [`llm` settings — `cascade`, `sourcesCheck`](FLOWS.md#llm-llm) ·
[Flow fields — `budgets`](FLOWS.md#flow-fields)

---

## Recipe 04 — RAG with citations and a source check

📄 [`04-rag-citations.yaml`](../deploy/examples/flows/cookbook/04-rag-citations.yaml)

**Problem.** Retrieval that depends on the request, citations the runtime verifies rather than
hopes for, and a sources section that matches what was actually retrieved.

```yaml
nodes:
  - id: gather
    type: parallel
    config:
      ragProfiles:
        default: general
        select:
          - when: "classification.topic == 'policy'"
            use: policy
        profiles:
          policy:
            - collection: policies
              limit: 8
              hybrid: true
              minScore: 0.25
              tags: ["{{context.clientId}}"]
              rerank: true
        shared:
          - collection: legal
            limit: 3
        rerank: { topN: 6 }
        maxDocuments: 10
      ragCompression:
        enabled: true
        llm: { shortcut: structured }
        minChars: 600

  - id: answer
    type: llm
    systemPrompt: "#[[file:prompts/cb-cited-answer.md]]"
    config:
      sourcesCheck:
        completeSection: true
        heading: "## Quellen"
        rejectOutOfRangeMarkers: true
```

**How it works.** A `parallel` node with `ragProfiles` is a context assembler: every source
becomes a search call, the hits are fused, deduplicated per document and injected as numbered
chunks. `select` is evaluated top-down, first match wins, `default` otherwise, and `shared`
sources run in every profile — legal text is relevant whatever the topic turned out to be.
`tags` accepts a template, which is what makes a tenant-scoped plan per-request instead of
per-flow. `sourcesCheck` then appends the citations the answer used but the sources section
lacks, from the sources *registered in this execution* — the runtime never invents a document —
and retries the attempt when the answer cites outside `1..n`.

**Pitfalls.**

- `limit` is a number. A whole-value `{{vars.*}}` reference keeps the referenced value's type,
  so a variable holding `6` works; quoting `"6"` directly puts a string into a numeric field.
- `ragCompression` is fail-open by design: when the summarising call fails, the original chunks
  are used. A weak compression model therefore costs quality, never the answer.
- Retrieval as a `retrieval` node takes `topK`, not `limit` — the two spellings belong to the
  two shapes and are not interchangeable.
  ([`retrieval`](FLOWS.md#retrieval-retrieval))

**Reference.** [`parallel` — `ragProfiles`](FLOWS.md#parallel-parallel) ·
[`llm` — `sourcesCheck*`](FLOWS.md#llm-llm)

---

## Recipe 05 — bounding an agent tool loop

📄 [`05-tool-loop-budget.yaml`](../deploy/examples/flows/cookbook/05-tool-loop-budget.yaml)

**Problem.** A model with tools can consume an inference server: repeated identical calls,
varying arguments on the same tool, huge results, and round trips nobody counted. Each of those
needs its own ceiling, because each fails differently.

```yaml
budgets:
  maxTokens: 30000
  maxToolCalls: 12
  maxWallMs: 90000

nodes:
  - id: research
    type: llm
    tools: [vectorsearch/search, vectorsearch/get_documents]
    config:
      maxToolSteps: 8
      toolArgs:
        vectorsearch/search: { collection: "{{vars.search_collection}}", limit: 5 }
      toolResultBudget:
        perResultChars: 4000
        perTurnChars: 12000
      toolLoopGuard:
        identicalWarnAt: 2
        identicalBlockAt: 3
        churnWarnAt: 3
        churnBlockAt: 5
        churnWindowMs: 60000
      suppressToolPreamble: true
```

**How it works.** Four independent bounds: `maxToolSteps` caps round trips; `toolArgs` merges
*over* what the model supplies, so the model still writes `query` but cannot change the
collection; `toolResultBudget` caps the character volume returning into the window;
`toolLoopGuard` watches four shapes — identical calls, same-tool churn with varying arguments,
mutating calls with no observable effect, and A→B→A→B cycles — and each detector warns first
(injecting a steering notice) and blocks the repeated call second. `budgets` is the outer
ceiling over the whole execution: once one limit is reached the run stops *before* the next
model or tool call with `finishReason: budget_exceeded`.

**Pitfalls.**

- Failed calls count toward churn, so a retry storm is caught; time spent waiting for an
  approval is excluded, so a slow reviewer does not trip the guard.
- **Guard subkeys are not validated.** Unknown *top-level* config keys produce a warning; a typo
  *inside* `toolLoopGuard` produces nothing at all and silently falls back to the default.
  `maxRepeats` does not exist. The names are `identicalWarnAt`/`identicalBlockAt`,
  `churnWarnAt`/`churnBlockAt`/`churnWindowMs`, `noProgressWarnAt`/`noProgressBlockAt`,
  `cycleWarnAt`/`cycleBlockAt`.
- `recovery.retry: true` is only safe here because every tool reads. A flow whose tools write
  must not replay from the start — see [recipe 09](#recipe-09-human-approval-for-a-write-tool).

**Reference.** [`llm` — `maxToolSteps`, `toolArgs`, `toolLoopGuard*`](FLOWS.md#llm-llm) ·
[Flow fields — `budgets`](FLOWS.md#flow-fields)

---

## Recipe 06 — sub-flows and prompt files

📄 [`06-subflows-prompt-files.yaml`](../deploy/examples/flows/cookbook/06-subflows-prompt-files.yaml)
with [`subflows/cb-research.yaml`](../deploy/examples/flows/cookbook/subflows/cb-research.yaml)

**Problem.** The same research loop in six flows and a 40-line system prompt pasted into each.
Both want to be one file with one owner, and both want to stay readable in a diff.

```yaml
metadata:
  version: 1.0.0
  $include:
    subflows:
      - subflows/cb-research.yaml
    patches:
      research:
        config:
          maxToolSteps: 4

nodes:
  - id: greet
    type: llm
    systemPrompt: "#[[file:prompts/cb-greet.md]]"
  - id: answer
    type: llm
    systemPrompt: "#[[file:prompts/cb-final.md]]\nAnswer {{vars.answer_style}}."

edges:
  - { source: greet, target: research }
  - { source: findings, target: answer }
```

**How it works.** Two different mechanisms. `#[[file:…]]` is resolved when the flow loads,
relative to the flow root, so instructions are versioned with the flow and openable by anyone
who can read it — and a prompt file may contain runtime placeholders and `{{vars.*}}` too, which
resolve per run. `$include.subflows` merges a fragment's nodes and edges into the graph as if
they had been written here; `$include.patches` then adjusts one setting of an included node by
id instead of forking the fragment.

**Pitfalls.**

- **An include brings nodes in, it does not place them.** Every node must be reachable from the
  first node or validation fails, so the including flow has to wire the fragment in — the two
  edges above exist only for that. A merged-but-unreachable fragment is dead code, and the
  validator treats it as such.
- A patch addresses objects by id: a patch that names an unknown node id is a *load* error, so
  renaming a node inside a fragment cannot silently leave a stale patch behind. A patch replaces
  the whole value of the key it sets — objects merge, arrays replace, `null` deletes.
- A sub-flow is merged before resolution, so it reads the *including* flow's `variables`. The
  fragment stays generic by declaring what it needs (`search_collection` here) rather than by
  hard-coding it.
- A change to a fragment must bump the including flow's `metadata.version` — the version check
  follows includes. Use a fragment for a shape that genuinely repeats, not for every group of
  nodes: the canvas shows the merged result, and a reader opens two files to learn why a node is
  there.

**Reference.** [Flow fields — `metadata.$include`](FLOWS.md#flow-fields) ·
[Runtime placeholders](FLOWS.md#runtime-placeholders)

---

## Recipe 07 — variables, constants and calculations

📄 [`07-variables-calculations.yaml`](../deploy/examples/flows/cookbook/07-variables-calculations.yaml)

**Problem.** Values a reviewer needs to change per tenant, scattered through prompts and node
configs, with numbers that must be kept in sync by hand.

```yaml
variables:
  tenant_group: finance
  context_length: 8192
  retrieval_limit: 8
  # Derived at load time, in dependency order — the order written here does not matter.
  answer_max_tokens: "{{= min(2048, floor(vars.context_length / 4)) }}"
  answer_style: "{{= coalesce(vars.tenant_style, 'briefly, in three sentences') }}"
  history_turns: "{{= vars.tenant_group == 'finance' ? 12 : 6 }}"

nodes:
  - id: answer
    type: llm
    llm:
      shortcut: structured
      parameters:
        maxTokens: "{{vars.answer_max_tokens}}"
    config:
      maxHistoryTurns: "{{vars.history_turns}}"
      turnContext: "{{= vars.label_prefix }} group={{vars.tenant_group}} date={{now.date}}"
```

**How it works.** Flow variables sit at the top of the file and a request may override any of
them; the derived values are then recomputed, which is what makes an override safe rather than a
partial edit. `{{= …}}` is a load-time calculation over `vars.*`, other flow values and the
[function list](FLOWS.md#variables-constants-and-calculations); a bare `{{vars.x}}` is a
reference that keeps the referenced value's **type**, so `limit` above receives the number 8, not
the string `"8"`. Text interpolation inside a longer string is always text.

**Pitfalls.**

- An undeclared `{{vars.*}}` is a *warning* inside a node (a request may supply it) but an
  *error* inside `variables`, because another derivation depends on it existing. Declare the
  empty default (`tenant_style: ""`) when a caller may set it.
- A cycle between variables is a validation error; the written order is irrelevant.
- Deployment-wide values belong in `constants.yaml` and are referenced as `{{const.*}}` — but
  the CLI validator does not read that file, so an example cannot demonstrate it (see
  [Before the recipes](#before-the-recipes)). `FLOW_PUBLIC_*` environment variables are the
  other shared source and are readable from `variables`.

**Reference.** [Variables, constants and calculations](FLOWS.md#variables-constants-and-calculations)

---

## Recipe 08 — parallel fan-out

📄 [`08-parallel-fanout.yaml`](../deploy/examples/flows/cookbook/08-parallel-fanout.yaml)

**Problem.** Memory recall, a risk list, an image description and a context plan are
independent — running them in series costs the sum of their latency and buys nothing.

```yaml
nodes:
  - id: fanout
    type: parallel
    parallelNodes:
      - recall
      - risks
      - { node: describe_image, condition: "classification.hasAttachment == true" }
    config:
      maxFanoutConcurrency: 2
      followupDownweight: { enabled: true, factor: 0.4, cap: 50 }

  - id: describe_image
    type: llm
    config:
      inputFilter: current-turn-attachments
```

**How it works.** A `parallel` node does two independent things at once: it runs the children
in `parallelNodes`, and it compiles its `ragProfiles` into search calls. Both results are merged
into the context the next node sees. A child is a bare id or `{ node, condition }`, and children
addressed only here need no edges — the Studio draws them as dashed reference links, not as flow
steps. `inputFilter` is a second guard on the conditional child: even when the classification
said there is an attachment, no model call happens unless the latest message really carries one,
so a misclassification costs nothing.

**Pitfalls.**

- **A parallel child must never be an edge's source or target.** It is not a flow step; wiring
  it makes it one, and the same work runs twice.
- `maxFanoutConcurrency` is the setting that matters on one GPU: with three children making two
  model calls each, an unbounded fan-out queues against the node that has to answer. Two at a
  time keeps the first token fast.
- `followupDownweight` reduces the weight of documents the user already saw in the thread, so a
  follow-up question prefers fresh material instead of re-reading the same three chunks.

**Reference.** [`parallel`](FLOWS.md#parallel-parallel)

---

## Recipe 09 — human approval for a write tool

📄 [`09-approval-write-tool.yaml`](../deploy/examples/flows/cookbook/09-approval-write-tool.yaml)

**Problem.** A model must not be the last authority on a write, and a reviewer must not be able
to be removed by a flow edit.

```yaml
nodes:
  - id: look_up
    type: llm
    tools: [gate/ticket_lookup]
    config:
      toolSequenceContract:
        when: { pattern: "status|stand|offen", flags: i }
        sequence: [gate/ticket_lookup]

  - id: file_ticket
    type: tool
    tools: [gate/ticket_create]
    config:
      toolArgs:
        gate/ticket_create:
          subject: "{{vars.ticket_prefix}} {{query}}"
      toolContext:
        server: vectorsearch
        tool: retrieve_evidence
        pre: { match: ["gate/ticket_create"], queryTemplate: "{{query}}", required: true }
      requiresApproval: [gate/ticket_create]
```

**How it works.** Read and write are separate nodes. The read is the model's business; the write
is a `tool` node, so no model decides anything and `toolArgs` is the complete argument set. The
platform consults the approval rule when it executes a tool *the flow declares*, which is what
makes the pause real. `toolContext` attaches evidence to the request — a reviewer looking at a
bare parameter set approves reflexively. `toolSequenceContract` is a contract, not a hint: when
the message matches `when`, the tools in `sequence` must all have succeeded before the answer is
accepted.

**Pitfalls.**

- **Which tools need approval is deployment configuration, not flow configuration**
  (`APPROVAL_REQUIRE_TOOLS`, or centrally in `compliance-policy.yaml`). That is deliberate: a
  reviewer requirement an author could delete by editing a flow file would not be a control.
  `config.requiresApproval` is the flow's own additional claim, never the only gate.
- A tool the model picks inside an `llm` node's own loop is **not** held by
  `APPROVAL_REQUIRE_TOOLS`. There the pause comes from the Gate tool's own rule or from an
  injection-taint finding. When a person has to see a write first, declare it as a `tool` node.
- On timeout the call is **rejected**, never executed. Keep `EXECUTION_TIMEOUT_MS` larger than
  `APPROVAL_TIMEOUT_MS`, or the execution dies while the request is still open and a reviewer
  approves a call nobody waits for.
- `recovery.retry` is off in this recipe on purpose: replaying a run that already wrote files the
  ticket twice.

**Reference.** [`tool` node](FLOWS.md#tool-tool) ·
[Settings on every node — `requiresApproval`](FLOWS.md#settings-on-every-node)

---

## Recipe 10 — image analysis without a vision answering model

📄 [`10-image-inspection.yaml`](../deploy/examples/flows/cookbook/10-image-inspection.yaml)

**Problem.** Screenshots arrive in a chat served by a text-only local model. Making every node
multimodal is the expensive answer; the cheap one is to let the answering model *ask* about the
image.

```yaml
nodes:
  - id: describe
    type: llm
    llm: { shortcut: chat }
    config:
      inputFilter: current-turn-attachments
      imageInspection:
        llm:
          provider: openai
          model: a-vision-model
          parameters:
            visionInput: true
        maxAnswerChars: 4000
        assetSource: { server: vectorsearch, collection: docs, variant: preview }
```

**How it works.** The images are parked as `img-1`, `img-2`, … and never enter the answering
node's prompt. `imageInspection` gives that node a tool which asks a *vision* model about a
reference and returns text. `assetSource` adds `asset:<id>[#bbox]` references, fetched through
the MCP `get_asset` tool of the named server; `#bbox` crops, which is how a model points at one
table cell instead of a whole page. `figureEmbedding` is the inverse direction: the model passes
an `asset:` reference from a search hit, the bytes are fetched with the caller's own ACL
(fail-closed) and handed back as a short-lived media link the model pastes into its answer.

**Pitfalls.**

- The vision model is mandatory and must actually accept images. A model the capability registry
  does not know **fails closed**; a self-hosted one is attested with
  `parameters.visionInput: true`. That is the intended failure direction — not sending images
  somewhere that would ignore them.
- `imageInspection` does not make the answering node multimodal. A node that must see the image
  itself needs a vision model and *no* inspection block.
- `figureEmbedding` needs `EMBED_SEARCH_FIGURES=true` **and** `MEDIA_BASE_URL`; without either,
  the tool does not exist. Because the link is a capability URL (knowledge = access), its
  lifetime is the media store's TTL.
- Both blocks name an MCP server as a *string*: a server missing from `mcp.yaml` validates and
  fails at runtime.
- `inputFilter` on a `classifier` is honoured only when `config.fallback` is declared —
  otherwise it is ignored with a trace warning and the classifier runs on every text-only turn.

**Reference.** [`llm` — `imageInspection*`, `figureEmbedding*`, `mediaTools`](FLOWS.md#llm-llm)

---

## Recipe 11 — making a small local model behave

📄 [`11-small-local-model.yaml`](../deploy/examples/flows/cookbook/11-small-local-model.yaml)

**Problem.** A 4B–9B self-hosted model has a short, specific list of failure modes, and each one
has exactly one switch. This recipe is the list.

```yaml
nodes:
  - id: look_up
    type: llm
    llm:
      shortcut: structured
      parameters:
        temperature: 0.1
        maxTokens: 800
        chatTemplateKwargs: { enable_thinking: false }
    config:
      requireToolUse: true
      suppressToolPreamble: true
      maxToolSteps: 5

  - id: summarise
    type: llm
    config:
      finalAnswerContract:
        startMarker: "FINAL ANSWER:"
        endMarker: "END OF ANSWER"
        streamAfterStartMarker: true
      reasoningSalvage: true
      emptyResponseFallback: true
      emptyResponseFallbackText: Diese Anfrage konnte nicht beantwortet werden. …
      maxOutputChars: 8000
      historyCompression:
        enabled: true
        thresholdRatio: 0.7
        llm: { shortcut: structured }
```

**How it works.** Each switch answers one failure:

| Failure | Switch |
| --- | --- |
| Answers from its weights instead of calling a tool | `requireToolUse` |
| "Let me check…" streams, then the real answer arrives underneath | `suppressToolPreamble` |
| Plan, then answer, then summary — and the plan is the reply | `finalAnswerContract` |
| Whole answer inside a reasoning block, empty content | `reasoningSalvage` |
| Every attempt returns an empty completion | `emptyResponseFallback` |
| Generates until its own limit in a repetition loop | `maxOutputChars` |
| Window fills with old turns and the question is lost | `historyCompression` |
| Thinks out loud and spends the output budget | `chatTemplateKwargs: { enable_thinking: false }` |

**Pitfalls.**

- `requireToolUse` makes the node **fail** when the model refuses — deliberately: a loud failure
  is cheaper than a confident invention about someone's tickets. Where relevance varies per
  message, use `requireToolUseWhenSelected` (+ `…MinScore`) so the call is forced only when
  semantic tool selection found a plausible tool.
- `finalAnswerContract` markers are 8–128 characters and must be strings the model writes
  verbatim — ask for them in the prompt exactly as declared, colon included. It needs a tool-less
  node (a loop's output is not one final answer) and cannot be combined with `outputSchema`.
- `emptyResponseFallback` hides a real problem. It belongs together with the trace: an answer
  that is frequently the fallback text is a window, quantisation or template problem, not a copy
  problem.
- There is no `requireToolUseText`. And as in recipe 05: the guard subkeys are not validated, so
  their names have to be right.

**Reference.** [`llm` settings](FLOWS.md#llm-llm)

---

## Recipe 12 — what happens when a node fails

📄 [`12-error-fallback.yaml`](../deploy/examples/flows/cookbook/12-error-fallback.yaml)

**Problem.** A retrieval failure should make an answer worse, not lose the conversation — and
the recovery path should be visible in the graph instead of being a silent default.

```yaml
nodes:
  - id: retrieve
    type: retrieval
    config:
      collection: handbook
      errorStrategy: continue

  - id: draft
    type: llm
    config:
      errorStrategy: continue

  - id: check
    type: router

edges:
  - { source: check, target: degraded, conditions: "hasErrors == true" }
  - { source: check, target: answer, conditions: "hasErrors != true" }
```

**How it works.** `config.errorStrategy` is per node: `fail-fast` (default) aborts the run,
`continue` records the error and carries on, `fallback` runs `fallbackNodeId` *in place*. Edges
can then branch on the recorded state — `hasErrors` and `errorCount` are condition variables, so
a branch can depend on a failure without any model having to notice one. A recovered run is
degraded, not successful: the error stays in the run's errors and is visible in the trace either
way.

**Pitfalls.**

- **Both keys belong in `config`.** The engine reads `config.errorStrategy` and
  `config.fallbackNodeId`. At node level they are ignored in silence — the node keeps
  `fail-fast`, the recovery branch below stops being taken, and the failure looks handled.
  (Nothing warns about it either; a stray node-level key is accepted.)
- **Why `fallback` is awkward to declare.** It executes the substitute in place rather than
  rerouting the graph — that is what keeps the monitoring graph honest. Two consequences: a node
  that only ever runs as a fallback has no incoming edge, and the validator requires every node
  to be reachable, so a pure fallback node is rejected as unreachable although the engine would
  have run it; and wiring an edge to it satisfies the validator but makes the `hasErrors` branch
  run the same node a *second* time — a duplicate action for anything with a side effect. Hence
  the pattern above: `continue` plus a router, same visible outcome, single execution. If the
  fallback node itself fails, the run fails with **both** errors.
- Flow-level `recovery.retry` re-executes the failed step *before* any node policy applies. It
  suits a transient gateway failure; it is wrong for anything with a side effect and wrong for
  deterministic errors, which fail identically every time.

**Reference.** [Settings on every node](FLOWS.md#settings-on-every-node) ·
[Edges and conditions](FLOWS.md#edges-and-conditions) ·
[Flow fields — `recovery`](FLOWS.md#flow-fields)

---

## Field coverage

Every field a recipe uses appears in [FLOWS.md](FLOWS.md) or, for the three keys below, in the
document named there. Worth keeping as a check when a recipe changes:

| Key | Where it is documented |
| --- | --- |
| `budgets.maxTokens` / `maxToolCalls` / `maxWallMs` | Parent `budgets` in [Flow fields](FLOWS.md#flow-fields); subkeys in [CAPABILITIES.md](CAPABILITIES.md) |
| `engines`, `modelPresets`, `shortcuts` (in `model-shortcuts.yaml`) | [Flows directory](FLOWS.md#flows-directory) describes the file; model pools in [CAPABILITIES.md](CAPABILITIES.md) |
| `pricing` (in `model-shortcuts.yaml`) | [Flow fields — `pricing`](FLOWS.md#flow-fields) names it as the central prices the flow-level block overrides |
| `variables.*`, `config.fallback.<field>`, `config.toolArgs.<server>/<tool>` | User-defined by design; the mechanism is in [Variables, constants and calculations](FLOWS.md#variables-constants-and-calculations) and [`llm` — `toolArgs`](FLOWS.md#llm-llm) |

The remaining 150-odd keys are matched against the generated reference by name, which is what
`bun run flow-reference:check` protects: change a field in the catalog or the schema and the
docs move with it, or CI fails.

## What the cookbook does not cover

- **`agent-harness`** — a delegation with its own verification loop and budget. It needs a
  second model configured to be meaningful, so it is documented in
  [FLOWS.md](FLOWS.md#agent-harness-agent-harness) rather than as a copyable recipe.
- **Triggers and webhooks** — scheduling and inbound webhooks are deployment surface (secrets,
  retry semantics, an allow-list) before they are flow configuration.
  See [FLOWS.md § `trigger`](FLOWS.md#trigger-trigger) and
  [CONFIGURATION.md](CONFIGURATION.md).
- **`assistant-context` / `assistant-learn`** — they write to shared state, which needs an
  owner and a retention decision before it needs a YAML example.
- **`overrides`** (per-request and per-group node overrides) — powerful enough that the review
  story has to be written first.

## See also

- [FLOWS.md](FLOWS.md) — the generated reference: every field, bound, node type, placeholder and
  operator.
- [tutorials/first-assistant.md](tutorials/first-assistant.md) — one assistant end to end against
  a running stack: retrieval, an approval, a signed receipt.
- [`../deploy/examples/flows/`](../deploy/examples/flows/) — the loadable examples the quickstart
  stack actually serves.
- [CAPABILITIES.md](CAPABILITIES.md) — whether ATF does a thing, and which settings govern it.
