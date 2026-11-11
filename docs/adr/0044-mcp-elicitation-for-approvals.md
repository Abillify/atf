<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# 44. MCP elicitation as an additional approval surface

Date: 2026-11-13

## Status

Proposed

## Context

Approvals and clarifying questions currently reach the human through three
surfaces: the control-plane widget, a confirmation link, and the reviewer
inbox. The MCP-native mechanism for a server asking the client's user a
question mid-invocation — elicitation — is not used anywhere in ATF.

Version facts, verified in this repository:

- `@modelcontextprotocol/sdk` is pinned to **1.32.2** in gate, runtime and
  search. The installed package's server API includes
  `elicitInput(params: ElicitRequestFormParams | ElicitRequestURLParams,
  options?): Promise<ElicitResult>` — the SDK carries elicitation (form
  mode and URL mode).
- `packages/mcp-2026` — the shared stateless-HTTP 2026-07-28 core used by
  the gate router, the search adapter, and the runtime's
  `Stateless2026Client` — has **no elicitation support at all**. Its scope
  is deliberately the request/response envelope; elicitation is a
  server→client request, which the stateless profile does not carry.
- The gate's stateful paths (`apps/gate/src/mcp/server.ts` builds an SDK
  `Server`; `sse.ts` / `streamable.ts` serve it) run on a real bidirectional
  connection, where elicitation is meaningful.
- The runtime's outbound MCP client (`apps/runtime/src/mcp/wrapper/client.ts`)
  does not handle elicitation requests from upstream servers either.

The two-step confirmation from A2 (transaction tokens,
`transaction/actionTokens` in the gate) is the existing approval protocol:
a side-effecting action is refused until the caller presents a token minted
by an explicit human confirmation. Elicitation does not replace that — it
changes *where the human answers*, not *what makes the answer valid*.

## Decision

Adopt elicitation as an **additional, optional presentation layer** on top
of the existing approval machinery, with these boundaries:

1. **Where it hooks in (gate).** On the stateful transports only
   (`server.ts` + `sse.ts`/`streamable.ts`): when a tool invocation hits
   the two-step-confirmation gate, the gate may, *if the session's client
   declared the elicitation capability*, call `elicitInput` with a form
   asking for confirmation (or for the missing input a clarification
   requires). A "yes" in the elicitation UI does not authorize anything by
   itself — it triggers the same confirmation flow that produces the
   transaction token; the tool then re-checks the token as today. The
   widget/link/inbox surfaces remain available and are the fallback whenever
   the client lacks the capability, including every stateless-2026 caller.
2. **Where it hooks in (runtime client).** `client.ts` gains an elicitation
   request handler that maps an upstream server's elicitation onto the
   flow's existing ask-user/interrupt path, so an ATF flow calling an
   external MCP server can surface that server's question through the same
   approval surfaces instead of timing out.
3. **`packages/mcp-2026` stays without elicitation.** The stateless profile
   has no channel for server-initiated requests; adding pseudo-elicitation
   (polling tricks) would invent a non-standard dialect. If the 2026-07-28
   spec defines an official pattern for this, revisit — until then,
   stateless callers use widget/link/inbox.
4. **No approval semantics change.** Elicitation is presentation; the
   transaction token stays the single authorization artifact. An elicited
   answer is bound to the same evidence-contract hash the confirmation link
   is bound to, so a confirmation cannot be phished across actions.

## Consequences

- Approval latency drops for capable clients (answer in-band, no context
  switch), while the security property — a token minted by a verified
  confirmation — is untouched.
- New failure mode to handle: elicitation timeout or client disconnect
  mid-question. Rule: the invocation does not proceed; the pending approval
  stays open on the durable surfaces (inbox/link), so elicitation can fail
  without losing the user's option to answer elsewhere.
- Test surface grows on both sides: gate tests need a fake client with the
  elicitation capability; runtime tests need an upstream server that
  elicits.
- Explicit non-goal: elicitation is not used for LLM-loop clarifications
  inside a flow (those stay in-flow); it is used only where a human
  confirmation or a human-owned input is already required by policy.
