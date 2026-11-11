<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# 43. Exposing flows as A2A agents: agent-card mapping and controls

Date: 2026-11-13

## Status

Proposed

## Context

Flows are reachable as MCP tools through the gate (`/mcp`): the gate's
catalog presents authorized flows as tools, with policy filtering — only an
outright policy denial hides a tool (see `apps/gate/src/mcp/server.ts`).
There is no Agent-to-Agent (A2A) endpoint and no agent card. The review
asks whether ATF should speak A2A in addition to MCP, and if so, how flows
map onto agent cards and which controls apply to inbound tasks.

> **TODO(human):** All protocol-level statements in this ADR about the A2A
> specification (agent-card format, task lifecycle, transport) are written
> from working knowledge, not from a specification copy available in this
> repository. Before implementation, a human must verify every quoted or
> implied protocol detail against the A2A spec source of truth and correct
> this document. Nothing here may be implemented on the ADR's authority
> alone.

## Decision

Direction: yes, a thin A2A surface, structured so that it adds no new
execution path.

1. **One agent card per tenant, not per flow.** The card is served at a
   well-known discovery path and lists the flows the *presenting* caller is
   authorized to see — reusing the same authorization filter that already
   gates the MCP catalog, so card content and tool visibility cannot drift.
   A per-flow card would multiply discovery endpoints and leak the existence
   of unauthorized flows.
2. **Mapping from existing flow metadata.** `apps/runtime/schemas/flow.schema.json`
   already carries what a card skill entry needs: `id` (also the model name
   clients request) → skill id; `name` → skill name; `description` → skill
   description; `scopes` → the security requirements the caller must
   present; `dataClasses` and `budgets` inform the skill's declared
   constraints. No new flow metadata is introduced; if the card format
   demands a field with no flow analogue, the field is derived or omitted,
   not invented per flow.
3. **Authentication reuses the existing chain.** Inbound A2A tasks
   authenticate exactly like MCP invocations: tenant API key or OIDC token
   at the edge, and the *transaction-token* mechanism (ADR series on
   asymmetric transaction tokens; `transaction/actionTokens` meta in the
   gate) for the two-step confirmation of side-effecting actions. An A2A
   task that triggers a side-effecting tool goes through the same
   confirmation as the MCP path — the A2A layer must not become a
   confirmation bypass.
4. **Controls are inherited, not duplicated.** Per-execution budgets
   (`budgets` in the flow schema), guardrails, compliance data-class rules,
   rate limits, and the audit log all sit below the protocol surface and
   apply unchanged. The A2A handler is a translator: A2A task → existing
   run-start call with `origin: "a2a"` and an idempotency key derived from
   the A2A task id (the pattern already proven by the Rocket.Chat channel:
   `rocketchat:<message_id>`).
5. **Task lifecycle is an adapter over run state.** ATF runs already have
   states (queued, running, awaiting confirmation, finished, budget
   exceeded). The adapter maps them onto the A2A task states; it does not
   add a second state machine.

## Consequences

- Two protocol surfaces, one execution core: the invariant to protect in
  review is that the A2A handler contains no policy, no budget logic, and
  no direct graph access — only translation.
- Idempotency from the A2A task id makes replayed task submissions reuse
  the same run, matching the channel pattern and neutralizing replay of
  inbound tasks.
- Cost: a discovery endpoint, a task adapter, and conformance tests against
  an A2A client. The spec-verification TODO above must be closed before any
  of that is scheduled.
- Risk of protocol churn: A2A is young. Keeping the adapter thin and the
  card generated from flow metadata limits the blast radius of spec changes
  to the translator.
- Explicit non-decision: no outbound A2A (ATF calling other agents). If
  that ever comes up, it needs its own ADR because it introduces egress
  policy questions the egress guard has not seen yet.
