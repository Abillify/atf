// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { AuthContext } from "../auth/context.ts";
import type { GovernanceConfig, PolicyRule } from "../config/schema.ts";

export const APPROVAL_TOKEN_META_KEY = "io.modelcontextprotocol/approvalToken";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}
export function approvalArgsFingerprint(args: Record<string, unknown>): string {
  return createHash("sha256").update(stable(args)).digest("base64url");
}
function glob(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(value);
}
function atPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
function groups(ctx: AuthContext): string[] {
  const raw = ctx.claims.groups;
  return Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === "string")
    : typeof raw === "string"
      ? raw.split(/[ ,]+/).filter(Boolean)
      : [];
}
function matches(
  rule: PolicyRule,
  ctx: AuthContext,
  tool: string,
  access: "read" | "write",
  args: Record<string, unknown>,
): boolean {
  const match = rule.match;
  if (match.tool && !glob(match.tool, tool)) return false;
  if (match.access && match.access !== access) return false;
  if (match.requiredScopes?.some((s) => !ctx.scopes.includes(s))) return false;
  if (match.subjects && !match.subjects.includes(ctx.subject)) return false;
  if (match.groups && !match.groups.some((g) => groups(ctx).includes(g))) return false;
  if (
    match.argumentEquals &&
    Object.entries(match.argumentEquals).some(([p, e]) => stable(atPath(args, p)) !== stable(e))
  )
    return false;
  return true;
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
      sub: options.subject,
      tool: options.tool,
      args: options.argsFingerprint,
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
class ApprovalConsumptionStore {
  private used = new Map<string, number>();
  constructor(private maxEntries = 10_000) {}
  consume(jti: string, exp: number, now: number): boolean {
    for (const [id, e] of this.used) if (e <= now) this.used.delete(id);
    if (this.used.has(jti)) return false;
    while (this.used.size >= this.maxEntries)
      this.used.delete(this.used.keys().next().value as string);
    this.used.set(jti, exp);
    return true;
  }
}
const consumed = new ApprovalConsumptionStore();

export class GovernancePolicy {
  constructor(private readonly config: GovernanceConfig) {}
  matchingRule(
    ctx: AuthContext,
    tool: string,
    access: "read" | "write",
    args: Record<string, unknown>,
  ): PolicyRule | undefined {
    return this.config.rules.find((r) => matches(r, ctx, tool, access, args));
  }
  decide(
    ctx: AuthContext,
    tool: string,
    access: "read" | "write",
    args: Record<string, unknown>,
  ): "allow" | "deny" | "approval" {
    return this.matchingRule(ctx, tool, access, args)?.effect ?? this.config.defaultEffect;
  }
  requiresEvidenceContract(
    ctx: AuthContext,
    tool: string,
    access: "read" | "write",
    args: Record<string, unknown>,
  ): boolean {
    return this.matchingRule(ctx, tool, access, args)?.requireEvidenceContract === true;
  }
  approvalRequest(ctx: AuthContext, tool: string, args: Record<string, unknown>): ApprovalRequest {
    return {
      subject: approvalOwner(ctx),
      tool,
      argsFingerprint: approvalArgsFingerprint(args),
      requestState: randomUUID(),
    };
  }
  verifyApproval(
    token: unknown,
    ctx: AuthContext,
    tool: string,
    args: Record<string, unknown>,
    evidenceContractHash?: string,
    consume = true,
  ): boolean {
    const secret = this.config.approval.secret || process.env.MCPGATE_APPROVAL_SECRET;
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
        sub: string;
        tool: string;
        args: string;
        requestState: string;
        evidence?: string;
        exp: number;
      };
      const now = Date.now();
      if (
        !d.jti ||
        !d.approver ||
        !d.requestState ||
        d.sub !== approvalOwner(ctx) ||
        d.tool !== tool ||
        d.args !== approvalArgsFingerprint(args) ||
        d.evidence !== evidenceContractHash ||
        d.exp <= now
      )
        return false;
      return !consume || consumed.consume(d.jti, d.exp, now);
    } catch {
      return false;
    }
  }
}
