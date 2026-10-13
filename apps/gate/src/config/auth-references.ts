// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { AppConfig } from "./schema.ts";

/**
 * Auth values that influence the loaded configuration and are therefore useful
 * in monitor auth events. Token payload fields outside this set are omitted.
 */
export interface AuthDisplayReferences {
  scopes: ReadonlySet<string>;
  claims: ReadonlySet<string>;
}

function addStrings(target: Set<string>, value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value) if (typeof item === "string") target.add(item);
}

function collectConditionReferences(value: unknown, scopes: Set<string>, claims: Set<string>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const condition of Object.values(value as Record<string, unknown>)) {
    if (!condition || typeof condition !== "object" || Array.isArray(condition)) continue;
    for (const rules of Object.values(condition as Record<string, unknown>)) {
      if (!Array.isArray(rules)) continue;
      for (const rule of rules) {
        if (!rule || typeof rule !== "object" || Array.isArray(rule)) continue;
        const item = rule as Record<string, unknown>;
        if (item.context === "scopes") {
          addStrings(scopes, item.containsAny);
          addStrings(scopes, item.containsAll);
          addStrings(scopes, item.in);
        }
        if (typeof item.context === "string" && item.context.startsWith("claims.")) {
          claims.add(item.context.slice("claims.".length).split(".")[0]!);
        }
      }
    }
  }
}

function collectContextClaimReferences(value: unknown, claims: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(/:ctx\.claims\.([A-Za-z0-9_-]+)/g)) claims.add(match[1]!);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectContextClaimReferences(item, claims);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectContextClaimReferences(item, claims);
    }
  }
}

/**
 * Extract scopes and claims that are actually referenced by the final,
 * validated configuration. The caller must pass the result of loadConfig(),
 * after external tool files and condition references have been resolved.
 */
export function authDisplayReferences(config: AppConfig): AuthDisplayReferences {
  const scopes = new Set<string>();
  const claims = new Set<string>();

  const oauth = config.auth.oauth;
  if (oauth) {
    addStrings(scopes, oauth.requiredScopes);
    for (const mappedScopes of Object.values(oauth.groupScopes)) addStrings(scopes, mappedScopes);
    claims.add(oauth.usernameClaim);
    if (Object.keys(oauth.groupScopes).length > 0) claims.add(oauth.groupClaim);
  }

  for (const tool of config.tools) {
    addStrings(scopes, tool.requiredScopes);
    if ("conditions" in tool) collectConditionReferences(tool.conditions, scopes, claims);
  }

  const promptConfigs = [config.instructions, config.router?.systemPrompt, config.router?.write.systemPrompt];
  for (const prompt of promptConfigs) {
    if (!prompt) continue;
    for (const source of prompt.dynamic.sources) addStrings(scopes, source.scopes);
  }

  for (const item of [...config.resources, ...config.prompts, ...config.skills, ...config.apps]) {
    addStrings(scopes, item.requiredScopes);
  }
  for (const rule of config.policies.rules) {
    addStrings(scopes, rule.match.requiredScopes);
    if (rule.match.groups?.length) claims.add("groups");
  }

  collectContextClaimReferences(config, claims);
  return { scopes, claims };
}

/** Return the compact auth meta payload sent to monitor consumers. */
export function projectAuthMeta(
  meta: Record<string, unknown> | undefined,
  references: AuthDisplayReferences,
): Record<string, unknown> | undefined {
  if (!meta) return meta;
  const rawScopes = Array.isArray(meta.scopes) ? meta.scopes : [];
  const scopes = rawScopes.filter(
    (scope): scope is string => typeof scope === "string" && references.scopes.has(scope),
  );
  const rawClaims = meta.claims;
  const claims: Record<string, unknown> = {};
  if (rawClaims && typeof rawClaims === "object" && !Array.isArray(rawClaims)) {
    for (const claim of references.claims) {
      if (Object.hasOwn(rawClaims, claim)) {
        claims[claim] = (rawClaims as Record<string, unknown>)[claim];
      }
    }
  }

  const { scopes: _scopes, claims: _claims, ...rest } = meta;
  return { ...rest, scopes, claims };
}
