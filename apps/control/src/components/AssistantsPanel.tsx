"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * AssistantsPanel — the operator view of the per-user assistant estate.
 *
 * This is an OPERATOR surface, not a user's own assistant settings. The dashboard
 * authenticates a role, not a person (ADR-0013: the OIDC session token carries only
 * the resolved role and never touches the `/v1` plane), so it can neither read nor
 * write anything as a particular user. It therefore talks to `/admin/assistants/*`,
 * which spans users, and it exposes exactly one write class of the soul: the
 * operator's `constraints`.
 *
 * What it deliberately does NOT offer:
 *   - editing a user's `directives` — those are that person's instructions to their
 *     own assistant, and an operator changing them behind their back is not a
 *     capability this product should have.
 *   - applying a learned procedure — approving new behaviour into someone's
 *     assistant is their call. Rejecting is offered, because that only removes.
 *
 * The constraint editor sends the revision hash it read, so two operators editing the
 * same assistant get a conflict instead of one silently overwriting the other.
 *
 * Req 9.3: the sections live under ./assistants/ (estate panel, detail
 * view, constraint editor, revocation console, skill registry); this file
 * only holds the tab composition, without behavior change.
 */

import type React from "react";
import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../lib/ui";
import { AssistantsEstatePanel } from "./assistants/AssistantsEstatePanel";
import { RevocationConsole } from "./assistants/RevocationConsole";
import { SkillRegistryConsole } from "./assistants/SkillRegistryConsole";

// ---------------------------------------------------------------------------
// Top-level export — Estate + Revocation Console tabs
// ---------------------------------------------------------------------------

/**
 * The operator's per-user assistant estate view, plus the Identity Broker's
 * cross-scope Revocation Console. Two tabs rather than one merged view: the
 * estate tab answers "what does THIS assistant hold" one row at a time, the
 * console tab answers "who holds delegated authority at all" across every
 * tenant/user/assistant — different questions with different filters, and
 * conflating them would make neither filter set make sense.
 */
export function AssistantsPanel(): React.JSX.Element {
  const [tab, setTab] = useState<"estate" | "revocation" | "skill-registry">("estate");
  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as "estate" | "revocation" | "skill-registry")}
    >
      <TabsList className="mb-4">
        <TabsTrigger value="estate">Estate</TabsTrigger>
        <TabsTrigger value="revocation">Revocation Console</TabsTrigger>
        <TabsTrigger value="skill-registry">Skill Registry</TabsTrigger>
      </TabsList>
      <TabsContent value="estate">
        <AssistantsEstatePanel />
      </TabsContent>
      <TabsContent value="revocation">
        <RevocationConsole />
      </TabsContent>
      <TabsContent value="skill-registry">
        <SkillRegistryConsole />
      </TabsContent>
    </Tabs>
  );
}
