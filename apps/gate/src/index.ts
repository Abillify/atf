// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { watch, type FSWatcher } from "node:fs";
import { loadConfigAsync } from "./config/loader.ts";
import { checkProductionReadiness } from "./config/prod-gate.ts";
import { buildApp } from "./app.ts";
import { initTracing, shutdownTracing } from "./observability/tracing.ts";
import { logger, isJsonEnabled } from "./logger.ts";

// Colorize each sessionId consistently so related lines from one session are
// visually grouped when scanning a TTY, without merging or reordering lines.
// Skipped for piped/non-TTY output and JSON mode, where ANSI codes would just
// be noise (or corrupt the JSON value).
const SESSION_ANSI_COLORS = ["36", "35", "33", "32", "34", "95", "96", "93"];
const sessionColors = new Map<string, string>();
function sessionTag(sessionId: string | undefined): string {
  if (!sessionId) return "-";
  if (!process.stderr.isTTY || isJsonEnabled()) return sessionId;
  let color = sessionColors.get(sessionId);
  if (!color) {
    color = SESSION_ANSI_COLORS[sessionColors.size % SESSION_ANSI_COLORS.length] ?? SESSION_ANSI_COLORS[0]!;
    sessionColors.set(sessionId, color);
  }
  return `\x1b[${color}m${sessionId}\x1b[0m`;
}

// ── Process lifecycle diagnostics ───────────────────────────────────────────
// Registered at module load, before any async work, so they're in place even
// if the process dies during config load / app build. Goal: every exit path —
// graceful signal, uncaught error, or just falling off the event loop — leaves
// a log line with pid + uptime, so a SIGKILL from outside the process is the
// only way to die *without* a trace here (heartbeat narrows that case down to
// the last interval).
const uptimeS = () => process.uptime().toFixed(1);

logger.info(`process starting (pid=${process.pid}, ppid=${process.ppid})`);

process.on("exit", (code) => {
  logger.info(`process exit code=${code} pid=${process.pid} uptime=${uptimeS()}s`);
});

process.on("uncaughtException", (err) => {
  logger.error(
    `uncaughtException pid=${process.pid} uptime=${uptimeS()}s: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
});

process.on("unhandledRejection", (reason) => {
  logger.error(
    `unhandledRejection pid=${process.pid} uptime=${uptimeS()}s: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  );
});

// Signals whose default action terminates the process. Registering a handler
// preempts that default so we get a log line first, then shut down ourselves.
for (const sig of ["SIGHUP", "SIGQUIT", "SIGUSR2"] as const) {
  process.on(sig, () => {
    logger.warn(`${sig} received (pid=${process.pid}, uptime=${uptimeS()}s) — exiting`);
    process.exit(0);
  });
}

if (process.env.MCPGATE_DEBUG_HEARTBEAT !== "0") {
  const heartbeat = setInterval(() => {
    const mem = process.memoryUsage();
    logger.debug(
      `heartbeat pid=${process.pid} uptime=${uptimeS()}s rss=${(mem.rss / 1024 / 1024).toFixed(1)}MB heapUsed=${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`,
    );
  }, 2000);
  heartbeat.unref();
}

