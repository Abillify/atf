# Local unauthenticated quickstart

This example starts all five ATF applications plus PostgreSQL/pgvector, a deterministic OpenAI-compatible mock, a one-shot service that writes a throwaway receipt signing key into a volume, and a one-shot service that loads one demo document into Search. It is intended only for local functional smoke testing. Authentication, tenant isolation, TLS, durable Runtime state, Redis, real inference, and production hardening are deliberately disabled or omitted. Authorisation is the one control left switched on, with no policy file behind it, because Runtime consults the approval gate as part of authorisation - with it off, nothing in [`flows/04-tool-use-with-approval.yaml`](flows/04-tool-use-with-approval.yaml) would ever wait for a person. Every flow here is therefore admitted, and only the approval rule pauses a call.

Two ways to start the same stack:

| Option | What you get | Needs |
| --- | --- | --- |
| [A](#option-a--published-images) | The released images, pulled from the registry | Docker with Compose v2, roughly 4 GB of free disk |
| [B](#option-b--build-from-source) | Images built from this checkout | A build toolchain, at least 6 GB free memory and 10 GB free disk |

Choose Option A to look around the product, Option B once you have changed code in this checkout and want to see it.

## Option A — published images

`compose.images.yaml` is an overlay that swaps every `build:` section for a
`ghcr.io/abillify/atf-*` image, so the service definitions, flow files, mock
model and health checks are identical in both options. From the repository root:

```bash
docker compose --env-file deploy/examples/.env.example \
  -f deploy/examples/compose.yaml -f deploy/examples/compose.images.yaml \
  up -d --wait
docker compose --env-file deploy/examples/.env.example \
  -f deploy/examples/compose.yaml -f deploy/examples/compose.images.yaml ps
```

`ATF_VERSION` in [`.env.example`](.env.example) picks the release. `bun run
verify:version` keeps it equal to the version in `package.json`, so a fresh
checkout pulls the images of the code you are reading. The registry is public and
needs no `docker login`.

This variant adds one service the build variant does not have: a digest-pinned
Caddy router in front of the Control. The released Control bakes no backend URL
into its bundle and therefore calls its own origin through relative paths, which
works only if the UI and the Runtime share one origin — that is what the router
provides, and it mirrors how the applications are wired in production. What that
means in practice:

- The router is the only way to reach the Control here; the Control container
  publishes no host port of its own. Runtime, Search, Gate and Extract keep the
  ports listed under [Endpoints](#endpoints).
- Nothing is built, so this path needs no build toolchain and no compile-time
  memory; the disk figure in the table above is the pulled images themselves.
- Flow changes still apply without a rebuild: the Runtime watches `FLOWS_DIR` in
  every mode, so editing a file in [`flows/`](flows/) is picked up on its own. A
  Control UI change is not, because the released image serves a built page — that
  is what Option B is for.

## Option B — build from source

From the repository root:

```bash
docker compose --env-file deploy/examples/.env.example -f deploy/examples/compose.yaml up --build -d
docker compose --env-file deploy/examples/.env.example -f deploy/examples/compose.yaml ps
```

## Endpoints

Wait until all application health checks are healthy. Endpoints:

- Control: <http://localhost:3001> — in Option A this URL is the router, which forwards the UI and the Runtime API to the right service
- Runtime readiness: <http://localhost:3000/health/ready>
- Search health: <http://localhost:3002/health>
- Gate readiness: <http://localhost:3003/readyz>
- Extract health: <http://localhost:3004/health>, upload UI at <http://localhost:3004/>

Run the synthetic flow through Runtime's OpenAI-compatible endpoint:

```bash
curl --fail-with-body http://localhost:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"quickstart","messages":[{"role":"user","content":"Confirm the quickstart."}]}'
```

The response comes from `model-mock.py`; it demonstrates the Runtime-to-model wiring, not model
quality. The health checks confirm that Search, Gate and Extract start, but this curl does not
exercise those services. Extract runs against the same mock as a vision model, so a conversion
returns deterministic placeholder text rather than real extraction output. Search is not empty:
while the stack starts, a `seed` service posts [`demo/handbook.md`](demo/handbook.md) into the
`handbook` collection that the retrieval flows read, which is what
[Grounded retrieval](#grounded-retrieval-end-to-end) runs. Its embeddings are deterministic
three-dimensional smoke vectors, so the ordering there proves the path and nothing about relevance.
Gate is fully wired as well - the next section runs it end to end.

## Three claims, five minutes

`./tour.sh` walks this stack and shows the three things ATF's pitch rests on: the prompt as a model
received it with `[[PII:…]]` where an address and an IBAN were, while the caller's answer still has
both; one tool call approved by hand and a second left unanswered until it is recorded as rejected;
and a decision receipt that the shipped verifier accepts, then rejects after one byte of the signed
payload changes. It prints the evidence for each and exits non-zero if any of them is missing.

```bash
ATF_APPROVAL_TIMEOUT_MS=15000 docker compose --env-file .env.example -f compose.yaml up -d --wait
./tour.sh --runtime http://127.0.0.1:3000 --approval-window 15000
```

[TOUR.md](TOUR.md) explains what each step proves, what the throwaway signing key means for the
receipts, and where this stack is deliberately weaker than a production deployment.

## Governed tool use, end to end

The stack registers Gate as an MCP server ([`flows/mcp.yaml`](flows/mcp.yaml)) and gives it two
tools over the demo database ([`gate/config.yaml`](gate/config.yaml)):

| Tool | Access | What it does |
| --- | --- | --- |
| `gate/ticket_lookup` | read | `SELECT` of the caller's own rows in `demo.tickets` |
| `gate/ticket_create` | write | `INSERT` of one row, after a person approves the call |

Two details make this more than an echo. Both statements take the owner from the verified Gate
token rather than from the model, and [`demo/init.sql`](demo/init.sql) fills the table for two
different people, so a run returns a subset and you can check that the filter held - six of the ten
rows belong to the identity behind the token and four to someone the caller never sees. The mock
model is scripted to call whichever tools a flow offers, one per round in declaration order, with
arguments taken from each tool's own schema; that script is not intelligence, it is what lets this
path run with no model credentials while the execution, the filter, the approval and the write stay
real.

Flow `tool-use-with-approval` runs the lookup through the model and files the write as a declared
`tool` node, which is the shape `APPROVAL_REQUIRE_TOOLS` binds. The chat request stays open while
the write waits, so leave it running and decide from another terminal:

```bash
# 1. Answers, calls the lookup tool, then blocks on the write.
curl -s http://localhost:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"tool-use-with-approval","messages":[{"role":"user","content":"Printer jams again on the third floor."}]}'

# 2. While step 1 is open: the pending call, with the arguments a person is being asked about.
#    Its `pending[].id` is the `<id>` below.
curl -s http://localhost:3000/monitoring/approvals

# 3. Decide it. `true` runs the write, `false` skips it - in both cases the flow finishes.
curl -s -X POST http://localhost:3000/monitoring/approvals/<id> \
  -H 'Content-Type: application/json' \
  -d '{"approved": true, "reason": "quickstart walkthrough", "by": "anja.weiss"}'

# 4. Only after an approval does the row exist.
docker compose --env-file deploy/examples/.env.example -f deploy/examples/compose.yaml \
  exec postgres psql -U atf -d atf_search -c \
  'select id, owner, subject, status from demo.tickets order by id desc limit 3'
```

Two things about that reply are worth knowing before you judge it. The text it carries was written
by the first node, before the write was attempted - the flow's answer is not re-generated once you
decide, so the database is the place to look, which is why step 4 exists. The inline approval card
in it does update: reloading `GET /monitoring/approvals/<id>/widget` shows the decision instead of
the two buttons. The same inbox is in the Control UI under Reviewers, which is the path a person
actually uses, and leaving a request undecided rejects it when `APPROVAL_TIMEOUT_MS` elapses -
silence never becomes an action.

`demo/init.sql` runs when the PostgreSQL volume is created, so a stack that predates it needs one
`down --volumes` (see [Stop](#stop)) before the lookup returns rows.

## Grounded retrieval, end to end

Flow `grounded-retrieval` answers from what Search returns rather than from the mock's canned line,
so it shows the retrieval and citation path:

```bash
curl --fail-with-body http://localhost:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"grounded-retrieval","messages":[{"role":"user","content":"When does the support desk answer?"}]}'
```

The reply names the opening hours written in `demo/handbook.md` and cites them as `[1]`, and the
`sources` array carries the same document under its reference - so the citation traces back to the
file the seed service posted, without a model that understands anything.

Two parts of that are worth naming. The Runtime reaches Search over Search's own MCP endpoint,
registered under the name `vectorsearch` in [`flows/mcp.yaml`](flows/mcp.yaml): a `ragProfiles` plan
compiles into `vectorsearch/search` calls, so that name is not a choice. And the mock model replies
with one fixed sentence whenever the Runtime hands it retrieved sources - the quote shows the wiring,
not comprehension, and the ranking in front of it comes from a three-dimensional test embedding, so
its scores say nothing about relevance. Replace the mock with a real model and Search with a real
embedding model and this flow file stays as it is.

The `seed` service runs once per start, and re-posting the same file replaces the document instead of
duplicating it, so starting the stack twice is harmless. `down --volumes` empties Search, and the
next start seeds it again.

## Stop

Repeat the `-f` flags you started with, otherwise Compose treats the stack as a
different project:

```bash
docker compose --env-file deploy/examples/.env.example -f deploy/examples/compose.yaml down
docker compose --env-file deploy/examples/.env.example -f deploy/examples/compose.yaml \
  -f deploy/examples/compose.images.yaml down
```

To also delete the local PostgreSQL volume, add `--volumes` to the matching command.

## Security boundary

All APIs are unauthenticated and intended for loopback development only. The host ports default to local developer ports but Docker publishes them on available host interfaces. Do not run this stack on an untrusted network or internet-accessible machine. Production and customer deployments must use separately reviewed images, authentication, authorization, tenant isolation, TLS, secret management, backups, observability, and immutable image digests.

The Gate in this stack authenticates with `auth.mode: static`: one bearer token in
[`gate/config.yaml`](gate/config.yaml), mapped to one identity (`anja.weiss`), so the demo tools
can filter rows by owner without an identity provider. That mode exists for development and the
Gate's own production gate rejects it - in a real deployment the identity arrives on a verified
token and `tools` read it from there. The token, the demo password and the demo rows are invented
and must never appear in a deployment.

One consequence to keep in mind while using it: every caller of this stack presents the same token,
so everyone here *is* `anja.weiss`, and the filter proves the mechanism rather than a boundary
between two live users. Both services say so at startup - the Gate warns that `auth.mode: static`
cannot enforce per-user identity, and the Runtime warns that a flow declaring `dataClasses:
[personal]` reaches the Gate as an anonymous service call because `flows/mcp.yaml` sends a
configured header instead of the caller's own bearer. Both warnings are correct, and both go away
the same way: `AUTHN_MODE=oidc` on the Runtime, `forwardAuthToken: true` on the MCP server, and
`auth.mode: oauth` on the Gate - the tools keep working unchanged, because they read
`:ctx.username` either way.

Decision receipts are signed with the key the `receipt-key` service writes into a volume the first
time the stack starts. That key is unauthenticated, world-readable inside its volume (the writing
service runs as root, the published Runtime image reads it as another uid), never rotated, and
deleted by `down --volumes`, after which the receipts of the previous stack stop verifying -
correct behaviour, not a bug, and the reason [the tour](TOUR.md) calls it a throwaway. A real instance takes `RECEIPT_SIGNING_KEY`
from a secret store and rotates it on a schedule; see
[`../../docs/runbooks/key-rotation.md`](../../docs/runbooks/key-rotation.md).
