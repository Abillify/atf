<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Your first governed assistant

Build one assistant end to end — your own document retrieved and cited, a tool call
held until a named person approves it, and a signed receipt proving which sources and
which approval stood behind the answer.

Two things make this different from wiring an SDK directly. First, **the model never
sees a secret**: it is reached through one OpenAI-compatible endpoint served by the
Runtime, and the provider key stays in the Runtime's environment. Second, **the audit
record is built by the platform rather than by your code**: retrieval, tool use,
approval and token counts are recorded as the request runs, then signed. You will read
that record directly in this tutorial, without writing a line of application code.

By the end you will also know precisely where the boundaries are: the quickstart
answers with a mock, so this tutorial proves the *governance path* end to end, not
answer quality. "What this proved, and what it did not" says which is which.

The flow used here is
[`deploy/examples/flows/08-first-assistant.yaml`](../../deploy/examples/flows/08-first-assistant.yaml),
validated by CI with the rest of the examples.

**Before you start:** complete the
[quickstart](../../deploy/examples/README.md), which brings up the stack on
`localhost:3000-3004`. This tutorial needs `curl`, `docker`, `bun` and a checkout of
this repository (for the receipt verifier). Every command below was run against the
stack as described; the output shown is that run's output, truncated where marked.

---

## Step 0 — start the stack with retrieval switched on

```bash
cd deploy/examples
docker compose --env-file .env.example \
  -f compose.yaml -f compose.images.yaml -f compose.rag.yaml up -d --wait
```

`compose.rag.yaml` is a two-line overlay that sets `RAG_ENABLED=true` and names an
`EMBEDDING_MODEL`. Without it the quickstart runs with retrieval **off**, and a
`retrieval` node is a **no-op rather than an error** — your assistant answers from the
question alone and looks perfectly healthy while doing it. The counter-example below
shows what that looks like, because recognising it is worth more than knowing how to
switch it on.

(If you build images instead of pulling them, keep Option B's `-f compose.yaml` with
`--build` and add `-f compose.rag.yaml` — the overlay carries environment variables
only, so it composes with either option.)

Check it came up:

```bash
curl -s http://localhost:3000/health
```

```json
{"status":"ok","auth":"disabled","flows_loaded":8}
```

`auth: disabled` is correct here and wrong in production — the quickstart exists to be
started in one command. It is called out by the posture page rather than hidden.

### If retrieval is switched off, what happens?

Stop the Runtime and start it again **without** the overlay:

```bash
docker compose --env-file .env.example -f compose.yaml -f compose.images.yaml \
  up -d runtime --wait
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/v1/rag/collections
```

```text
404
```

and a chat request still returns `200` with an answer — with no sources attached. The
probe below reads the response fields rather than the HTTP status, because the status
is where the trap is:

```bash
curl -s -X POST http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"first-assistant","messages":[{"role":"user","content":"How many days per week may I work remotely?"}]}'
```

```text
model: first-assistant
has sources key: false
sources: undefined
injected context: false
```

No error, no warning, no failed request: the node ran, found no store behind it, and
passed the question straight through. That is the failure mode to remember, and
`GET /v1/rag/collections` is the cheap way to rule it out — 404 means retrieval is off,
`{"collections":[]}` means it is on and empty, and both look identical from the answer.
Restart with the overlay before continuing.

---

## Step 1 — put your own document in front of the model

The flow retrieves from a collection named `policies`. Ingest three short policies —
an HR handbook stand-in, so the answer is obviously checkable:

```bash
curl -s -X POST http://localhost:3000/v1/rag/policies/documents \
  -H 'content-type: application/json' --data @docs.json
```

```json
{"collection":"policies","upserted":3,"ids":["remote-work","annual-leave","sick-notice"]}
```

```bash
curl -s http://localhost:3000/v1/rag/policies/count
curl -s http://localhost:3000/v1/rag/collections
```

```json
{"collection":"policies","count":3}
{"collections":["policies"]}
```

