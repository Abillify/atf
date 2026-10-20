<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# 34. Online (DB) flows shadow same-id file flows — visibly, precedence unchanged

Date: 2026-10-20

## Status

Accepted

## Context

The runtime builds its flow registry as a composite of a file registry (flows
checked into git, loaded from `FLOWS_DIR`) and an optional online registry
(`DbFlowSource`, flows edited and published through Studio). The composite has
always resolved an id collision in favour of the database — an operator who
edits a flow online expects that edit to take effect immediately, and a stale
file in git must not silently resurrect itself.

That precedence was correct but completely silent. An operator could push a
change to a flow file through the GitOps webhook, see `reloadedFlows` report
success, and observe no behavior change at all — the online (DB) flow with the
same id still answered every request. None of the surfaces told them:

1. Startup logged nothing about id collisions between the two sources.
2. `GET /flows/:id` on an online flow showed only the DB definition; the
   shadowed file baseline was invisible.
3. Publishing an online flow over an existing file flow was recorded as a
   plain publish — the audit log could not answer "did this publish start
   overriding a git flow?".
4. Rolling an online flow to an older version said nothing about the file it
   kept shadowing.
5. Deleting an online flow silently revealed the file flow again — the
   effective definition changed without any signal.
6. The GitOps webhook reported the file as reloaded even when the pushed file
   had no runtime effect.

The requirement (Phase 12: "DB-Flows überschreiben Git-Flows still") is to
remove the silence, not to change the winner.

## Decision

1. **Precedence stays DB-wins.** The composite registry resolution is
   unchanged; there is no new configuration flag and no precedence inversion.
   Changing which source wins would break the online-editing contract that
   Studio depends on.
2. **One shared detection helper.** `findShadowedFlowIds(fileRegistry,
   dbSource)` (`graph/flow-registry-composite.ts`) returns the sorted ids
   present in both sources (a DB flow only shadows when it has a published
   revision). All surfaces derive from this single function so they can never
   disagree.
3. **Startup warning.** After the composite registry is built, the runtime
   logs a warning naming the shadowed flows and stating that git changes to
   those files have no runtime effect until the online flow is deleted.
4. **Detail endpoint exposes the shadow.** `GET /flows/:id` on an online flow
   that shadows a file flow adds `shadowsFile: true` and the current file
   baseline as `fileDefinition`, so Studio (and any API consumer) can render
   the override and diff it.
5. **Lifecycle operations record the shadow.** Publishing over a file flow and
   rolling back an online flow that shadows a file add `shadowsFile: true` to
   both the audit-log details and the HTTP response. Deleting an online flow
   that reveals a file flow adds `revealsFile: true` to both.
6. **GitOps pushes report no-effect reloads.** The GitOps router takes an
   optional `shadowedFlowIds()` provider. After a trigger-branch reload it
   intersects the reloaded ids with the shadowed set and, when non-empty,
   logs a warning, adds the list to the audit entry, returns
   `shadowedFlows: [...]` in the response, and extends the human-readable
   message to state that those flows are not live.

## Consequences

- A git push that changes nothing becomes visible in the webhook response,
  the log, and the audit trail — the "I pushed but nothing happened" class of
  incidents is diagnosable from the audit log alone.
- The effective definition of a shadowed flow is discoverable from the API
  without knowing the storage layout: `shadowsFile` plus `fileDefinition`
  make the override and its baseline explicit.
- Precedence is unchanged, so no existing deployment changes behavior; the
  only observable deltas are additive response fields, log lines, and audit
  details.
- `revealsFile` on delete documents the (also correct, but previously
  invisible) reverse direction: removing the online flow falls back to git.
- The GitOps router degrades gracefully when no `DbFlowSource` is configured
  (single-source deployments see exactly the previous response shape).
