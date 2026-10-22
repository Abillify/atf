// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { AuthContext } from "../auth/context.ts";
import type { GovernanceConfig, PolicyRule } from "../config/schema.ts";
import { sign, stable } from "../crypto/canonical.ts";
import {
  defaultApprovalConsumptionStore,
  type ApprovalConsumptionStore,
} from "./approval-store.ts";

export const APPROVAL_TOKEN_META_KEY = "io.modelcontextprotocol/approvalToken";

/**
 * Pre-hardening canonicalisation with `localeCompare` key order. Kept only so
 * approval tokens minted before the switch stay verifiable until they expire
 * (Req 6.4: "existing approval tokens stay valid until they expire").
 */
function stableLocaleLegacy(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stableLocaleLegacy).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableLocaleLegacy(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function approvalArgsFingerprint(args: Record<string, unknown>): string {
  return createHash("sha256").update(stable(args)).digest("base64url");
}
/** Legacy fingerprint accepted by `verifyApproval` for pre-migration tokens. */
export function approvalArgsFingerprintLegacy(args: Record<string, unknown>): string {
  return createHash("sha256").update(stableLocaleLegacy(args)).digest("base64url");
}
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}
function atPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
/** Groups of the caller, read from the configured `oauth.groupClaim` (Req 6.2). */
function groupsFrom(ctx: AuthContext, claim: string): string[] {
  const raw = atPath(ctx.claims, claim);
  return Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === "string")
    : typeof raw === "string"
      ? raw.split(/[ ,]+/).filter(Boolean)
      : [];
}

/** A policy rule with its match predicates precompiled once at load time (Req 6.3). */
export interface CompiledPolicyRule {
  readonly rule: PolicyRule;
  readonly toolPattern: RegExp | undefined;
  readonly subjects: ReadonlySet<string> | undefined;
  readonly groups: ReadonlySet<string> | undefined;
  readonly argumentEquals: ReadonlyArray<{ path: string; value: string }> | undefined;
}

/** Result of `compilePolicy`: the whole policy set with precompiled matchers. */
export interface CompiledPolicy {
  readonly config: GovernanceConfig;
  /** Claim the group predicates read from, from `oauth.groupClaim` (Req 6.2). */
  readonly groupClaim: string;
  readonly rules: readonly CompiledPolicyRule[];
}

/**
 * Compile the policy set once per configuration version: globs become RegExp,
 * subject/group lists become Sets and `argumentEquals` expectations become
 * pre-canonicalised strings, so a call only runs the compiled predicates
 * (Req 6.3).
 */
export function compilePolicy(
  config: GovernanceConfig,
  options: { groupClaim?: string } = {},
): CompiledPolicy {
  return {
    config,
    groupClaim: options.groupClaim ?? "groups",
    rules: config.rules.map((rule): CompiledPolicyRule => ({
      rule,
      toolPattern: rule.match.tool ? globToRegExp(rule.match.tool) : undefined,
      subjects: rule.match.subjects ? new Set(rule.match.subjects) : undefined,
      groups: rule.match.groups ? new Set(rule.match.groups) : undefined,
      argumentEquals: rule.match.argumentEquals
        ? Object.entries(rule.match.argumentEquals).map(([path, expected]) => ({
            path,
            value: stable(expected),
          }))
        : undefined,
    })),
  };
}

function matchesCompiled(
  compiled: CompiledPolicyRule,
  ctx: AuthContext,
  tool: string,
  access: "read" | "write",
  args: Record<string, unknown>,
  groups: readonly string[],
): boolean {
  const match = compiled.rule.match;
  if (compiled.toolPattern && !compiled.toolPattern.test(tool)) return false;
  if (match.access && match.access !== access) return false;
  if (match.requiredScopes?.some((s) => !ctx.scopes.includes(s))) return false;
  if (compiled.subjects && !compiled.subjects.has(ctx.subject)) return false;
  if (compiled.groups && !groups.some((g) => compiled.groups?.has(g)))
    return false;
  if (
    compiled.argumentEquals?.some(
      ({ path, value }) => stable(atPath(args, path)) !== value,
    )
  )
    return false;
  return true;
}

