# Deployment blueprints

Three reusable starting points, each one a single service's configuration written so that
the **non-obvious settings explain themselves**. They are deliberately neutral: no customer,
host, collection or domain prompt text. What they carry is structure and reasoning — the
things that are expensive to rediscover — while every name is a placeholder you replace.

| Blueprint | Service | What it shows |
| --- | --- | --- |
| [`research-assistant/`](research-assistant/) | Runtime (flow) | A bounded research loop over Search, an independent verifier, and a sources section repaired by code instead of requested in a prompt. |
| [`gate-sql-profile/`](gate-sql-profile/) | Gate | A domain database as three MCP tools: two reads and one write behind a human approval, identity bound with `:ctx.*`, conditional redaction, signed cursor pagination. |
| [`dms-mirror/`](dms-mirror/) | Outpost | A file share and an S3 bucket mirrored into one Extract collection, with ACLs, delete thresholds and secrets kept out of the file. |

## How these differ from `../examples/`

`../examples/` is the quickstart: files that work as shipped, minimal commentary, meant to be
run unchanged. These are the opposite — files meant to be **cut into**. They are less
complete on purpose: one flow, three tools, two sources. Each README ends with what is
missing and why, so a reader knows which gaps are decisions and which are omissions.

Read them in this order if you are building your first deployment: the quickstart in
`../examples/` first (get something running), then the matching blueprint for the piece you
are about to write yourself.

## Validating them

The flow and the gate config both check offline, with no services running and no secrets set —
that is a property worth keeping in your own files, and it is why every interpolated value in
`gate-sql-profile/config.yaml` carries a `:-` default:

```bash
# Flow — prints "0 warning(s)"; a missing prompt include would warn instead of failing.
cd apps/runtime
bun run scripts/cli.ts validate ../../deploy/blueprints/research-assistant/ --require-version

# Gate config — absolute path: --config-dir resolves against apps/gate.
cd ../..
printf 'MCPGATE_ENV=development\n' > /tmp/blueprint-gate.env
bun run atf-doctor --service gate \
  --config-dir "$PWD/deploy/blueprints/gate-sql-profile" \
  --env-file /tmp/blueprint-gate.env
```

Expected there: no fatal findings, five warnings, all of them properties of a development
blueprint — listed with their cause in
[`gate-sql-profile/README.md`](gate-sql-profile/README.md). The Outpost has no offline check;
`atf-outpost once` is the equivalent and exits `78` on an invalid config.

The flow is validated in CI alongside the quickstart flows
(`.github/workflows/ci.yml`, step *Flow examples validate*).

## What is intentionally not here

- **No credentials, hostnames or customer names.** Not redacted ones, not fictional ones that
  look real. Where a value must exist for a file to load, it is a placeholder that is
  obviously one (`outbound-disabled.invalid`, `replace-me`, `blueprint-*-change-me`).
- **No tenant isolation and no OAuth in the gate blueprint.** Both are required in production
  and both are documented as to-dos there rather than shipped half-configured.
- **No domain prompts.** The research prompts describe what a good research step does. Your
  quality bar belongs on top of them, in your own file — a prompt that encodes one
  department's case handling is not a template.
- **No compose files.** These are configuration, not a stack. Combine them with
  `../examples/compose.yaml` or with Helm in `../helm/`.
