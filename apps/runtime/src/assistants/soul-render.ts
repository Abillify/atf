// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Soul rendering (`src/assistants/soul-render.ts`)
 *
 * Turns the stored soul document into the system-prompt section an assistant
 * turn begins with. Pure and deterministic — the same document always renders to
 * the same bytes.
 *
 * Two properties this module is built around:
 *
 * **Byte stability.** The rendered soul sits in the cacheable prompt PREFIX. A
 * single changed character there forces a full re-prefill of every token after
 * it, which on a local OpenAI-compatible server is the difference between a warm
 * KV cache and reprocessing the whole conversation. So: field order is declared
 * (never `Object.keys`), lists are sorted, and nothing volatile (timestamps,
 * revision numbers, counts) is rendered. `renderSoul` is called on every turn
 * and must produce identical output when nothing changed.
 *
 * **Constraint precedence.** Operator constraints render LAST. Instruction
 * following degrades with distance from the model's turn, and a constraint
 * buried above two thousand characters of user directives is a constraint the
 * model may talk itself out of. Rendering order encodes precedence, so the
 * strongest rules are the closest.
 *
 * The budget is a hard cap, not a target: exceeding it truncates and the
 * truncation is REPORTED to the model, because a silently shortened instruction
 * set is worse than a visibly shortened one — the model would confidently act on
 * half a rule.
 *
 * No `any` at module boundaries.
 */

import {
  SOUL_IDENTITY_FIELDS,
  SOUL_DIRECTIVE_FIELDS,
  SOUL_CONSTRAINT_TEXT_FIELDS,
  type SoulDocument,
} from "./soul-document.js";
import { SOUL_RENDER_MAX_CHARS } from "./types.js";

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/**
 * Human-readable labels, declared in render order.
 *
 * Prose labels rather than raw field names: the model reads these, and
 * `vibe: dry` communicates less than `Manner: dry`. Kept alongside the field
 * order so adding a field cannot leave it unlabelled.
 */
const IDENTITY_LABELS: Record<(typeof SOUL_IDENTITY_FIELDS)[number], string> = {
  name: "Name",
  emoji: "Signature",
  role: "Responsibility",
  vibe: "Manner",
  notes: "Self-notes",
};

const DIRECTIVE_LABELS: Record<(typeof SOUL_DIRECTIVE_FIELDS)[number], string> = {
  instructions: "Standing instructions",
  style: "Preferred style",
  about: "About this user",
  avoid: "Avoid",
};

const CONSTRAINT_LABELS: Record<(typeof SOUL_CONSTRAINT_TEXT_FIELDS)[number], string> = {
  rules: "Rules",
  compliance: "Compliance",
};

// ---------------------------------------------------------------------------
// Section rendering
// ---------------------------------------------------------------------------

/** One rendered, individually droppable block. */
interface SoulSection {
  /** Stable id used by the truncation report. */
  id: "identity" | "directives" | "constraints";
  /** Rendering priority when the budget is exceeded — LOWEST is dropped first. */
  priority: number;
  lines: string[];
}

function renderSection(heading: string, entries: [string, string | undefined][]): string[] {
  const rendered = entries.filter(
    (entry): entry is [string, string] => entry[1] !== undefined && entry[1].length > 0,
  );
  if (rendered.length === 0) return [];
  return [
    heading,
    ...rendered.map(([label, value]) =>
      // Multi-line values are indented under their label so a paragraph cannot
      // be mistaken for the start of the next field.
      value.includes("\n")
        ? `- ${label}:\n${value
            .split("\n")
            .map((line) => `  ${line}`)
            .join("\n")}`
        : `- ${label}: ${value}`,
    ),
  ];
}

// ---------------------------------------------------------------------------
// Render result
// ---------------------------------------------------------------------------

export interface SoulRenderResult {
  /** The prompt text. Empty when the soul carries nothing. */
  text: string;
  /** Character count of {@link text}. */
  chars: number;
  /**
   * Sections dropped entirely because the budget was exhausted. Never contains
   * `constraints` — see {@link renderSoul}.
   */
  droppedSections: SoulSection["id"][];
  /** True when any content was dropped or truncated. */
  truncated: boolean;
}

/**
 * Renders the soul into a bounded, deterministic prompt block.
 *
 * Budget policy when the document exceeds `maxChars`:
 *   1. `constraints` are never dropped. If they alone exceed the budget, they
 *      are truncated with an explicit marker — an operator rule must reach the
 *      model in some form, and dropping it silently would let a turn run without
 *      a limit that the operator believes is enforced.
 *   2. `identity` is dropped first. It is the assistant's self-description:
 *      losing it degrades tone, not correctness.
 *   3. `directives` are truncated rather than dropped, since a user's standing
 *      instructions usually lead with the most important one.
 *
 * The precedence is deliberate and the inverse of the render order: the block
 * closest to the model's turn is also the one most protected.
 */