/**
 * Whether an approval token was resolved by its own requester. `aown` (the
 * resolver's `approvalOwner` hash) decides when present. Tokens without it
 * fall back to the identity: `ctx` is the token's owner here (`sub` is
 * checked against `approvalOwner(ctx)` first), so an `approver` equal to the
 * owner's subject or hash marks a self-resolve.
 */
function isSelfResolved(
  d: { approver: string; aown?: string; sub: string },
  ctx: AuthContext,
): boolean {
  if (typeof d.aown === "string" && d.aown !== "") return d.aown === d.sub;
  return d.approver === d.sub || d.approver === ctx.subject;
}
export function approvalOwner(ctx: AuthContext): string {
  return createHash("sha256")
    .update(stable({
      method: ctx.method,
      issuer: ctx.claims.iss,
      subject: ctx.subject,
      tenant: ctx.tenantId,
    }))
    .digest("base64url");
}

export interface ApprovalRequest {
  subject: string;
  tool: string;
  argsFingerprint: string;
  requestState: string;
  evidenceContractHash?: string;
}
export interface MintApprovalOptions extends ApprovalRequest {
  approver: string;
  /**
   * `approvalOwner` hash of the resolving principal. Signed into the token so
   * `verifyApproval` can tell a self-resolved approval from a foreign one by
   * the same identity hash it binds `sub` to (`approver` is the plain subject).
   */
  approverOwner?: string;
  secret: string;
  ttlMs: number;
  now?: number;
  jti?: string;
}
export function mintApprovalToken(options: MintApprovalOptions): string {
  if (!options.approver.trim()) throw new Error("Approver identity is required");
  const now = options.now ?? Date.now();
  const payload = Buffer.from(
    JSON.stringify({
      jti: options.jti ?? randomUUID(),
      approver: options.approver,
      ...(options.approverOwner !== undefined ? { aown: options.approverOwner } : {}),
      sub: options.subject,
      tool: options.tool,
      args: options.argsFingerprint,
      // Fingerprint canonicalisation marker (Req 6.4): `2` is the code-unit
      // sort order; tokens minted before this change carry no marker and were
      // canonicalised with `localeCompare`.
      fp: 2,
      requestState: options.requestState,
      ...(options.evidenceContractHash !== undefined
        ? { evidence: options.evidenceContractHash }
        : {}),
      iat: now,
      exp: now + options.ttlMs,
    }),
  ).toString("base64url");
  return `${payload}.${sign(payload, options.secret)}`;
}
/** Everything one governance check needs, from a single rule scan (Req 6.3). */
export interface PolicyDecision {
  readonly effect: "allow" | "deny" | "approval";
  readonly rule: PolicyRule | undefined;
  readonly requiresEvidenceContract: boolean;
}

export class GovernancePolicy {
  private readonly compiled: CompiledPolicy;

