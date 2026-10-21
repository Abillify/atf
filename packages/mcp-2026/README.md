# @atf/mcp-2026

Package `1.0.0`, protocol `2026-07-28`. The shared core of the stateless MCP 2026-07-28
HTTP profile, used by the Gate server, the Search server and the Runtime client so the three
endpoints speak byte-identical framing. It holds the protocol constant, header names,
JSON-RPC error codes, request validation, offset pagination, the result envelope, request
metadata merging and deadline signals.

Deliberate differences between the endpoints stay at the call sites (the Gate catalog of
resources, prompts, skills, apps, tasks and approvals; Search's transaction-token extension and
authorization filtering; the exact wire error texts that tests assert). The core exposes them as
parameters instead of folding them away.

## Exports

| Export | Purpose |
| --- | --- |
| `MCP_2026_PROTOCOL_VERSION`, `PROTOCOL_META_KEY` | Protocol version string and the `_meta` member that carries it |
| `MCP_PROTOCOL_VERSION_HEADER`, `MCP_METHOD_HEADER`, `MCP_NAME_HEADER`, `MCP_REQUEST_STATE_HEADER`, `MCP_TRANSACTION_ID_HEADER`, `MCP_DEADLINE_HEADER` | Header names |
| `JSONRPC_*` | Error codes (`HEADER_MISMATCH` −32020, `UNSUPPORTED_PROTOCOL_VERSION` −32022, `NOT_FOUND` −32004, `TRANSACTION_ERROR` −32001, `DEADLINE_EXCEEDED` −32008, `SERVICE_UNAVAILABLE` −32003 and the standard −32600/−32601/−32602/−32603) |
| `jsonRpcErrorBody` | The error envelope every endpoint emits (`id ?? null`) |
| `validateStatelessRequest`, `StatelessValidationOptions` | Header and body binding, in a fixed order: `_meta` protocol vs header, supported version, method header, name-keyed methods, approval request state |
| `HeaderReader`, `normalizeHeaderValue` | Header access; blank values count as absent |
| `paginate`, `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE`, `PaginateOptions` | Offset pagination with numeric string cursors (default page 100, maximum 1000) |
| `statelessEnvelope` | Result envelope: `resultType: "complete"`, `ttlMs: 0`, `cacheScope: "request"`, `_meta.serverInfo` |
| `requestMetadata` | Merges body `_meta`, `params._meta` and the transport headers (`traceparent`, `tracestate`, `Mcp-Transaction-Id` → `transaction/id`, `Mcp-Deadline` → `deadlineAt`) |
| `deadlineSignal` | Turns deadline metadata into an `AbortSignal` that fires at the deadline; throws on unparseable values |
| `clientRequestMeta`, `statelessRequestBody` | Client side: mirror metadata into headers and build the JSON-RPC body with the protocol version stamped in |

## Configuration points per endpoint

| Option | Gate | Search |
| --- | --- | --- |
| `requireJsonrpc20` | off | on |
| `namedMethods` (`params.name` must equal `Mcp-Name`) | tools, prompts, skills, apps | `tools/call` |
| `resourcesReadKeyed` (`params.uri` must equal `Mcp-Name`) | on | off |
| `approvalsResolveKeyed` (`params.requestState` must equal `Mcp-Request-State`) | on | off |
| `paginate` error factories | plain `Error` | typed `TransactionError` |

## Usage

```ts
import {
  jsonRpcErrorBody,
  paginate,
  statelessEnvelope,
  validateStatelessRequest,
} from "@atf/mcp-2026";

const checked = validateStatelessRequest(
  (name) => req.header(name),
  req.body,
  { requireJsonrpc20: true, namedMethods: ["tools/call"] },
);
if (!checked.ok) {
  res.status(400).json(jsonRpcErrorBody(req.body?.id, checked.code, checked.message));
} else if (checked.method === "tools/list") {
  const page = paginate(tools, checked.params);
  res.json({
    jsonrpc: "2.0",
    id: req.body.id,
    result: statelessEnvelope(serverInfo, { tools: page.items, nextCursor: page.nextCursor }),
  });
}
```

## Compatibility

Imported by `apps/gate`, `apps/runtime` and `apps/search`. Changing a header name, error code or
envelope field changes the wire for all three, so the package version moves with it.

## Tests

```bash
bun run --filter @atf/mcp-2026 test
```