export function renderSoul(
  doc: SoulDocument,
  options: { maxChars?: number; assistantDisplayName?: string } = {},
): SoulRenderResult {
  const maxChars =
    options.maxChars !== undefined && Number.isFinite(options.maxChars) && options.maxChars > 0
      ? Math.floor(options.maxChars)
      : SOUL_RENDER_MAX_CHARS;

  const identityEntries: [string, string | undefined][] = SOUL_IDENTITY_FIELDS.map((field) => [
    IDENTITY_LABELS[field],
    doc.identity[field],
  ]);
  // Fall back to the provisioned display name so an assistant that has not yet
  // named itself still has a name in its prompt. Without this the model sees no
  // name at all and invents one per turn, which reads as instability to the user.
  if (doc.identity.name === undefined && options.assistantDisplayName) {
    identityEntries[0] = [IDENTITY_LABELS.name, options.assistantDisplayName];
  }

  const constraintEntries: [string, string | undefined][] = [
    ...SOUL_CONSTRAINT_TEXT_FIELDS.map((field): [string, string | undefined] => [
      CONSTRAINT_LABELS[field],
      doc.constraints[field],
    ]),
  ];
  const denied = doc.constraints.deniedTools;
  if (denied !== undefined && denied.length > 0) {
    // Stating WHY a tool is absent stops the model from repeatedly attempting a
    // call that the authorization layer will always refuse. The list is already
    // sorted by normalizeDeniedTools, so this line is byte-stable.
    constraintEntries.push([
      "Forbidden tools",
      `${denied.join(", ")} (these are blocked; do not attempt them)`,
    ]);
  }

  const sections: SoulSection[] = (
    [
      {
        id: "identity",
        priority: 1,
        lines: renderSection("## Who you are", identityEntries),
      },
      {
        id: "directives",
        priority: 2,
        lines: renderSection(
          "## What your user expects",
          SOUL_DIRECTIVE_FIELDS.map((field) => [DIRECTIVE_LABELS[field], doc.directives[field]]),
        ),
      },
      {
        id: "constraints",
        priority: 3,
        lines: renderSection(
          "## Hard limits (set by your operator, not negotiable)",
          constraintEntries,
        ),
      },
    ] satisfies SoulSection[]
  ).filter((section) => section.lines.length > 0);

  if (sections.length === 0) {
    return { text: "", chars: 0, droppedSections: [], truncated: false };
  }

  const joined = joinSections(sections);
  if (joined.length <= maxChars) {
    return {
      text: joined,
      chars: joined.length,
      droppedSections: [],
      truncated: false,
    };
  }

  // Over budget. Drop lowest-priority sections until it fits, but never the
  // constraints section.
  const kept = [...sections];
  const dropped: SoulSection["id"][] = [];
  const droppable = kept
    .filter((s) => s.id !== "constraints")
    .sort((a, b) => a.priority - b.priority);

  for (const candidate of droppable) {
    const remaining = kept.filter((s) => s !== candidate);
    const text = joinSections(remaining);
    kept.length = 0;
    kept.push(...remaining);
    dropped.push(candidate.id);
    if (text.length <= maxChars) {
      return {
        text,
        chars: text.length,
        droppedSections: dropped,
        truncated: true,
      };
    }
  }

  // Only constraints remain and they still exceed the budget. Truncate with a
  // visible marker rather than dropping: a partial rule the model knows is
  // partial is safer than a rule it never sees.
  const remainder = joinSections(kept);
  const marker = "\n[... hard limits truncated; ask your operator to shorten them]";
  const text = `${remainder.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
  return {
    text,
    chars: text.length,
    droppedSections: dropped,
    truncated: true,
  };
}

function joinSections(sections: SoulSection[]): string {
  return sections.map((s) => s.lines.join("\n")).join("\n\n");
}

/**
 * Builds the notice appended to the prompt when soul content was dropped.
 *
 * The model is told what is missing so it can ask rather than guess. This
 * mirrors the bootstrap-truncation warning pattern: a truncated context that
 * announces itself produces a question, a silent one produces a confident wrong
 * answer.
 */
export function buildSoulTruncationNotice(result: SoulRenderResult): string | undefined {
  if (!result.truncated) return undefined;
  const parts = ["[Soul truncated] Your configuration exceeded the prompt budget."];
  if (result.droppedSections.length > 0) {
    const names = result.droppedSections
      .map((id) => (id === "identity" ? "your self-description" : "your user's directives"))
      .join(" and ");
    parts.push(
      `Omitted: ${names}. Treat what remains as incomplete and ask the user rather than assuming.`,
    );
  } else {
    parts.push(
      "Your operator's hard limits were shortened. Treat any partial rule as fully binding.",
    );
  }
  return parts.join(" ");
}
