# MCP 2026 context, capability, and evidence layer

This reference describes how Runtime uses MCP 2026-07-28 for more than plain tool calls. It
applies to HTTP servers configured with `profile: "2026-07-28"`. The SDK profile `2025` remains
tool-compatible but does not provide the native context and task APIs described here.

## Scope

For MCP 2026 servers the MCP wrapper provides:

| Feature | Wrapper operation | Purpose |
|---|---|---|
| Tools | `listTools`, `callTool` | Execute actions and queries |
| Resources | `listResources`, `listResourceTemplates`, `readResource` | Discover and read authorised data and contextual content |
| Prompts | `listPrompts`, `getPrompt` | Load server-defined, parameterised working instructions |
| Tasks | `getTask`, `updateTask`, `cancelTask` | Control long-running server work through an explicit handle |
| Instructions | `getInstructions` | Supply server hints for capability selection |

Listings use cursor pagination. The native client honours the MCP 2026 cache hints `ttlMs` and
`cacheScope`. With `forwardAuthToken: true`, resource, prompt, and task calls run under the
caller's bearer token, exactly as tool calls do.

## Semantic capability selection

`McpCapabilityIndex` extends the existing semantic tool selection. For every connected server it
embeds tools, resources, resource templates, prompts, and server instructions.
`selectCapabilities()` can rank all of them together against a user request.

The former name `ToolIndex` remains as a compatible alias. LLM nodes with
`config.toolSelection.mode: semantic` continue to use the node's tool pool; the extended
capabilities are discoverable for orchestration and future context selection. Servers without
resources or prompts remain tool-only automatically. A discovery failure never blocks tool
selection.

## Evidence grounding with `toolContext`

`toolContext` is node configuration for `llm` nodes and for deterministic `tool` nodes. It calls
the configured retrieval tool before or after the domain tool. The default is
`vectorsearch/retrieve_evidence`.

```yaml
config:
  toolContext:
    server: vectorsearch
    tool: retrieve_evidence
    pre:
      match: ["worktime/vacation_create"]
      queryTemplate: "Rules for {{tool}} with {{args}}"
      handleArgument: evidenceHandle
      required: true
    post:
      match: ["parking/*", "worktime/*"]
      queryTemplate: >-
        Evidence for {{tool}} with arguments {{args}} and result {{result}}
      required: false
      appendEvidence: true
      maxResultChars: 6000
```

### Fields

- `server` / `tool`: MCP server and retrieval tool. Defaults are `vectorsearch` and
  `retrieve_evidence`.
- `pre` / `post`: optional stages before and after the domain tool.
- `match`: tool references, bare names, `server/*`, or `*`.
- `queryTemplate`: required per stage. Permitted placeholders: `{{tool}}`, `{{args}}`,
  `{{result}}`.
- `arguments`: static additional arguments for the retrieval call, for example a collection the
  server permits.
- `handleArgument`: injects only a retrieved evidence handle into the domain tool's arguments.
  Free retrieval text is never passed through as a domain tool argument.
- `required`: `true` makes retrieval and handle failures fail closed; `false` lets the domain
  action proceed without evidence.
- `appendEvidence`: for `post`, appends the evidence result to the tool result.
- `maxResultChars`: bounds the serialised domain response inside the post-retrieval query.
  Default 8000, minimum 256.

An evidence handle is extracted from `evidenceHandle`, `evidence_handle`, or `handle`. It is
opaque: clients and models may pass it on for provenance, but must neither guess its content nor
present it as readable evidence. With `appendEvidence: true` the model result contains
`{ result, evidence, evidenceHandle? }`; that result then passes through the tool-output injection
validator and may appear in approval, citation, and audit records.

Retrieval for the retrieval tool itself is suppressed, so no recursive call can occur.

## Tasks

An MCP 2026 server may answer a tool request with a task. Runtime offers two modes per server:

```yaml
profile: "2026-07-28"
taskPollingIntervalMs: 500
taskPollingMaxAttempts: 240
taskPollingDeadlineMs: 120000
taskMode: poll # poll (default) | handle
```

- `poll`: the client polls, within bounds, until a terminal result. This mode is compatible with
  existing synchronous agent loops.
- `handle`: the tool call returns a durable `taskId` handle. The caller then drives it with
  `getTask`, `updateTask`, or `cancelTask`.

The polling limits bound cost and waiting time. A handle is server-side state; no access tokens or
confidential arguments are stored in it, and Runtime does not persist it across process
boundaries.

## Security and operations

1. For tenant-scoped or user-scoped resources and evidence, always use `forwardAuthToken: true`
   together with server-side ACLs. A flow filter or a collection setting is not a security
   boundary.
2. Do not copy evidence into a domain server as untrusted prompt text. Prefer an explicit handle
   and server-side dereferencing.
3. Use `required: true` only when the domain action is inadmissible without evidence and Search is
   operated with high availability.
4. Honour `cacheScope: private` for user-scoped listings and resources; never share private
   discovery across servers.
5. Tool output and appended evidence remain untrusted and should be scanned for LLM injection
   with `TOOL_OUTPUT_VALIDATOR_ENABLED=true`.
6. For server-driven approvals, `requestState` and the approval token stay opaque. Evidence
   supplements the decision; it does not replace the MCP 2026 continuation.

Production flow configuration is deployment-specific and deliberately not part of this
repository. `deploy/examples/flows/` contains synthetic local flows only, with no MCP 2026
production contract. Operators must version and test MCP and assistant flows in their controlled
deployment overlay.

## Evidence hash convention

`actionContractHash` is the preferred field for the SHA-256 hash of the canonical evidence-bound
action contract. During the rolling migration, `evidenceContractHash` is sent as a compatible
alias carrying exactly the same value. `evidencePackHash` refers exclusively to the hash of the
response evidence pack returned by retrieval and must not be reused for the action contract or for
its argument binding. During the migration, MCP metadata sends both action-contract names as well
as the separate pack hash.
