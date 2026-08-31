// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { AuthContext } from "../auth/context.ts";
import type { PromptSource, SystemPromptConfig } from "../config/schema.ts";
import { compileQuery } from "../db/bindings.ts";
import type { DbProvider } from "../db/manager.ts";
import type { MonitorBus } from "../monitor/events.ts";
import type { ToolExecutor } from "../tools/types.ts";
import { logger } from "../logger.ts";

export type ToolResolver = (name: string) => ToolExecutor | undefined;

/** Builds the least-privileged identity for one operator-configured discovery source. */
function systemContext(scopes: readonly string[]): AuthContext {
  return {
    method: "static",
    subject: "system",
    username: "system",
    scopes: [...scopes],
    claims: {},
    tenantId: "default",
    headers: {},
    rawToken: "",
  };
}

function extractRows(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) {
    if (raw.length > 0 && Array.isArray(raw[0])) return raw[0] as Array<Record<string, unknown>>;
    return raw as Array<Record<string, unknown>>;
  }
  if (raw && typeof raw === "object" && Array.isArray((raw as { rows?: unknown }).rows)) {
    return (raw as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

/**
 * Builds the routing model's system prompt from static text plus the results of
 * configured discovery queries. Refreshes on a timer so the prompt tracks live data.
 */
export class SystemPromptProvider {
  private prompt: string;
  private initialized = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: SystemPromptConfig,
    private readonly db: DbProvider,
    private readonly bus: MonitorBus,
    private readonly resolveTool?: ToolResolver,
  ) {
    this.prompt = config.text;
  }

  /**
   * Current cached system prompt, with the live current time always prepended
   * and — when a caller context is given — a per-request line identifying the
   * authenticated caller.
   */
  get(ctx?: AuthContext): string {
    const now = new Date();
    const tz = "Europe/Berlin";
    const local = now.toLocaleString("sv-SE", { timeZone: tz, hour12: false }).replace(" ", "T");
    const weekday = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
    const timeLine =
      `Current date and time: ${local} (${weekday}, ${tz} local time). ` +
      `All booking times you read or produce are ${tz} local time.`;

    const head = ctx ? `${timeLine}\n\n${this.callerLine(ctx)}` : timeLine;
    return this.prompt ? `${head}\n\n${this.prompt}` : head;
  }

  private callerLine(ctx: AuthContext): string {
    const name = typeof ctx.claims.name === "string" ? ctx.claims.name.trim() : "";
    const login = ctx.username;
    const who = name ? `${name} (login ${login})` : `login ${login}`;
    return (
      `Authenticated caller (you always act on their behalf): ${who}. ` +
      `When the request refers to this person - by their name, "me", "myself" ` +
      `or similar - it means the caller themselves: act for the caller and do ` +
      `not set \`user\`. Only set \`user\` when the request names a different person.`
    );
  }

  async start(): Promise<void> {
    if (!this.config.dynamic.enabled || this.config.dynamic.sources.length === 0) {
      this.prompt = this.config.text;
      this.initialized = true;
      this.bus.publish({
        type: "router",
        status: "ok",
        message: "system prompt initialized (static)",
        meta: { sources: [], length: this.prompt.length, prompt: this.prompt },
      });
      return;
    }
    await this.refresh();
    const ms = this.config.dynamic.refreshMinutes * 60_000;
    this.timer = setInterval(() => void this.refresh(), ms);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  getRaw(): string {
    return this.prompt;
  }

  async refresh(): Promise<void> {
    const previousPrompt = this.prompt;
    const parts: string[] = [];
    if (this.config.text.trim()) parts.push(this.config.text.trim());

    for (const source of this.config.dynamic.sources) {
      try {
        parts.push(await this.renderSource(source));
      } catch (err) {
        logger.warn(`system-prompt source '${source.name ?? source.tool}' failed`, {
          error: (err as Error).message,
        });
        this.bus.publish({
          type: "error",
          status: "error",
          message: `system-prompt source '${source.name ?? source.tool}' failed: ${(err as Error).message}`,
        });
        // Keep previous knowledge rather than dropping it.
      }
    }

    this.prompt = parts.join("\n\n");
    const changed = this.prompt !== previousPrompt;
    const isFirst = !this.initialized;
    this.initialized = true;
    this.bus.publish({
      type: "router",
      status: "ok",
      message: isFirst
        ? "system prompt initialized (dynamic)"
        : changed
          ? "system prompt refreshed (changed)"
          : "system prompt refreshed (unchanged)",
      meta: {
        sources: this.config.dynamic.sources.map((s) => s.name ?? s.tool),
        length: this.prompt.length,
        ...(isFirst || changed ? { prompt: this.prompt } : {}),
      },
    });
  }

  private async renderSource(source: PromptSource): Promise<string> {
    const ctx = systemContext(source.scopes);
    const rows = source.tool
      ? await this.runToolSource(source.tool, ctx)
      : await this.runInlineSource(source, ctx);
    const limited = rows.slice(0, source.maxRows);

    let rendered: string;
    if (source.column) {
      rendered = limited
        .map((r) => r[source.column!])
        .filter((v) => v !== undefined && v !== null)
        .join(", ");
    } else {
      rendered = JSON.stringify(limited);
    }
    return source.intro ? `${source.intro}\n${rendered}` : rendered;
  }

  private async runInlineSource(
    source: PromptSource,
    ctx: AuthContext,
  ): Promise<Array<Record<string, unknown>>> {
    const db = this.db.get(source.database!);
    const { sql, bindings } = compileQuery(source.query!, {}, ctx);
    const raw = await db.raw(sql, bindings as never);
    return extractRows(raw);
  }

  private async runToolSource(
    name: string,
    ctx: AuthContext,
  ): Promise<Array<Record<string, unknown>>> {
    const executor = this.resolveTool?.(name);
    if (!executor) throw new Error(`references unknown tool '${name}'`);
    const result = await executor.execute({}, ctx);
    if (result.isError) {
      const detail = result.content?.[0]?.text ?? "unknown error";
      throw new Error(`tool '${name}' failed: ${detail}`);
    }
    const text = result.content?.[0]?.text ?? "";
    const parsed = JSON.parse(text) as { rows?: Array<Record<string, unknown>> };
    return Array.isArray(parsed.rows) ? parsed.rows : [];
  }
}
