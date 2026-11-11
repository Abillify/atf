<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# 41. A channel interface derived from the Rocket.Chat implementation

Date: 2026-11-13

## Status

Proposed

## Context

Rocket.Chat is the only chat channel ATF has: an outgoing-webhook receiver
(`apps/runtime/src/routes/rocketchat.ts`), a self-service pairing flow
(`apps/runtime/src/routes/rocketchat-connect.ts`), and a channel module with
bindings, an API client, and a persistent outbox
(`apps/runtime/src/assistants/rocketchat-channel.ts`, 772 lines). Product
interest exists in Slack and Microsoft Teams. Before committing to a second
and third channel, the review asked for the implicit interface inside the
Rocket.Chat code to be made explicit — what a channel actually has to do —
so new channels implement a contract instead of copying a file.

This ADR performs that extraction. It proposes no SDK dependency and no
schema change; it is the design input for a later, separately approved
implementation task.

## Decision

Extract a `ChatChannel` interface from the existing code. The table below is
the required mapping, derived by reading the current implementation.

| Rocket.Chat function | File → symbol | Generic or channel-specific |
| --- | --- | --- |
| Receive inbound message event | `routes/rocketchat.ts` → `POST /integrations/rocketchat/events` handler | Generic shape (event → normalize → dispatch); wire format specific |
| Authenticate the inbound event | `routes/rocketchat.ts` → `tokenMatches` (SHA-256 + `timingSafeEqual` over a shared webhook token) | Generic comparison; credential type specific (Slack: HMAC of raw body with signing secret; Teams: service-token validation) |
| Drop bot's own posts (loop guard) | `routes/rocketchat.ts` → `user_id === channel.botUserId` | Generic concept; "who is the bot" lookup specific |
| Map channel user → ATF identity | `assistants/rocketchat-channel.ts` → `PostgresRocketChatBindingStore.resolveInbound` | Generic (binding table keyed by `(server, channel_user, room)`); join key specific |
| Self-service pairing | `routes/rocketchat.ts` + `routes/rocketchat-connect.ts` → `confirmPairing`, `rocketchat_connect_requests`, OIDC-verified email via `RocketChatClient.verifiedPrimaryEmail` | Generic flow (short-lived opaque link → OIDC sign-in → bind); identity-proof source specific |
| Consent / disconnect command | `routes/rocketchat.ts` → `AIPERATOR-DISCONNECT` → `bindings.revokeInbound` | Generic |
| Start a run from a message | `channel.runs.start(...)` with `idempotencyKey: rocketchat:<message_id>` | Generic (already channel-agnostic behind `origin`/`delivery` tags) |
| Send reply / progress placeholder | `RocketChatOutbox.enqueueRunProgress` → `RocketChatClient.sendMessage` with deterministic `messageId` | Generic queue; delivery API specific |
| Retry and sweep undelivered messages | `RocketChatOutboxSweeper`, `RocketChatOutboxScheduler` | Generic (outbox rows are already transport-agnostic above the client call) |
| Approval prompt in-channel | outbox message + binding scope (approval links resolve through the existing widget/reviewer paths) | Generic |

Channel-specific residue stays behind a per-channel adapter implementing:
`verifyInbound(request)`, `normalizeEvent(request)`, `send(message)`,
`lookupVerifiedEmail(channelUserId)`. Everything else — bindings, pairing
records, runs, outbox, approval routing — is reused unchanged.

Required configuration and routes per additional channel (shape, not names
yet final): one webhook route (`POST /integrations/<channel>/events`), one
shared-secret variable (`<CHANNEL>_WEBHOOK_SECRET`, registered as SECRET in
`docs/CONFIGURATION.md` with a `*_FILE` variant per ADR 0040), the existing
`<channel>` columns on bindings/outbox tables generalized to
`(channel_type, channel_user_id, room_id)`.

No new SDK dependency is proposed. Slack and Teams webhook verification and
message posting are small, well-specified HTTP calls; adding two SDKs for
them would enlarge the supply chain (and the SBOM) for a few hundred lines
of code. This decision needs revisiting only if interactive components
(buttons for in-channel approval) become a requirement.

## Consequences

- Threats and countermeasures, per channel:
  - **Forged events.** Rocket.Chat uses a shared token compared in constant
    time. Slack signs the request body with a signing secret (HMAC-SHA256
    over `v0:<timestamp>:<body>`); Teams emits a JWT. The interface keeps
    verification inside the adapter so a channel cannot "forget" it, and the
    runtime rejects the event before any binding lookup or run starts.
  - **Replay.** Rocket.Chat today relies on the idempotency key
    (`rocketchat:<message_id>`), which makes a replayed event reuse the same
    run — a replay cannot create duplicate work, only re-trigger progress
    delivery. The same pattern generalizes: the idempotency key must be
    derived from the channel's immutable message id, never from content.
    Slack additionally provides a `timestamp` header to reject stale
    signatures (±5 min window); the interface should carry an optional
    `replayWindow` check in `verifyInbound`.
  - **Identity spoofing.** Pairing never trusts a channel-supplied email; it
    fetches the verified email server-to-server and requires an OIDC sign-in
    through the operator plane. This rule is channel-independent and must be
    preserved by any adapter: no user-supplied or event-payload identity
    participates in the binding proof.
  - **Enumeration.** Unbound users receive an indistinguishable `202`
    response; keep this so channels do not leak which identities are bound.
- The extraction itself (interface + rename of binding columns) is a
  refactor with no behavior change and can land before any second channel
  exists; it should be its own task with the existing Rocket.Chat tests as
  the regression net.
- Until a second channel actually ships, the interface stays a hypothesis
  with one implementation. The ADR accepts that risk deliberately: the
  alternative — designing from first principles without a second data point
  — failed visibly enough in the review to justify extracting from code.
