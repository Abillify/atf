# Example flows

Flows are YAML graphs loaded from `FLOWS_DIR` and reloaded without a restart. They are
validated on load against `apps/runtime/schemas/flow.schema.json` plus cross-field checks that
the schema cannot express — edge reference integrity, node type and config compatibility, and
provider references resolved against the registry.

Validate offline, before deploying anything:

```bash
cd apps/runtime
bun run scripts/cli.ts validate ../../deploy/examples/flows/
```

These five are ordered by what they add. Each is safe to run; none contains credentials or
customer data.

| Flow | Demonstrates | Requires beyond the quickstart |
| --- | --- | --- |
| [`quickstart.yaml`](quickstart.yaml) | The smallest useful flow: one `llm` node | Nothing |
| [`02-routed-support.yaml`](02-routed-support.yaml) | Structured classification and deterministic conditional routing | Nothing |
| [`03-grounded-retrieval.yaml`](03-grounded-retrieval.yaml) | Declarative retrieval with hybrid search, reranking, and citations | Search reachable, and a `handbook` collection with documents |
| [`04-tool-use-with-approval.yaml`](04-tool-use-with-approval.yaml) | Agentic tool use where the write path needs a human decision | Gate with `ticket_lookup` and `ticket_create` tools; `APPROVAL_GATE_ENABLED=true` |
| [`05-support-assistant.yaml`](05-support-assistant.yaml) | The complete flow shown in the root README: classification, conditional retrieval, and an action branch | A `handbook` collection for questions; Gate with `ticket_create` for actions |

The quickstart stack starts Search and Gate but ingests no documents and declares no tools.
Flows 3 through 5 therefore validate and load, but their retrieval or tool branches are not a
successful governed demo until you add the stated collection or tools. Depending on the branch,
execution can return no context, a tool-not-found result, or an execution error; use
`quickstart.yaml` and `02-routed-support.yaml` for infrastructure-free runs.

## Things worth noticing

**No `llm` block.** None of these flows pins a provider or model. They inherit `DEFAULT_LLM`, so
the same file works against the mock model, a local server, and a hosted provider. Pin a model
per node only when the node genuinely needs a different one — the router's job is normally to
pick.

**Routing reads validated fields, not prose.** A `classifier` node writes structured JSON to
`state.classification` under its `classKey`. Edge conditions read that field. Routing therefore
does not depend on parsing an LLM's free text, which is what makes it reproducible.

**Retrieval is declared, not coded.** `config.ragProfiles` describes the sources, their limits,
whether to use hybrid search and reranking, and optionally a condition per source. Changing
retrieval strategy is a configuration change with a reviewable diff.

**Source priority is the flow's decision, not the engine's.** Set
`ragProfiles.authoritativeTagField` to the name of a `classification` field, and chunks tagged
with that field's value are marked authoritative in the fused context while differently tagged
chunks are offered only as a cross-reference. Which tag wins is domain policy, so the field name
belongs in the flow. Omit it and no source is privileged.

**Approvals are not flow configuration.** Which tools require a human decision is set by
deployment configuration (`APPROVAL_REQUIRE_TOOLS`) or centrally in `compliance-policy.yaml`, not
inside the flow. That is deliberate: a reviewer requirement that a flow author could delete by
editing a flow file would not be a control. On timeout the action is rejected, never executed.

**Data classes are declared.** `dataClasses` states what a flow processes, which is what data
residency rules in `compliance-policy.yaml` match against. Classification is declarative rather
than inferred from request content, because a wrong guess would either leak or block real
traffic.

## Writing your own

```yaml
id: my-flow            # required, unique; this is the "model" name clients request
name: My Flow          # required
metadata:
  version: 0.1.0       # bump on every change; surfaces as flow_version in debug traces
dataClasses: [internal]
nodes:                 # required, at least one
  - id: step
    type: llm
edges: []              # required, may be empty
```

The twelve built-in node types: `llm`, `tool`, `router`, `classifier`, `parallel`, `retrieval`,
`memory`, `agent-harness`, `transform`, `trigger`, `assistant-context`, `assistant-learn`. Any
other string resolves through the plugin node-handler registry.

Full reference: [`docs/CAPABILITIES.md`](../../../docs/CAPABILITIES.md) and
[`apps/runtime/README.md`](../../../apps/runtime/README.md).
