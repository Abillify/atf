# Blueprint — Gate as a governed front door for an MCP server

A Gate configuration that sits between MCP clients (coding agents, desktop assistants) and an
MCP server you already run. The clients see the same tools, under a prefix; every call now
carries a verified identity and passes a scope check, a policy decision and — for writes — a
human approval, and it is audited.

This is the tool half of the trust-proxy mode. The model half is the Runtime's
`PROXY_MODELS` with `/v1/messages` and `/v1/chat/completions`; see
[`docs/TRUST-PROXY.md`](../../../docs/TRUST-PROXY.md).

| Setting | Why |
| --- | --- |
| `mcpServers[].requiredScopes: [crm:use]` | A caller without the scope neither sees nor calls an imported tool. |
| `policies.defaultEffect: deny` + allow `crm_*` reads | A tool the downstream server adds later is denied until someone allows it. |
| approval for `crm_*` writes, `requireDifferentApprover: true` | An agent has no person in front of it; it must not approve its own request. |
| `outbound.allowedHosts` = the downstream host | Imported definitions cannot point the Gate anywhere else. |
| Gate's own downstream `token` | The caller's token is never passed through (confused deputy). |
| `perIdentity` rate limit | One runaway agent cannot use up the downstream server. |

Imported tools keep the downstream server's annotations (`readOnlyHint`, `destructiveHint`,
…). A tool is `read` only when the downstream says `readOnlyHint: true`; everything else is
`write`.

## Prerequisites

- An MCP server reachable over Streamable HTTP. For a server inside your network set
  `allowPrivateAddress: true` on it — RFC 1918 and unique-local addresses for that exact host
  only; loopback and metadata addresses stay refused.
- An identity provider for real use (`mode: oauth`). The shipped static token is refused by the
  production gate.

## Variables

| Variable | Used for | Required for real use |
| --- | --- | --- |
| `ATF_BLUEPRINT_MCP_URL` | downstream MCP endpoint | yes |
| `ATF_BLUEPRINT_MCP_HOST` | the same host, for the outbound allow-list | yes |
| `ATF_BLUEPRINT_MCP_DOWNSTREAM_TOKEN` | the Gate's credential at the downstream server | yes |
| `ATF_BLUEPRINT_MCP_TOKEN` | static development token | dev only |
| `ATF_BLUEPRINT_MCP_APPROVAL_SECRET` | signs approval states (≥16 chars) | yes |
| `ATF_BLUEPRINT_OIDC_DISCOVERY_URL`, `ATF_BLUEPRINT_OIDC_ISSUER` | oauth block | yes, with oauth |

Every secret can also be mounted as a file: set `<NAME>_FILE` instead of `<NAME>` (ADR 0040).

## Check and start

```bash
printf 'MCPGATE_ENV=development\n' > /tmp/mcp-proxy.env
bun run atf-doctor --service gate \
  --config-dir "$PWD/deploy/blueprints/gate-mcp-proxy" --env-file /tmp/mcp-proxy.env
```

Expected offline: no fatal findings and five warnings — static auth, empty `server.allowedHosts`,
`trustProxy` hop count, in-memory rate limit, and no pinned imported tool. Each is a property of
a development blueprint; the last one is the first to fix (see below).

Start the Gate with `MCPGATE_CONFIG_DIR` pointing here, then point the client's MCP
configuration at `http://<gate>:3200/mcp` with the bearer token.

## What is missing on purpose

- **Pins.** `overrides[].pin` fixes a downstream tool definition by digest, so a changed
  description — a classic tool-poisoning vector — hides the tool instead of reaching the model.
  Pins depend on the server you connect; compute them once and add them.
- **Tenant isolation.** One organisation, one downstream server. Enable it before two tenants
  share the Gate.
- **Monitoring UI.** Off; enable it only with `monitoring.oidc.requiredGroups` set.
