# Trust-proxy mode

Put ATF in front of AI clients your people already use — a coding agent, a desktop assistant, a
chat frontend — without writing a flow per use case. The client changes its base URL and
nothing else. From then on its model traffic runs through the Runtime's controls, and its tool
traffic, if you route it through a Gate, through the Gate's.

Design and trade-offs: [ADR 0038](adr/0038-trust-proxy-mode.md). Status: **experimental**
(see [STABILITY.md](STABILITY.md)).

## What it is

| Part | Where | What it does |
| --- | --- | --- |
| `PROXY_MODELS` | Runtime | Maps model names a client sends (`claude-*`, `gpt-4.1`) to a configured provider instance and upstream model. |
| Pass-through flow | Runtime | A built-in flow per mapping (`__proxy__.<n>`, version `1`): one `llm` node, the client's tools passed through, no system prompt of its own. |
| `POST /v1/messages` | Runtime | The Anthropic Messages API, translated onto the unchanged chat pipeline. `POST /v1/chat/completions` serves OpenAI-compatible clients. |
| `ATF_PRESET=trust-proxy` | Runtime | Defaults for the gateway controls (below). |
| [`gate-mcp-proxy`](../deploy/blueprints/gate-mcp-proxy/) | Gate | An existing MCP server behind the Gate: scoped, policy-checked, approval for writes. |

**Precedence.** A real flow with the requested name always wins over a `PROXY_MODELS` entry. You
can add proxy mappings next to existing flows; no name changes meaning.

## Controls that apply

Proxy traffic is flow traffic, so the engine applies what it applies to every flow:

- input and output guardrails, admission, budgets and rate limits;
- the PII vault: personal data in the conversation becomes typed placeholders
  (`[[PII:EMAIL:…]]`) before the provider call and is restored in the answer;
- decision receipts (with `DECISION_RECEIPTS_ENABLED` and `RECEIPT_SIGNING_KEY`), metering, the
  debug trace — `flow_id` is `__proxy__.<n>`, the join key for "everything that came through the
  gateway";
- the AI disclosure header.

## Controls that do not apply

- **Retrieval and server-side tools.** The pass-through flow has no retrieval node and calls no
  tools of its own. Tools the client declares are passed to the model and handed back to the
  client; the client runs them.
- **Flow-level compliance rules.** The pass-through flow declares no `dataClasses`, so
  data-class rules in `compliance-policy.yaml` do not match it. Provider allow/block rules do.
- **Tool results the client sends back.** They arrive as messages and are tokenized like any
  inbound message. Nothing else of the client's local tool execution is visible to ATF.

## Set it up

### 1. Providers and mappings

```bash
PROVIDERS='[{"name":"anthropic-main","protocol":"anthropic","apiKey":"…"},
            {"name":"openai-main","protocol":"openai","apiKey":"…"}]'
PROXY_MODELS='[{"match":"claude-*","provider":"anthropic-main","model":"claude-sonnet-4-5"},
               {"match":"gpt-4.1","provider":"openai-main","model":"gpt-4.1"}]'
```

`match` is an exact name or a prefix ending in `*`; the first matching entry wins. Each
`provider` must be a `PROVIDERS` name — startup fails otherwise. The client sees the model name
it asked for in every response; the debug trace and receipts carry the real provider and model.

Only exact names appear in `GET /v1/models`; a pattern is not a model.

### 2. Preset

```bash
ATF_PRESET=trust-proxy
```

It sets, for variables you have not set yourself: `PII_VAULT_ENABLED=true`,
`INPUT_GUARDRAILS_ENABLED=true` with `INPUT_GUARDRAIL_MODE=flag` (a heuristic should not stop a
coding agent; the flag lands in the audit trail), `OUTPUT_GUARDRAILS_ENABLED=true`,
`CLIENT_TOOLS_ENABLED=true`, `IDEMPOTENCY_ENABLED=true`, `RETENTION_ENABLED=true` and
`AI_DISCLOSURE=header`. It does not switch the operational profile (`ATF_PROFILE=production`)
and carries no keys; receipts need `DECISION_RECEIPTS_ENABLED=true` plus `RECEIPT_SIGNING_KEY`
(or `RECEIPT_SIGNING_KEY_FILE`).

### 3. Point the client at ATF

Set the client's base URL to the Runtime and give it a credential the Runtime accepts:

- **OpenAI-compatible clients:** base URL `https://<runtime>/v1`, the credential as
  `Authorization: Bearer`.
- **Anthropic-compatible clients:** base URL `https://<runtime>` (the client appends
  `/v1/messages`); the credential as `x-api-key` or `Authorization: Bearer`. Both headers with
  different values are refused.

Which setting or environment variable a particular product reads for its base URL is the
product's documentation, not this one's.

The credential is whatever `AUTHN_MODE` accepts: an OIDC access token, or a managed API key
(`aip-…`, `POST /admin/tenants/:id/keys`) where API keys are allowed.

### 4. Tools (optional)

To govern the client's tools as well, put the MCP servers it uses behind a Gate and point the
client's MCP configuration at the Gate. Start from
[`deploy/blueprints/gate-mcp-proxy/`](../deploy/blueprints/gate-mcp-proxy/).

## `/v1/messages` in detail

Pinned to the Messages API as documented for `anthropic-version: 2023-06-01`.

| Supported | Notes |
| --- | --- |
| `system` (string or text blocks), `messages` | `text`, `image` (base64 or URL), `tool_use`, `tool_result` (text) |
| `max_tokens` (required), `temperature`, `top_p`, `stop_sequences` | |
| `tools`, `tool_choice` (`auto`, `any`, `tool`, `none`) | client tools; passed to the model, returned as `tool_use` |
| `stream` | `message_start`, `ping`, `content_block_start/delta/stop`, `message_delta`, `message_stop`; tool arguments as `input_json_delta` |

Refused with a 400 that names the field — never dropped silently:

`thinking`, `cache_control` (anywhere), `top_k`, `metadata`, `service_tier`, `container`,
`mcp_servers`, server tools (`tools[].type` other than `custom`),
`tool_choice.disable_parallel_tool_use`, and any field the API does not define.

Errors use the Anthropic envelope `{"type":"error","error":{"type","message"}}`; the HTTP status
of the pipeline is kept (`invalid_request_error`, `authentication_error`, `permission_error`,
`not_found_error`, `rate_limit_error`, `overloaded_error`, `api_error`).

`/v1/messages` serves flows as well: a client that names a real flow runs that flow.

## What you can prove afterwards

- Every proxied request has a debug trace with `flow_id: __proxy__.<n>` and the upstream model.
- With receipts on, `GET /v1/receipts?execution_id=…` returns the signed receipt; it records
  the PII tokenization counts, never the values, and verifies offline with `atf-verify`.
- With the PII vault on, the provider only ever saw placeholders for the detected values. Values
  a detector did not recognise were sent as they were — choose the detector set for your data
  (see [CAPABILITIES.md](CAPABILITIES.md#privacy-and-the-pii-vault)).

## Limits

- Experimental: field coverage of `/v1/messages` may change in a minor release.
- No prompt caching, no extended thinking, no `count_tokens` endpoint.
- The client's own model name is echoed; a substitution is visible only in traces and receipts.
