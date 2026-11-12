# Blueprint — research assistant

A flow that answers a question by searching a document collection until the evidence holds,
then writes an answer whose source list is checked by code rather than asked for politely.

This is a **starting point, not a product**. It carries no customer data, no host names and
no domain prompt text: the prompts say what a good research step does, not what one
department's cases look like. Add your own domain instructions on top of these files.

```
deploy/blueprints/research-assistant/
├── research-assistant.yaml     the flow (138 lines)
└── prompts/
    ├── plan.md                 planner: turn the question into a work list
    ├── research.md             worker: search → open → search again
    ├── verify.md               verifier: withhold or grant the pass signal
    └── answer.md               synthesis: conclusion first, sources checked
```

## What it demonstrates

| Mechanism | Where | Why it matters |
| --- | --- | --- |
| Bounded research loop | `research` (`agent-harness`) | Iteration, time and stagnation caps stop an open question from running forever. |
| Pinned tool arguments | `researcher.config.toolArgs` | `collection` is set by the flow, never chosen by the model. |
| Independent verification | `config.verification` | A second node decides whether the evidence is sufficient, and `failClosed` means a refusal is a failed run, not an answer. |
| Deterministic source check | `answer.config.sourcesCheck` | Missing `[n]` entries are appended from registered citations; out-of-range markers retry. |
| Deployment variables | `variables` | Model, collection and loop size are the only things a caller edits. |

## Prerequisites

- A running Runtime and Search service (`deploy/examples/compose.yaml` in this repository,
  or your own deployment).
- At least one Search collection with documents in it, reachable under the name you put in
  `vars.collection`. The tool names below (`vectorsearch/search`,
  `vectorsearch/get_documents`, `vectorsearch/get_pages`) are the Search server's tools as
  the Runtime mounts them — check `docs/FLOWS.md` for the current list.
- A model the Runtime can reach. Either a built-in protocol with credentials in the
  environment (`openai`, `anthropic`, `google`, `ollama`, `azure`, `bedrock`), or an entry
  in the Runtime's `PROVIDERS` registry whose name you then put in `vars.model_provider`.

## Variables

Set these in `variables:` in the flow, or override them per request with `context.variables`
— which is how you test a second collection without editing the file.

| Variable | Default | Meaning |
| --- | --- | --- |
| `model_provider` | `openai` | Built-in protocol name, or a `PROVIDERS` instance name. |
| `model_id` | `replace-me` | Model id. There is no sensible default here; set it. |
| `collection` | `department_documents` | The only collection this assistant may read. |
| `max_tool_steps` | `8` | Tool round-trips per research worker before it must report. |

## Start

Validate it offline — no services, no model registry needed, because the provider comes from
`{{vars.*}}`:

```bash
cd apps/runtime
bun run scripts/cli.ts validate ../../deploy/blueprints/research-assistant/ --require-version
```

Then load it into a Runtime that has `PROVIDERS` and a Search server configured, and ask it
something. With the quickstart stack:

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "authorization: Bearer $ATF_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model": "research-assistant",
       "messages": [{"role": "user",
                     "content": "What changed between the two versions?"}],
       "context": {"variables": {"model_id": "your-model"}}}'
```

## Limits of this blueprint

- **One collection.** `toolArgs` pins `vars.collection` into every call on purpose. Adding a
  second store means a second researcher node with its own pinned collection — not a tool
  argument the model fills in.
- **Text only.** No image inspection, no figure embedding, no client-side tools. See
  `deploy/examples/flows/` for flows that use those.
- **The verifier is as good as its prompt.** `verify.md` states concrete criteria because a
  verifier asked "is this good?" says yes. Replace the criteria with your own quality bar;
  the mechanism does not encode your domain.
- **No approval or write path.** This flow only reads. A tool that changes something belongs
  behind a Gate approval — see `../gate-sql-profile/`.
- **`failClosed: true` means runs can fail.** That is the point: an unverified answer is a
  failed run with `verification-failed`, not a confident guess. Decide deliberately if you
  want the opposite.
