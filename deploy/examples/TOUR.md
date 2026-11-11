# The five minute trust tour

ATF's pitch rests on three statements that are easy to write down and hard to see:

1. personal data is replaced by a placeholder **before** a model is called, and the caller still
   gets the real value back;
2. a tool that needs a person **stops** until that person answers, and an unanswered request is a
   rejection, not a slow approval;
3. what happened is written down as a signed receipt that a third party can check **offline** — and
   that stops checking the moment one byte of it is changed.

[`tour.sh`](tour.sh) demonstrates all three against the local
[quickstart stack](README.md#local-unauthenticated-quickstart) and prints the evidence rather than
asking you to believe it. Two minutes of machine time, five if you read what it prints.

| Step | What you see | Where it comes from |
| --- | --- | --- |
| 1 | The prompt as the model received it, with `[[PII:…]]` where an address and an IBAN were; the answer the caller received with both in cleartext | flow [`07-model-echo.yaml`](flows/07-model-echo.yaml), the Runtime's sealed Debug_Trace |
| 2 | One `gate/ticket_create` call approved by hand and finished; a second one left alone until its window closed, recorded as `approved: false, timedOut: true` | flow [`04-tool-use-with-approval.yaml`](flows/04-tool-use-with-approval.yaml) |
| 3 | `atf-verify` exits 0 on the receipt, exits 1 on a copy with one byte of the signed payload changed | `X-ATF-Receipt`, `GET /v1/receipts/<id>`, `/.well-known/atf-receipt-jwks.json` |

## 0. Start the stack with a short approval window

```bash
cd deploy/examples
ATF_APPROVAL_TIMEOUT_MS=15000 docker compose --env-file .env.example -f compose.yaml up -d --wait
```

The default window is ten minutes ([`.env.example`](.env.example)), which is right for a reviewer
and wrong for a demonstration: step 2b deliberately leaves a request unanswered, and nobody wants
to watch a terminal do nothing for ten minutes. 15 seconds shows the same rule. Pass the same
number to the tour if you choose a different one.

The tour only talks HTTP to the Runtime, so either start option above works for it, and it needs no
build toolchain of its own — but it does need this checkout, because step 3 runs the verifier from
`scripts/atf-verify.ts`.

## 1. Run the tour

```bash
./tour.sh --runtime http://127.0.0.1:3000 --approval-window 15000
```

`curl` and `bun` on the host are the only requirements — `bun` because the offline verification in
step 3 is the shipped verifier itself, run from this checkout
(`bun run scripts/atf-verify.ts`, documented in the [root README](../../README.md)). Add `--keep`
to keep every downloaded trace, receipt and the tampered copy in a directory it names at the end,
and `--help` for the options.

Exit codes: `0` every claim was shown, `1` a step did not behave as documented — the message names
the value that was missing, `2` the tour was called wrongly or the stack does not answer. It starts
by reading `GET /monitoring/posture` and refuses to continue if `pii_vault`, `approval_gate` or
`receipts` is not `ok`, so a misconfigured stack fails in the first second instead of half way
through a demo.

Step 2 looks only at approvals this run created, so running the tour twice against the same stack
is honest the second time too: a leftover request from an earlier run can neither be approved by
accident nor pass as the request that just timed out.

The Quickstart stack job in CI runs this exact script after its endpoint smokes. Documentation that
executes is gated like documentation that does not, so the tour failing is a build failure rather
than a surprise in front of an audience.

## What each step actually shows

### 1. Two versions of one conversation

The message is ordinary text with an e-mail address and an IBAN in it. It goes to flow
`model-echo`, which is the one flow in [`flows/`](flows/) that names a model: the mock's `echo`
model replies with the messages it was handed, so its answer is a report about its own input
instead of an opinion.

The interesting part is that the two texts differ. The Runtime's Debug_Trace
(`GET /monitoring/debug/<X-Execution-Id>`) records what the node was given, and there the address
reads `[[PII:4aa332177d8cebc0]]`; the answer that comes back to the caller contains
`maria.huber@example.com` again. The same request therefore proves both halves: tokenisation before
the provider, substitution on the way out.

The tour asserts exactly that: a `[[PII:` marker must be in the trace, the cleartext must not be,
and the cleartext must be in the answer.

### 2. A person who answers, and a person who does not

Both runs use `tool-use-with-approval`, whose last node calls `gate/ticket_create` — the one tool
`APPROVAL_REQUIRE_TOOLS` binds in this stack. The run parks, and the pending entry shows the tool
and the arguments a human is being asked about.

The first is approved with `POST /monitoring/approvals/<id>` and finishes. The second is left
alone: when the window closes the entry is recorded as `approved: false, timedOut: true` and the
write never happens. That is the half of the rule that is usually missing — silence must not become
an action.

Decide from the UI instead if you prefer: the same inbox is under Reviewers in Control
(<http://localhost:3001>).

### 3. A receipt that breaks when you edit it

Step 1's response carries a receipt id in `X-ATF-Receipt`. The tour fetches the receipt and the
Runtime's published verification key, then runs the shipped verifier twice:

```bash
bun run scripts/atf-verify.ts --receipt receipt.json --jwks jwks.json          # exit 0
bun run scripts/atf-verify.ts --receipt receipt-tampered.json --jwks jwks.json # exit 1
```

Nothing in that check contacts the server. The tampered copy is a real tampering, not a cosmetic
one: one byte inside the COSE payload is flipped, which changes what was signed while leaving the
envelope well-formed. The tour changes `cose_base64` and not the `payload` next to it on purpose —
the verifier reads the COSE bytes, so editing the human-readable copy alone would prove nothing and
would teach the wrong lesson.

## What the tour deliberately does not show

- **The mock is scripted.** `model-mock.py` repeats prompts and calls the tools a flow offers, in
  declaration order. Nothing here demonstrates model quality; what it buys is that these paths run
  with no model credentials while the execution, the approval and the signature stay real.
- **State is in memory.** This stack sets no `DATABASE_URL`, so the vault mapping and the receipts
  live in the Runtime process and are gone on restart; that is also why no
  `PII_VAULT_ENCRYPTION_KEY` is configured. With a database, that key stops being optional.
- **The signing key is a throwaway.** A one-shot service writes one Ed25519 seed into a volume on
  the first start and reuses it afterwards. It is unauthenticated, never rotated, and deleted by
  `down --volumes` — after which every receipt of the old stack fails to verify. It is also
  readable by every user in the container, because the service that writes it runs as root while
  the published Runtime image reads it as an unprivileged uid; a file mode that would stop that
  would leave the Runtime without a key. That is acceptable for a key inside a volume nothing else
  mounts, and it is the plainest reason this is a demo key. Real deployments take the seed from a
  secret store and rotate it; see [the key rotation runbook](../../docs/runbooks/key-rotation.md).
- **Monitoring is open here.** The Debug_Trace in step 1 is readable because the quickstart sets
  `MONITORING_AUTH: "false"`. Everywhere else it is a monitoring-scope endpoint, and the trace is
  sealed for a reason.
- **The vault covers what its detectors recognise.** This stack enables
  `email,phone,iban,card`; free-form facts about a person need a model-based detector
  ([capabilities](../../docs/CAPABILITIES.md)).

## If a step fails

| Message | Cause |
| --- | --- |
| `pii_vault is not active` / `approval_gate …` / `receipts …` | The stack was started with a different environment. `docker compose … up -d --wait` with the flags above, and note that changes to `compose.yaml` need the container recreated. |
| `no pending approval appeared` | The flow ran straight through: `APPROVAL_REQUIRE_TOOLS` must name `gate/ticket_create`, the tool ID as the flow declares it (`<mcp server>/<gate tool>` from [`flows/mcp.yaml`](flows/mcp.yaml)), and `AUTHZ_ENABLED` has to stay on. |
| `did not expire within …` | The stack is still on the ten minute default. Restart with `ATF_APPROVAL_TIMEOUT_MS=15000` and pass `--approval-window 15000`. |
| `no placeholder in the Debug_Trace` | The vault is off, or the message contains nothing its detectors recognise. The demo text is chosen so that it does. |
| `atf-verify rejected a genuine receipt` | The volume's key changed underneath the stored receipts — expected after `down --volumes`, since the receipt and the key no longer belong together. |

## Where to go next

- [Quickstart README](README.md) — the stack, its endpoints, the governed tool call and the
  retrieval run in full.
- [Flow examples](flows/README.md) — what each example flow is there to demonstrate.
- [Capabilities](../../docs/CAPABILITIES.md) — which control exists where, including what the
  quickstart leaves out.
- [EU AI Act notes](../../docs/EU-AI-ACT.md) — which of these artefacts answer which question.