  constructor(
    configOrCompiled: GovernanceConfig | CompiledPolicy,
    /**
     * Redeemed-JTI store (Req 6.1). Injected so every per-request policy
     * instance shares one reservation set; defaults to the process-wide
     * memory map for tests and auxiliary dispatch paths.
     */
    private readonly consumed: ApprovalConsumptionStore = defaultApprovalConsumptionStore,
  ) {
    this.compiled =
      "config" in configOrCompiled
        ? (configOrCompiled as CompiledPolicy)
        : compilePolicy(configOrCompiled as GovernanceConfig);
  }
  private get config(): GovernanceConfig {
    return this.compiled.config;
  }
  matchingRule(
    ctx: AuthContext,
    tool: string,
    access: "read" | "write",
    args: Record<string, unknown>,
  ): PolicyRule | undefined {
    const groups = groupsFrom(ctx, this.compiled.groupClaim);
    for (const compiled of this.compiled.rules) {
      if (matchesCompiled(compiled, ctx, tool, access, args, groups))
        return compiled.rule;
    }
    return undefined;
  }
  /**
   * Resolve effect, matched rule and evidence-contract requirement with one
   * pass over the compiled rules, so a call never searches twice (Req 6.3).
   */
  evaluate(
    ctx: AuthContext,
    tool: string,
    access: "read" | "write",
    args: Record<string, unknown>,
  ): PolicyDecision {
    const groups = groupsFrom(ctx, this.compiled.groupClaim);
    for (const compiled of this.compiled.rules) {
      if (matchesCompiled(compiled, ctx, tool, access, args, groups))
        return {
          effect: compiled.rule.effect,
          rule: compiled.rule,
          requiresEvidenceContract:
            compiled.rule.requireEvidenceContract === true,
        };
    }
    return {
      effect: this.compiled.config.defaultEffect,
      rule: undefined,
      requiresEvidenceContract: false,
    };
  }
  decide(
    ctx: AuthContext,
    tool: string,
    access: "read" | "write",
    args: Record<string, unknown>,
  ): "allow" | "deny" | "approval" {
    return this.evaluate(ctx, tool, access, args).effect;
  }
  requiresEvidenceContract(
    ctx: AuthContext,
    tool: string,
    access: "read" | "write",
    args: Record<string, unknown>,
  ): boolean {
    return this.evaluate(ctx, tool, access, args).requiresEvidenceContract;
  }
  approvalRequest(
    ctx: AuthContext,
    tool: string,
    args: Record<string, unknown>,
  ): ApprovalRequest {
    return {
      subject: approvalOwner(ctx),
      tool,
      argsFingerprint: approvalArgsFingerprint(args),
      requestState: randomUUID(),
    };
  }
  async verifyApproval(
    token: unknown,
    ctx: AuthContext,
    tool: string,
    args: Record<string, unknown>,
    evidenceContractHash?: string,
    consume = true,
  ): Promise<boolean> {
    const secret =
      this.config.approval.secret || process.env.MCPGATE_APPROVAL_SECRET;
    if (!secret || typeof token !== "string") return false;
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return false;
    const expected = sign(payload, secret);
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      return false;
    try {
      const d = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
        jti: string;
        approver: string;
        aown?: string;
        sub: string;
        tool: string;
        args: string;
        fp?: number;
        requestState: string;
        evidence?: string;
        exp: number;
      };
      const now = Date.now();
      // Tokens minted before the code-unit switch (no `fp` marker) were
      // canonicalised with `localeCompare`; accept them until they expire
      // (Req 6.4).
      const expectedFingerprint =
        d.fp === undefined
          ? approvalArgsFingerprintLegacy(args)
          : approvalArgsFingerprint(args);
      if (
        !d.jti ||
        !d.approver ||
        !d.requestState ||
        d.sub !== approvalOwner(ctx) ||
        d.tool !== tool ||
        d.args !== expectedFingerprint ||
        d.evidence !== evidenceContractHash ||
        d.exp <= now ||
        // Self-resolved tokens stay valid until expiry when the flag was
        // enabled after they were issued; reject them.
        (this.config.approval.requireDifferentApprover === true &&
          isSelfResolved(d, ctx))
      )
        return false;
      return !consume || (await this.consumed.consume(d.jti, d.exp));
    } catch {
      return false;
    }
  }
}

/**
 * Swappable holder for the process-wide compiled policy. `buildApp` creates
 * one `GovernancePolicy` per configuration version (Req 6.3); hot-reload
 * replaces `current` in place so transports and open sessions pick up the
 * new compiled rules without a restart (design: "replaced on hot reload").
 */
export interface GovernancePolicyRef {
  current: GovernancePolicy | undefined;
}
