// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Semantic validation of a merged configuration (requirements 1.4, 1.5, 1.6,
 * 6.10, 12.7).
 *
 * The zod schema in `schema.ts` covers shapes; the rules here need more than
 * one field or must report *every* problem at once: an administrator who sets
 * a bad collection name and a plain-HTTP URL in one file should learn about
 * both from a single run rather than fixing them one restart apart. That is
 * why `validateConfig` collects a `ConfigError[]` instead of throwing on the
 * first violation.
 */

import type { z } from "zod";
import {
  COLLECTION_PATTERN,
  COLLECTION_REGEX,
  outpostConfigSchema,
  type OutpostConfig,
  type SourceConfig,
} from "./schema.js";

export interface ConfigError {
  /** Dotted path of the offending value, e.g. `sources[2].collection`. */
  path: string;
  message: string;
}

export type Result<T, E> = { ok: true; value: T } | { ok: false; errors: E };

/**
 * Map a source id onto the `<ID>` segment of `OUTPOST_SOURCE_<ID>_*` names:
 * upper-cased, every character outside `[A-Z0-9]` replaced by `_`.
 */
export function sourceEnvId(sourceId: string): string {
  return sourceId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/**
 * Accept `https` always; accept `http` only with the development flag on and
 * only for `localhost`/`127.0.0.1`, for any port and path (requirements 1.5,
 * 1.6). Anything that is not an absolute URL with a host is rejected.
 */
export function isExtractUrlAllowed(
  url: string,
  allowInsecureLocalhost: boolean,
): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "is not an absolute URL" };
  }
  if (parsed.hostname === "") {
    return { ok: false, reason: "has no host" };
  }
  if (parsed.protocol === "https:") return { ok: true };
  if (parsed.protocol === "http:") {
    if (!allowInsecureLocalhost) {
      return {
        ok: false,
        reason: "uses http; only https is accepted unless allowInsecureLocalhost is true",
      };
    }
    if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      return {
        ok: false,
        reason:
          "uses http for a non-local host; allowInsecureLocalhost only permits localhost and 127.0.0.1",
      };
    }
    return { ok: true };
  }
  return { ok: false, reason: `has unsupported scheme "${parsed.protocol}"` };
}

/** The collection a source uploads to: its own override, else the global one. */
export function effectiveCollection(
  src: Pick<SourceConfig, "collection">,
  cfg: Pick<OutpostConfig, "collection">,
): string {
  return src.collection ?? cfg.collection;
}

function collectionErrors(collection: string, path: string): ConfigError[] {
  if (COLLECTION_REGEX.test(collection)) return [];
  return [
    {
      path,
      message: `collection "${collection}" does not match the required pattern ${COLLECTION_PATTERN}`,
    },
  ];
}

function zodErrors(error: z.ZodError): ConfigError[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)",
    message: issue.message,
  }));
}

/**
 * Parse and validate a merged configuration object. Structural problems come
 * from zod, cross-field rules from this module; both are merged into one
 * ordered error list.
 */
export function validateConfig(
  input: unknown,
): Result<OutpostConfig, ConfigError[]> {
  const parsed = outpostConfigSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
  const cfg = parsed.data;

  const errors: ConfigError[] = [];

  errors.push(...collectionErrors(cfg.collection, "collection"));
  for (const [index, src] of cfg.sources.entries()) {
    if (src.collection !== undefined) {
      errors.push(...collectionErrors(src.collection, `sources[${index}].collection`));
    }
  }

  const url = isExtractUrlAllowed(cfg.extractUrl, cfg.allowInsecureLocalhost);
  if (!url.ok) {
    errors.push({ path: "extractUrl", message: `extractUrl "${cfg.extractUrl}" ${url.reason}` });
  }

  // Two source ids that collapse to the same `OUTPOST_SOURCE_<ID>_*` name
  // would read each other's secrets (requirement 6.10).
  const envIds = new Map<string, string>();
  for (const src of cfg.sources) {
    const envId = sourceEnvId(src.id);
    const first = envIds.get(envId);
    if (first !== undefined && first !== src.id) {
      errors.push({
        path: "sources",
        message: `source ids "${first}" and "${src.id}" both map to the environment name segment ${envId}`,
      });
    }
    envIds.set(envId, src.id);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: cfg };
}