async function main() {
  logger.info(`loading configuration (pid=${process.pid}, uptime=${uptimeS()}s)`);
  const { config, dir } = await loadConfigAsync();
  logger.info(`loaded configuration from ${dir} (uptime=${uptimeS()}s)`);

  await initTracing(config.tracing);

  // ── Production-readiness gate ────────────────────────────────────────────
  // Refuse to start in production with permissive settings, instead of warning
  // into a log nobody reads. Non-production keeps the convenient defaults and
  // just reports what would be fatal, so the same config surfaces the same list
  // before it is promoted.
  const readiness = checkProductionReadiness(config);
  for (const w of readiness.warnings) {
    logger.warn(`readiness: ${w}`);
  }
  if (readiness.fatal.length > 0) {
    for (const f of readiness.fatal) {
      logger.error(`readiness (fatal): ${f}`);
    }
    logger.error(
      `refusing to start in '${readiness.environment}': ${readiness.fatal.length} ` +
        "production-readiness check(s) failed. Fix the settings above, or run with " +
        "MCPGATE_ENV=development to accept them explicitly.",
    );
    process.exit(1);
  }
  logger.info(
    `production-readiness gate passed (environment=${readiness.environment}, ` +
      `warnings=${readiness.warnings.length})`,
  );

  logger.info(`building app (uptime=${uptimeS()}s)`);
  const handle = await buildApp(config);
  logger.info(`app built (uptime=${uptimeS()}s)`);

  // Structured logging for every monitor event.
  handle.bus.subscribe((event) => {
    switch (event.type) {
      case "auth":
        logger.info(
          `auth session=${sessionTag(event.sessionId)} user=${event.username}`,
          {
            scopes: event.meta?.scopes,
            // Claims may contain PII — log at debug only.
            ...(process.env.MCPGATE_LOG_LEVEL === "debug" ? { claims: event.meta?.claims } : {}),
          },
        );
        break;
      case "auth_failure":
        logger.warn(
          `auth_failure user=${event.username ?? "-"} tool=${event.tool ?? "-"} ${event.message}`,
          event.meta,
        );
        break;
      case "tool_call":
        logger.info(
          `→ tool_call session=${sessionTag(event.sessionId)} user=${event.username} tool=${event.tool}`,
          // Arguments may contain user/PII data — debug only.
          process.env.MCPGATE_LOG_LEVEL === "debug"
            ? { args: event.meta?.arguments }
            : undefined,
        );
        break;
      case "tool_result": {
        const base = `← tool_result session=${sessionTag(event.sessionId)} user=${event.username} tool=${event.tool} status=${event.status} ${event.durationMs}ms`;
        if (process.env.MCPGATE_LOG_LEVEL === "debug") {
          // sql/bindings are kept out of the live console: they're large and
          // already captured in the audit log (monitor/audit.ts) when enabled.
          const meta = event.meta ? { ...event.meta } : undefined;
          if (meta) delete meta.query;
          logger.debug(base, meta && Object.keys(meta).length > 0 ? meta : undefined);
        } else if (event.status === "error") {
          // Error summaries are bounded by McpToolDispatcher and redacted once
          // more by the logger. This keeps normal INFO logs useful without
          // dumping a full tool payload or caller arguments.
          logger.info(base, {
            ...(event.message !== undefined ? { error: event.message } : {}),
            ...(typeof event.meta?.error_code === "string"
              ? { error_code: event.meta.error_code }
              : {}),
          });
        } else {
          logger.info(base);
        }
        break;
      }
      case "llm_request":
        logger.info(
          `→ llm_request session=${sessionTag(event.sessionId)} user=${event.username} phase=${event.meta?.phase} tool=${event.tool ?? "-"}`,
        );
        break;
      case "llm_response":
        logger.info(
          `← llm_response session=${sessionTag(event.sessionId)} user=${event.username} phase=${event.meta?.phase} tool=${event.tool ?? "-"} message=${event.message}`,
        );
        break;
      case "router":
        logger.info(
          `router user=${event.username ?? "-"} status=${event.status} message=${event.message}${event.tool ? ` tool=${event.tool}` : ""}`,
        );
        // Log the full system prompt only when it changes, and only at debug.
        if (typeof event.meta?.prompt === "string") {
          logger.debug("system_prompt_updated", { length: event.meta.prompt.length, prompt: event.meta.prompt });
        }
        break;
      case "error":
        logger.error(
          `error session=${sessionTag(event.sessionId)} tool=${event.tool ?? "-"} ${event.message}`,
        );
        break;
    }
  });

  const authMode = config.auth.mode;
  const dbNames = handle.db.names().join(", ") || "none";
  logger.info(
    `auth mode: ${authMode} · databases: ${dbNames} · tools: ${handle.registry.size}`,
  );
  if (config.router?.enabled) {
    logger.info(
      `router '${config.router.name}' enabled (mode: ${config.router.mode}, model: ${config.router.llm!.model})`,
    );
  }
  // Open-dashboard / allowWrite / forwardBearerToken warnings are now owned by
  // the production-readiness gate above, so they cannot drift apart from the
  // fatal-in-production versions of the same checks. Only the playground's
  // fail-closed behaviour is reported here, since it is informational rather
  // than a misconfiguration.
  if (
    config.monitoring.enabled &&
    config.monitoring.playground.enabled &&
    !config.monitoring.token &&
    !config.monitoring.oidc
  ) {
    logger.warn(
      "monitoring.playground is enabled but neither monitoring.token nor monitoring.oidc is set " +
        "— the playground will refuse to run tools until one is configured (fail-closed).",
    );
  }

  const server = handle.app.listen(config.server.port, config.server.host, () => {
    logger.info(
      `listening on http://${config.server.host}:${config.server.port}` +
        ` · MCP at ${config.server.mcpPath} (Streamable HTTP) and ${config.server.ssePath} (SSE)` +
        ` · monitor at / (pid=${process.pid}, uptime=${uptimeS()}s)`,
    );
  });

  // ── Hot-reload of tool definitions ──────────────────────────────────────────
  // Watch the config directory and rebuild the in-memory tool set on change,
  // without dropping sessions. Tool changes apply live; server/auth/database/
  // router/MQTT changes still require a restart.
  let watcher: FSWatcher | undefined;
  if (config.server.reload.enabled) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reloading = false;
    const trigger = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (reloading) return;
        reloading = true;
        void loadConfigAsync(dir)
          .then(({ config: fresh }) => {
            handle.registry.reload(fresh.tools, fresh.schemaCompatibility.mode);
            // Governance rules are compiled once per config version; swap the
            // compiled policy in place so open sessions use the new rules too.
            handle.reloadPolicies(fresh.policies);
            logger.info(`config reloaded: ${handle.registry.size} tools`);
          })
          .catch((err) => {
            logger.error(
              `config reload failed, keeping previous tool set: ${err instanceof Error ? err.message : String(err)}`,
            );
          })
          .finally(() => {
            reloading = false;
          });
      }, config.server.reload.debounceMs);
      timer.unref?.();
    };
    try {
      watcher = watch(dir, { recursive: true }, () => trigger());
      logger.info(`hot-reload enabled — watching ${dir} for tool changes`);
    } catch (err) {
      logger.warn(`hot-reload could not start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down... (pid=${process.pid}, uptime=${uptimeS()}s, activeRequests=${handle.activeRequests()})`);
    // Stop accepting new connections, let in-flight requests finish, then
    // tear down database/MQTT pools and flush the audit log.
    watcher?.close();
    server.close();
    await handle.drain(10_000);
    await handle.shutdown();
    await shutdownTracing();
    logger.info(`shutdown complete, exiting (pid=${process.pid}, uptime=${uptimeS()}s)`);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.main) {
  main().catch((err) => {
    logger.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