`docs.json` holds a `documents` array; each entry has the text and an `id` that the
trace and the receipt will later name. You send plain text — the Runtime embeds it
server-side, so no client ever computes a vector:

```json
{
  "documents": [
    {"id": "remote-work",
     "text": "Every employee may work remotely for up to three days per week. Team leads approve remote days beyond that limit. Remote days must be recorded in the timesheet by the end of the same week."},
    {"id": "annual-leave",
     "text": "Annual leave is 28 working days. Leave of more than five consecutive working days must be requested at least four weeks in advance through the HR portal."},
    {"id": "sick-notice",
     "text": "Report sickness to your team lead before 09:30 local time. A medical note is required from the fourth consecutive day."}
  ]
}
```

The substance is this: **these three chunks are now what the model is allowed to
know.** Nothing in the prompt can add to them, and Step 3 shows them arriving in the
request. An optional `metadata` object per document travels with the chunk and shows
up in the retrieved sources.

A production corpus does not arrive through this endpoint. The Runtime's store is for
small, curated sets; document-scale retrieval goes through the Search service, which
is what flows `03` and `05` use. See
[operations-and-retrieval.md](../operations-and-retrieval.md) for the split.

---

## Step 2 — the flow

Three nodes, two edges — abridged from the file, which carries the reasoning in
comments:

```yaml
nodes:
  - id: retrieve
    type: retrieval
    label: Look the policy up
    config:
      collection: policies
      topK: 3

  - id: answer
    type: llm
    label: Answer from the policy
    llm:
      provider: quickstart
      model: echo
    systemPrompt: >-
      Answer from the provided sources only and cite them as [1]. If they do not
      contain the answer, say so rather than filling the gap.

  - id: file-ticket
    type: tool
    label: File a follow-up ticket (needs a person)
    tools:
      - gate/ticket_create
    config:
      toolArgs:
        gate/ticket_create:
          subject: "{{query}}"

edges:
  - { source: retrieve, target: answer }
  - source: answer
    target: file-ticket
    conditions: "lastMessageText =~ 'ticket|follow.up'"
```

Two decisions carry the tutorial.

**Why `echo`.** The quickstart has no model behind it, so it ships `echo` — a mock
provider that mirrors its input. Here that is an advantage: `echo` *shows you the
prompt*, so you can read the retrieved chunks that were injected ahead of your question
instead of taking on trust that retrieval worked.

