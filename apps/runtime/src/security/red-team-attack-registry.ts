// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Red-Team Attack Registry (`src/security/red-team-attack-registry.ts`)
 *
 * Wraps the static ATTACK_TEMPLATES with a mutable, hot-reloadable registry
 * that supports:
 *
 *   1. Custom attack templates registered at runtime (operator-supplied).
 *   2. Remote attack-library updates pulled from a URL on a configurable
 *      interval — so the attack library stays current without a code deploy.
 *   3. Per-category enable/disable toggles so operators can suppress categories
 *      that do not apply to their deployment (e.g. no tool-abuse attacks on a
 *      read-only flow).
 *
 * The static built-in templates are always present as the baseline.  Custom +
 * remote templates are ADDITIVE — they never replace built-ins, only extend
 * them.  Remote templates must conform to the same AttackTemplate shape; any
 * template that fails structural validation is silently skipped.
 *
 * No `any` at module boundaries.
 */

import type { AttackTemplate, AttackCategory } from "./red-team-attacks.js";
import { ATTACK_TEMPLATES } from "./red-team-attacks.js";
import type { Logger } from "../observability/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A serialisable (JSON-safe) attack template — the over-the-wire shape. */
export interface SerializableAttackTemplate {
  id: string;
  category: AttackCategory;
  severity: number;
  description: string;
  /** Static payload rendered verbatim (no context substitution for remote templates). */
  payload: string;
}

export interface AttackRegistryOptions {
  /**
   * URL of a JSON endpoint that returns `{ templates: SerializableAttackTemplate[] }`.
   * Polled on the configured interval. When absent, remote updates are disabled.
   */
  remoteUrl?: string;
  /** Interval (ms) between remote-update polls. Default: 6 hours. */
  pollIntervalMs?: number;
  /**
   * Categories to suppress. Templates in a disabled category are excluded
   * from `getAll()` and from the sample rotations used by the scheduler.
   */
  disabledCategories?: AttackCategory[];
  logger?: Logger;
}

export interface AttackRegistry {
  /** All enabled templates (built-in + registered custom + fetched remote). */
  getAll(): readonly AttackTemplate[];
  /** Filter by categories. Returns only enabled templates in those categories. */
  byCategories(categories: AttackCategory[]): AttackTemplate[];
  /** Register a custom template at runtime. Rejects duplicate IDs silently. */
  register(template: AttackTemplate): void;
  /**
   * Pull updated templates from the configured remote URL immediately.
   * No-op when no remoteUrl was configured.
   */
  refreshRemote(): Promise<void>;
  /** Start the periodic remote-update polling timer. No-op if already running. */
  startPolling(): void;
  /** Stop the polling timer. */
  stopPolling(): void;
  /** Enable a previously disabled category. */
  enableCategory(category: AttackCategory): void;
  /** Disable a category — its templates are excluded from getAll(). */
  disableCategory(category: AttackCategory): void;
  /** All registered IDs (built-in + custom + remote) for diagnostics. */
  stats(): { total: number; builtin: number; custom: number; remote: number; disabled: number };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_CATEGORIES = new Set<string>([
  "prompt_injection",
  "jailbreak",
  "exfiltration",
  "pii_extraction",
  "tool_abuse",
  "encoding_evasion",
]);

function isValidSerializable(v: unknown): v is SerializableAttackTemplate {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" && r.id.length > 0 &&
    typeof r.category === "string" && VALID_CATEGORIES.has(r.category) &&
    typeof r.severity === "number" && r.severity >= 0 && r.severity <= 1 &&
    typeof r.description === "string" &&
    typeof r.payload === "string" && r.payload.length > 0
  );
}

