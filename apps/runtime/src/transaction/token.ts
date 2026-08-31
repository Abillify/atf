// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { jwtVerify, SignJWT } from "jose";
import { TRANSACTION_PROTOCOL_VERSION } from "./types.js";
import type { EnforcementMode, TransactionEnvelope } from "./types.js";

const DEFAULT_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 300;
export interface TransactionTokenConfig { issuer: string; audience: string; secret: string; ttlSeconds?: number; enforcement?: EnforcementMode }
export type UnsignedTransactionEnvelope = Omit<TransactionEnvelope, "version" | "iss" | "aud" | "iat" | "exp" | "jti"> & { jti?: string };

function key(secret: string): Uint8Array { return new TextEncoder().encode(secret); }
function ttl(value = DEFAULT_TTL_SECONDS): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TTL_SECONDS) throw new Error(`Transaction token TTL must be between 1 and ${MAX_TTL_SECONDS} seconds`);
  return value;
}
export class TransactionTokenIssuer {
  readonly enforcement: EnforcementMode;
  constructor(private readonly config: TransactionTokenConfig, private readonly now = () => Date.now()) {
    if (config.secret.length < 32) throw new Error("Transaction signing secret must contain at least 32 characters");
    this.enforcement = config.enforcement ?? "optional";
    ttl(config.ttlSeconds);
  }
  async issue(input: UnsignedTransactionEnvelope): Promise<string> {
    const issuedAt = Math.floor(this.now() / 1000);
    return new SignJWT({ ...input, version: TRANSACTION_PROTOCOL_VERSION })
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt" }).setIssuer(this.config.issuer)
      .setAudience(this.config.audience).setIssuedAt(issuedAt).setExpirationTime(issuedAt + ttl(this.config.ttlSeconds))
      .setJti(input.jti ?? crypto.randomUUID()).sign(key(this.config.secret));
  }
}
export class TransactionTokenValidator {
  constructor(private readonly config: TransactionTokenConfig, private readonly now = () => Date.now()) {}
  async validate(token: string | undefined): Promise<TransactionEnvelope | undefined> {
    const mode = this.config.enforcement ?? "optional";
    if (!token) { if (mode === "required") throw new Error("Transaction token is required"); return undefined; }
    if (mode === "off") return undefined;
    const { payload, protectedHeader } = await jwtVerify(token, key(this.config.secret), { issuer: this.config.issuer, audience: this.config.audience, algorithms: ["HS256"], currentDate: new Date(this.now()) });
    if (protectedHeader.typ !== "at+jwt" || payload.version !== TRANSACTION_PROTOCOL_VERSION) throw new Error("Unsupported transaction token protocol");
    if (typeof payload.executionId !== "string" || typeof payload.invocationId !== "string" || !Array.isArray(payload.scopes) || !Array.isArray(payload.groups) || typeof payload.budget !== "object" || !Array.isArray(payload.delegationChain) || typeof payload.trace !== "object") throw new Error("Invalid transaction envelope");
    return payload as unknown as TransactionEnvelope;
  }
}
export function transactionTokenConfigFromEnv(env: Record<string, string | undefined> = process.env): TransactionTokenConfig | undefined {
  const secret = env.AGENT_TRANSACTION_SECRET;
  if (!secret) return undefined;
  const mode = env.AGENT_TRANSACTION_ENFORCEMENT;
  if (mode !== undefined && mode !== "off" && mode !== "optional" && mode !== "required") throw new Error("Invalid AGENT_TRANSACTION_ENFORCEMENT");
  return { secret, issuer: env.AGENT_TRANSACTION_ISSUER ?? "aiperator", audience: env.AGENT_TRANSACTION_AUDIENCE ?? "agent-transaction-fabric", ...(env.AGENT_TRANSACTION_TTL_SECONDS ? { ttlSeconds: Number(env.AGENT_TRANSACTION_TTL_SECONDS) } : {}), ...(mode ? { enforcement: mode } : {}) };
}
