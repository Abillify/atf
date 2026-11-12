<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# 44. MCP elicitation as an additional approval surface

Date: 2026-11-11

## Status

Accepted (2026-11-12). Not yet implemented; the boundaries and the order of work are fixed
below.

## Context

Approvals reach a human through three surfaces in the Runtime — the in-chat widget, the approval
link (two-step since the review follow-up) and the reviewer inbox in Control — and through the
Gate's own approval protocol for MCP callers: a tool call matching an `effect: approval` policy
rule is answered with `APPROVAL_REQUIRED` and a request state; the decision is taken with
`io.modelcontextprotocol/approvals/resolve`; the requester then repeats the call carrying the
one-shot approval token in `_meta["io.modelcontextprotocol/approvalToken"]` (or in the
`approval/actionTokens` map keyed by the action-contract hash). `requireDifferentApprover`
enforces separation of duties. The MCP-native way for a server to ask the client's user a
question during a call — elicitation — is not used anywhere.

Facts, checked in this repository:

- `@modelcontextprotocol/sdk` 1.32.2 (Gate, Runtime, Search) ships `elicitInput(...)` on the
  server side, with form and URL modes.
- `packages/mcp-2026`, the shared stateless HTTP core used by the Gate's 2026 endpoint, Search
  and the Runtime's stateless client, has no elicitation: a stateless request/response profile has
  no channel for a server-initiated request.
- The Gate's stateful transports (`apps/gate/src/mcp/server.ts` with `streamable.ts` and
  `sse.ts`) run an SDK `Server` over a bidirectional session, where elicitation works.
- The Runtime's outbound MCP client (`apps/runtime/src/mcp/wrapper/client.ts`) does not answer
  elicitation requests from upstream servers.

## Decision

Elicitation becomes an **optional presentation layer** for the existing approval machinery. It
changes where a person answers, never what makes the answer valid.

1. **Gate, stateful transports only.** When a call would be answered with `APPROVAL_REQUIRED`
   and the session's client declared the elicitation capability, the Gate first asks through
   `elicitInput` with a form that shows the approval presentation of the policy rule (title,
   message, fields rendered from the actual arguments). A confirmed answer resolves the pending
   approval through the same store and the same checks as `approvals/resolve`, and the Gate then
   executes the call with the minted one-shot token internally. A declined or cancelled answer
   resolves the approval as denied.
2. **Separation of duties wins.** With `requireDifferentApprover: true` the requester may not
   approve its own call, and the person in front of the requesting client *is* the requester.
   Elicitation is then not offered for approval; the call returns `APPROVAL_REQUIRED` as today,
   and a different principal decides.
3. **Fallback is the current protocol.** Without the capability, on the stateless 2026 endpoint,
   on timeout or on disconnect, nothing changes: `APPROVAL_REQUIRED`, `approvals/resolve`,
   one-shot token. A failed elicitation leaves the pending approval open on the durable path.
4. **Binding.** The elicited decision is bound to the same action-contract hash as an approval
   token, so a confirmation cannot be carried over to a different call.
5. **Runtime as MCP client.** `client.ts` registers an elicitation handler. An upstream server's
   elicitation is turned into a Runtime approval request (widget, link, inbox) with the
   server's message and requested fields; the answer goes back as the elicitation result. Without
   an approval gate configured, the handler declines, so an upstream server never blocks a run
   indefinitely.
6. **`packages/mcp-2026` stays without elicitation.** No polling dialect is invented; stateless
   callers keep the existing approval protocol. Revisit only if the 2026 specification defines a
   stateless pattern.
7. **Scope.** Elicitation is used only where a policy already requires a human decision or a
   human-owned input. Clarifications inside a flow stay inside the flow.

## Implementation plan

1. Gate: elicitation on the stateful server path, behind a per-server switch
   `policies.approval.elicitation` (default off); tests with a fake client that declares the
   capability, with and without `requireDifferentApprover`, and for timeout and disconnect.
2. Runtime: elicitation handler in the MCP client mapped onto the approval gate; tests with an
   upstream server that elicits.
3. Docs: CAPABILITIES (Human-in-the-loop approvals), the Gate configuration reference, THREAT-MODEL
   (an elicitation form is rendered by the client — its text is untrusted for the client user,
   like any tool output).

## Consequences

- Approval latency drops for capable clients, while the authorization artefact stays the one-shot
  approval token bound to the action.
- New failure modes (timeout, disconnect mid-question) end in the existing durable path, never in
  execution.
- Out of scope: elicitation for in-flow clarifications, and any change to the stateless 2026
  profile.
