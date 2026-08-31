// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import crypto from "node:crypto";
import type { RequestContext } from "../types/monitoring.js";

export interface PersistedExecutionContext {
  claims?: Record<string, unknown>;
  clientId?: string;
  userId?: string;
  userEmail?: string;
  role?: string;
  groups?: string[];
}

export interface VerifiedExecutionContextEnvelope {
  version: 1;
  context: PersistedExecutionContext;
  signature: string;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  throw new TypeError("Execution context contains a non-JSON value.");
}

function canonicalContext(context: PersistedExecutionContext): string {
  return stableJson({ version: 1, context });
}

function signature(context: PersistedExecutionContext, secret: string): string {
  return crypto.createHmac("sha256", secret).update(canonicalContext(context)).digest("hex");
}

export function createVerifiedExecutionContext(
  requestCtx: RequestContext,
  secret: string | undefined,
): VerifiedExecutionContextEnvelope | undefined {
  if (secret === undefined || secret.length === 0) return undefined;
  const context: PersistedExecutionContext = {
    ...(requestCtx.claims !== undefined ? { claims: requestCtx.claims } : {}),
    ...(requestCtx.clientId !== undefined ? { clientId: requestCtx.clientId } : {}),
    ...(requestCtx.userId !== undefined ? { userId: requestCtx.userId } : {}),
    ...(requestCtx.userEmail !== undefined ? { userEmail: requestCtx.userEmail } : {}),
    ...(requestCtx.role !== undefined ? { role: requestCtx.role } : {}),
    ...(requestCtx.groups !== undefined ? { groups: requestCtx.groups } : {}),
  };
  if (Object.keys(context).length === 0) return undefined;
  return { version: 1, context, signature: signature(context, secret) };
}

export function verifyExecutionContext(
  value: unknown,
  secret: string | undefined,
): PersistedExecutionContext | undefined {
  if (secret === undefined || secret.length === 0 || value === null || typeof value !== "object") {
    return undefined;
  }
  const envelope = value as Partial<VerifiedExecutionContextEnvelope>;
  if (
    envelope.version !== 1 ||
    envelope.context === null ||
    typeof envelope.context !== "object" ||
    typeof envelope.signature !== "string" ||
    !/^[a-f0-9]{64}$/u.test(envelope.signature)
  ) return undefined;
  const context = envelope.context as PersistedExecutionContext;
  let expected: string;
  try {
    expected = signature(context, secret);
  } catch {
    return undefined;
  }
  const actualBuffer = Buffer.from(envelope.signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) return undefined;
  // Reconstruct only the authorization fields explicitly admitted by this schema.
  return {
    ...(context.claims !== undefined && context.claims !== null && typeof context.claims === "object" && !Array.isArray(context.claims)
      ? { claims: context.claims }
      : {}),
    ...(typeof context.clientId === "string" ? { clientId: context.clientId } : {}),
    ...(typeof context.userId === "string" ? { userId: context.userId } : {}),
    ...(typeof context.userEmail === "string" ? { userEmail: context.userEmail } : {}),
    ...(typeof context.role === "string" ? { role: context.role } : {}),
    ...(Array.isArray(context.groups) && context.groups.every((group) => typeof group === "string")
      ? { groups: context.groups }
      : {}),
  };
}

export function contextRequiresAttestation(requestCtx: RequestContext): boolean {
  return requestCtx.claims !== undefined || requestCtx.clientId !== undefined ||
    requestCtx.userId !== undefined || requestCtx.userEmail !== undefined ||
    requestCtx.role !== undefined || requestCtx.groups !== undefined;
}