**Why the second edge is conditional.** `file-ticket` is not offered to the model as a
possibility; it is a node in the graph, and the **shape of the conversation** decides
whether the run reaches it. `lastMessageText =~ 'ticket|follow.up'` is evaluated by the
Runtime over the conversation as it stands, so one flow answers an ordinary question and
stops, and files a ticket only when asked to. Without that condition every test question
would leave a write waiting for a person. That also means the model cannot be prompted
into the tool, or talked out of it — the edge is the decision, and
[FLOWS.md](../FLOWS.md#edges-and-conditions) has the rest of the grammar.

---

## Step 3 — ask a grounded question

```bash
curl -sD /tmp/h.txt -X POST http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"first-assistant","messages":[{"role":"user","content":"How many days per week may I work remotely?"}]}'
```

The two headers that matter:

```text
x-execution-id: 33c3cc59-8b26-4c07-9ea1-0518615a7c0f
x-atf-receipt: 7919b8a1-bc8d-4d18-ac97-7f698e2ed8f8
```

and in the body:

```json
{
  "model": "first-assistant",
  "usage": {"prompt_tokens": 200, "completion_tokens": 227, "total_tokens": 427},
  "sources": [
    {"index": 1, "title": "Source 1", "url": "",
     "snippet": "Every employee may work remotely for up to three days per week. Team leads approve remote days beyond that limit. Remote days must be recorded in the timesheet by the end of the same week.",
     "score": 1},
    {"index": 2, "title": "Source 2", "url": "", "score": 1},
    {"index": 3, "title": "Source 3", "url": "", "score": 1}
  ]
}
```

*(Second and third snippets omitted here for space; all three entries were present.)*

Three sources came back, all from the collection you ingested in Step 1. Now the part
`echo` lets you see — the message the model actually received, verbatim:

```text
How many days per week may I work remotely?

Use ONLY the following retrieved context to answer the user's question, and cite
sources as [n]. If the context is insufficient, say so explicitly.

[1] Every employee may work remotely for up to three days per week. Team leads
approve remote days beyond that limit. …

[2] Annual leave is 28 working days. Leave of more than five consecutive working
    days must be requested at least four weeks in advance through the HR portal.

[3] Report sickness to your team lead before 09:30 local time. A medical note is
    required from the fourth consecutive day.
```

Your question, then an instruction to use only the retrieved context, then the chunks
numbered `[1]`-`[3]` — the same three, in the same order, as the `sources` array. Your
prompt did not contain the chunks and could not have; **retrieval put them there.**
That is the gap between "the assistant knows our policies" and "we can show which
paragraphs it was shown", and in a review it is the second one that is answerable.

For reference: `X-Execution-Id` identifies the run (used in Step 6) and
`X-ATF-Receipt` is the signed receipt's id.

---

## Step 4 — try it the way Studio does

The page at `http://localhost:3001/studio` is the same Runtime: pick *first-assistant*,
type, and the run appears in the trace list afterwards. A test run registers a draft
copy of the canvas under a throwaway model id so an unpublished flow is callable
without saving it:

```bash
curl -s -X POST http://localhost:3001/flows/first-assistant/test-run \
  -H 'content-type: application/json' --data @flow.json
```

```json
{"model":"first-assistant@studio-d805a9a91260","expiresAt":"2026-11-11T16:36:22.638Z"}
```

Send that id as the `model` and you are talking to your unsaved canvas. `flow.json` is
the flow as JSON — the Studio posts exactly what is on its canvas, which is why a
canvas you have not saved is still callable. Two consequences worth internalising:
**the Studio is a client over these endpoints**, so anything you can do there you can
script from CI, and **a model id is a flow**, which is why the `model` field of a
request is a governance-relevant input rather than a style preference — it selects a
graph, a data class, a set of tools and an evidence trail at once.

---

## Step 5 — let it act, but only with a named human

Ask something that trips the condition. The request does not complete — the client
blocks while the run parks on the server waiting for a person — so start it in the
background and read the queue separately:

```bash
curl -s -X POST http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"first-assistant","messages":[{"role":"user","content":"Please open a follow-up ticket: the printer on the third floor still jams."}]}' &

curl -s http://localhost:3000/monitoring/approvals | jq '.pending'
```

```json
[{"executionId":"463f546c-31da-434e-a690-f48781e9332a",
  "nodeId":"file-ticket",
  "tool":"gate/ticket_create",
  "args":{"subject":"Please open a follow-up ticket: the printer on the third floor still jams."},
  "tenantId":"default",
  "requestedBy":"anonymous",
  "id":"fec1fde7-c04d-45d2-992c-08e39b53aff8",
  "requestedAt":"2026-11-11T15:57:31.908Z"}]
```

Read the entry as the decision record it is: **what** will happen (`ticket_create`),
**with which arguments** (the subject, so you can see what it would file), **for which
run**, and **who asked** — `anonymous`, because the quickstart has authentication off.
That last field is why the posture page warns about auth mode: with authentication on,
`requestedBy` names the caller, and "the assistant wanted it" stops being the only
available answer.

Note what is *not* here: a decision by the model to act. The tool node ran because the
conversation matched the condition in Step 2; the entry exists because the deployment
lists `gate/ticket_create` in `APPROVAL_REQUIRE_TOOLS`, which is a **deployment**
choice in `compose.yaml`, not a property of the flow. The same flow deployed without
that variable files tickets silently. Approval boundaries belong to the operator.

Approve it — as the Control approval inbox does, and **within about two minutes**; the
run itself gives up before the approval window closes (Pitfall 4).

```bash
curl -s -X POST http://localhost:3000/monitoring/approvals/fec1fde7-c04d-45d2-992c-08e39b53aff8 \
  -H 'content-type: application/json' \
  -d '{"approved": true, "reason": "tutorial: verified the subject line", "by": "anja.weiss"}'
```

```json
{"id":"fec1fde7-c04d-45d2-992c-08e39b53aff8","approved":true,"status":"resolved"}
```

The backgrounded request returns at this point (`wait` for it if your shell is busy):
approval is what unblocks the run, so the reply, the trace and the receipt all belong to
the same execution id you saw in the queue entry. Approving an id that is no longer
pending is a `404` rather than a second decision, and a resolved entry keeps its record —
`GET /monitoring/approvals` moves it from `pending` to `resolved` with `by` and
`decidedAt` filled in.

The `approved` boolean is required; `reason` is optional and lands in the record. The
`by` field names the human **only on an unauthenticated plane like this one** — as soon
as authentication is on, the verified actor of the request wins and a body cannot claim
to be somebody else. There is also a browser-friendly form, useful when a reviewer has
no shell: `GET /monitoring/approvals/:id/decide?decision=denied&by=anja.weiss` (which is
exactly the link a scanner could follow by accident, which is why it renders a
confirmation page by default — see the threat model's approval-link row).

The parked run resumes and finishes. On the database, the ticket is a real row with a
real author:

```bash
docker compose --env-file .env.example -f compose.yaml -f compose.images.yaml \
  exec -T postgres psql -U atf -d atf_search -c \
  "select id, owner, left(subject,50) as subject, status from demo.tickets order by id desc limit 1"
```

```text
 id |   owner    |                      subject                       | status
----+------------+----------------------------------------------------+--------
 13 | anja.weiss | Please open a follow-up ticket: the printer on the | open
```

The quickstart has one Postgres database, `atf_search`; the demo tables live in the
`demo` schema next to retrieval's `vs_*` tables. `owner` comes from the Gate mapping's
`:ctx.username` — the identity the platform carries for the run — not from a string the
model wrote, which is what makes the row attributable. Reject instead of approving and
the run ends with the tool not executed.

---

## Step 6 — what actually happened, and proof of it

The trace for a run, by execution id:

```bash
curl -s http://localhost:3000/monitoring/debug/463f546c-31da-434e-a690-f48781e9332a
```

| node | type | status | duration | recorded |
| --- | --- | --- | --- | --- |
| `retrieve` | retrieval | completed | 28 ms | `tool_calls: ["retrieval/policies"]` |
| `answer` | llm | completed | 39 ms | `model: "quickstart/echo"`, 208 → 234 tokens |
| `file-ticket` | tool | completed | 30563 ms | `tool_calls: ["gate/ticket_create"]` |

The `file-ticket` duration looks wrong until you notice it waited for a human: 30.6 s
is the time the approval sat pending. The trace separates "the platform was slow" from
"we were waiting for Anja", which is exactly the distinction an incident review asks
for. The model, the token counts and the collection are on the nodes, not in an
application log you have to correlate. Note what that means for access: the trace carries
the **full tool arguments** — the subject line above is in there verbatim — so
`/monitoring/*` is not a read-only view of metrics. `MONITORING_AUTH` defaults to `true`
for exactly this reason; the quickstart sets it to `"false"` in `compose.yaml` so the
tour works without a login, and the production gate treats that same setting as a fatal
misconfiguration rather than a preference.

The receipt is the signed form of the same facts:

```bash
curl -s 'http://localhost:3000/v1/receipts?execution_id=463f546c-31da-434e-a690-f48781e9332a' \
  | jq '.receipts[0]' > /tmp/receipt.json
curl -s http://localhost:3000/.well-known/atf-jwks.json > /tmp/jwks.json
jq '{flow: .payload.flow_id, version: .payload.flow_version, status: .payload.status,
  models: .payload.models, retrieval_sources: .payload.retrieval_sources,
  approvals: [.payload.approvals[] | {tool, approved, approver}]}' /tmp/receipt.json
```

```json
{
  "flow": "first-assistant", "version": "1.0.0", "status": "completed",
  "models": [{"model": "quickstart/echo", "provider": "quickstart"}],
  "retrieval_sources": [{"collection": "policies", "retrieved": 3,
                         "chunk_ids": ["remote-work", "annual-leave", "sick-notice"],
                         "revision_ids": []}],
  "approvals": [{"tool": "gate/ticket_create", "approved": true, "approver": "anja.weiss"}]
}
```

Two API details that trip people up: the collection route **requires** `execution_id`
(`GET /v1/receipts` without it is a `400`, and without the parameter name a `404`), and
`GET /v1/receipts/:id` is keyed by *receipt* id — the `X-ATF-Receipt` header from Step 3,
not the execution id. The two are different identifiers, and `GET /v1/receipts/:id` with
an execution id answers `Receipt not found.` rather than helping. One run also produces
several receipts — `chat_completion` plus one `tool_call` per tool step — and the
`chat_completion` one, which the header names, is what `.receipts[0]` selects here.

Which model, which chunks, which approval — one payload. Verify the signature yourself
rather than trusting this document:

```bash
cd ../..   # repository root
bun run scripts/atf-verify.ts --receipt /tmp/receipt.json --jwks /tmp/jwks.json
```

```text
ATF Decision_Receipt verification (offline)

  receipt:      /tmp/receipt.json
  receipt_id    4ecffba9-cdb2-41c6-9ae4-fbe949cd9403
  kind          chat_completion
  flow_id       first-assistant
  flow_version  1.0.0
  tenant_id     default
  execution_id  463f546c-31da-434e-a690-f48781e9332a
  status        completed
  started_at    2026-11-11T15:57:31.816Z
  finished_at   2026-11-11T15:58:02.471Z

  jwks:         /tmp/jwks.json
  kid:          xtnJ9lErNQKl-sLqLMFAoTZlPIEjHncoJHzdo69bOcQ
  signature:    VALID

RESULT: VALID
```

**Caveat, and it matters:** the quickstart generates a throwaway signing key, so this
signature proves the receipt is *internally consistent and verifiable*, not that a key
you trust issued it. In a real deployment `EVIDENCE_SIGNING_KEY` is a Vault-managed
pair and the JWKS is published once, so a third party can verify without trusting ATF.
The algorithm and what the payload covers are in
[ADR 0029](../adr/0029-verifiable-execution-receipts.md) and
[ADR 0030](../adr/0030-asymmetric-evidence-chain-ed25519.md); rotating the key pair is
in [key-rotation.md](../runbooks/key-rotation.md).

---

## Step 7 — replace the mock with your own model

Everything you did stays; only the provider behind the model id changes. In
`.env.example`:

```json
PROVIDERS='[{"name":"openai","protocol":"openai","baseUrl":"https://api.openai.com/v1","apiKey":"${OPENAI_API_KEY}"}]'
DEFAULT_LLM='{"provider":"openai","model":"gpt-4o-mini"}'
EMBEDDING_MODEL='{"provider":"openai","model":"text-embedding-3-small"}'
```

and change the `answer` node to `llm: {provider: openai, model: gpt-4o-mini}`.
`EMBEDDING_MODEL` now embeds with real vectors, so retrieval scores reflect similarity
rather than always returning 1. Restart, re-ingest Step 1 (the store is in memory), and
ask the same question — you should get an actual sentence with citations instead of an
echo.

`name` is what a flow's `llm.provider` refers to, and the Runtime refuses to start if
any referenced name is missing, so a typo is a startup failure rather than a surprise
at 3 a.m. Options for streaming, proxying through a gateway, and self-hosted endpoints
are in [CONFIGURATION.md](../CONFIGURATION.md#provider-configuration).

> **TODO(human):** this tutorial was executed against the quickstart mock. The
> real-provider leg above (a live vendor endpoint, and a real embedding model behind
> `EMBEDDING_MODEL`) has not been run here and needs an API key, so the exact shape of
> a live answer is unverified — please re-run Steps 3 and 6 against one vendor before
> quoting this page to a customer.

---

## What this proved, and what it did not

Worth separating, because the honest version is what makes the rest usable.

**Proved, on the mock:** your document reached the prompt, and you can see it; the
output carried sources naming the chunks it came from; the tool call stopped until a
named person approved it, and the approved row records that person; the trace shows
retrieval at 28 ms against 30.6 s of human wait; the receipt lists model, chunk ids and
approver, and its signature verifies.

**Not proved:** any of it about quality. `echo` mirrors input rather than answering, and
the mock embedding model returns a fixed vector, which is why every `score` above is
exactly `1` — those scores show the plumbing works, not that retrieval ranked
correctly. Retrieval relevance is measurable, but that belongs in an eval harness with
a real embedding model, not in a tutorial.

**Also out of scope:** the quickstart is single-replica, unauthenticated, and its
posture report (`GET /monitoring/posture`) comes back `status: fail` — by design,
because it is a demo. Read it as a checklist of what to configure, not as a defect
report. See [deploy/examples/TOUR.md](../../deploy/examples/TOUR.md).

---

## Pitfalls

1. **RAG off is silent.** `RAG_ENABLED` unset makes a `retrieval` node a no-op with a
   200 response and no sources — Step 0's counter-example. Check
   `GET /v1/rag/collections` (404 = switched off) before debugging prompts.
2. **`llm.provider` must name a configured provider.** A typo is caught at validation,
   not at runtime, and the message names the field:
   `ERROR [nodes[1](answer).llm.provider] provider must be a configured PROVIDERS name or a built-in protocol`.
3. **Approvals come from the deployment, not the flow.** `APPROVAL_REQUIRE_TOOLS` lists
   the tools that need a human; move it to the flow's `config.approval` and you have a
   flow-scoped boundary that travels with the file instead.
4. **The run dies before the approval window does.** `APPROVAL_TIMEOUT_MS` defaults to
   600000, but `EXECUTION_TIMEOUT_MS` defaults to 120000 — so a run parked for review is
   aborted after two minutes even though the approval is still open. Approving late in
   this tutorial produced `file-ticket` `status: error` with
   `Flow "first-assistant" execution exceeded the 120000ms timeout and was aborted.`, a
   flow `status` of `error`, and **no ticket row**: the abort is clean rather than
   half-written, but the answer is gone. Raise `EXECUTION_TIMEOUT_MS` above the human
   review window for any flow with approvals in a demo or interactive use.
5. **Re-ingest after every restart.** The vector store here is in-memory and per-replica
   (a second Runtime replica does not see another's documents) — durable corpora belong
   in the Search service or in `DATABASE_URL`-backed storage.
6. **Bump `metadata.version` when you change the flow.** CI validates with
   `--require-version`, and receipts pin the version that ran, so an unversioned edit
   makes old receipts ambiguous.
7. **`X-ATF-Receipt` needs `DECISION_RECEIPTS_ENABLED`.** The quickstart sets it; a
   deployment without it returns answers with no receipt header, which is easy to
   mistake for "receipts are broken" when the feature is simply off.

---

## Where to go next

- [deploy/examples/flows/README.md](../../deploy/examples/flows/README.md) — the other
  seven flows, including `05-support-assistant.yaml` with a routed multi-step graph and
  `04-tool-use-with-approval.yaml` with a self-taken lookup beside an approved write.
- [FLOWS.md](../FLOWS.md) — every node type, edge condition and flow-level option.
- [CONFIGURATION.md](../CONFIGURATION.md#provider-configuration) — providers, retrieval,
  approval, signing keys.
- [deploy/examples/TOUR.md](../../deploy/examples/TOUR.md) — what each Control page is
  for, walked through in five minutes.