function toAttackTemplate(s: SerializableAttackTemplate): AttackTemplate {
  return {
    id: s.id,
    category: s.category,
    severity: s.severity,
    description: s.description,
    render: () => s.payload,
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class AttackRegistryImpl implements AttackRegistry {
  private readonly custom = new Map<string, AttackTemplate>();
  private readonly remote = new Map<string, AttackTemplate>();
  private readonly disabled: Set<AttackCategory>;
  private readonly remoteUrl: string | undefined;
  private readonly pollIntervalMs: number;
  private readonly logger: Logger | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: AttackRegistryOptions = {}) {
    this.disabled = new Set(opts.disabledCategories ?? []);
    this.remoteUrl = opts.remoteUrl;
    this.pollIntervalMs = opts.pollIntervalMs ?? 6 * 60 * 60_000;
    this.logger = opts.logger;
  }

  getAll(): readonly AttackTemplate[] {
    const out: AttackTemplate[] = [];
    for (const t of ATTACK_TEMPLATES) {
      if (!this.disabled.has(t.category)) out.push(t);
    }
    for (const t of this.custom.values()) {
      if (!this.disabled.has(t.category)) out.push(t);
    }
    for (const t of this.remote.values()) {
      if (!this.disabled.has(t.category)) out.push(t);
    }
    return out;
  }

  byCategories(categories: AttackCategory[]): AttackTemplate[] {
    const enabled = categories.filter((c) => !this.disabled.has(c));
    const set = new Set(enabled);
    return this.getAll().filter((t) => set.has(t.category));
  }

  register(template: AttackTemplate): void {
    // Never shadow a built-in.
    const builtinIds = new Set(ATTACK_TEMPLATES.map((t) => t.id));
    if (builtinIds.has(template.id)) {
      this.logger?.warn("[AttackRegistry] Cannot override built-in template", { id: template.id });
      return;
    }
    this.custom.set(template.id, template);
  }

  async refreshRemote(): Promise<void> {
    if (this.remoteUrl === undefined) return;
    try {
      const resp = await fetch(this.remoteUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        this.logger?.warn("[AttackRegistry] Remote update failed", {
          status: resp.status,
          url: this.remoteUrl,
        });
        return;
      }
      const data = (await resp.json()) as { templates?: unknown };
      const raw = Array.isArray(data?.templates) ? data.templates : [];

      let added = 0;
      let skipped = 0;
      const builtinIds = new Set(ATTACK_TEMPLATES.map((t) => t.id));

      for (const item of raw) {
        if (!isValidSerializable(item)) { skipped++; continue; }
        if (builtinIds.has(item.id)) { skipped++; continue; }
        this.remote.set(item.id, toAttackTemplate(item));
        added++;
      }

      this.logger?.info("[AttackRegistry] Remote update applied", {
        url: this.remoteUrl,
        added,
        skipped,
        totalRemote: this.remote.size,
      });
    } catch (err) {
      this.logger?.warn("[AttackRegistry] Remote update error (non-fatal)", {
        url: this.remoteUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  startPolling(): void {
    if (this.timer !== undefined || this.remoteUrl === undefined) return;
    // Initial fetch immediately.
    void this.refreshRemote();
    this.timer = setInterval(() => {
      void this.refreshRemote();
    }, this.pollIntervalMs);
    this.timer.unref?.();
    this.logger?.info("[AttackRegistry] Remote polling started", {
      url: this.remoteUrl,
      intervalMs: this.pollIntervalMs,
    });
  }

  stopPolling(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  enableCategory(category: AttackCategory): void {
    this.disabled.delete(category);
  }

  disableCategory(category: AttackCategory): void {
    this.disabled.add(category);
  }

  stats() {
    return {
      total: this.getAll().length,
      builtin: ATTACK_TEMPLATES.filter((t) => !this.disabled.has(t.category)).length,
      custom: this.custom.size,
      remote: this.remote.size,
      disabled: this.disabled.size,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory + singleton
// ---------------------------------------------------------------------------

/** The default registry used by the red-team engine. */
export let defaultAttackRegistry: AttackRegistry = new AttackRegistryImpl();

/**
 * Creates and optionally starts a hot-reloadable attack registry.
 * Replaces `defaultAttackRegistry` so the engine automatically picks it up.
 */
export function createAttackRegistry(opts: AttackRegistryOptions = {}): AttackRegistry {
  const registry = new AttackRegistryImpl(opts);
  if (opts.remoteUrl !== undefined) {
    registry.startPolling();
  }
  defaultAttackRegistry = registry;
  return registry;
}
