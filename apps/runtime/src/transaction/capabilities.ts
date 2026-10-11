// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { TRANSACTION_PROTOCOL_VERSION } from "./types.js";
import type { CapabilityDocument, EnforcementMode } from "./types.js";

export function createCapabilityDocument(input: {
  issuer: string;
  audience: string;
  enforcement?: EnforcementMode;
  maxTokenTtlSeconds?: number;
}): CapabilityDocument {
  return {
    protocol: TRANSACTION_PROTOCOL_VERSION,
    issuer: input.issuer,
    audiences: [input.audience],
    enforcement: input.enforcement ?? "optional",
    signingAlgorithms: ["HS256"],
    features: {
      idempotency: true,
      budgets: true,
      compensation: true,
      evidenceLineage: true,
    },
    maxTokenTtlSeconds: input.maxTokenTtlSeconds ?? 300,
  };
}

export interface CapabilityProvider {
  getTransactionCapabilities?(
    serverName: string,
    opts?: { authToken?: string },
  ): Promise<CapabilityDocument | undefined>;
}

/**
 * Identity the discovery call must run under. For a peer that authenticates the
 * MCP transport per caller, negotiating on a different session can misreport a
 * v1-capable peer as legacy — so the caller bearer is threaded through.
 */
export interface CapabilityNegotiationOptions {
  authToken?: string;
}

export async function negotiateCapabilities(
  provider: CapabilityProvider,
  serverName: string,
  fallback: CapabilityDocument,
  opts: CapabilityNegotiationOptions = {},
): Promise<{ capabilities: CapabilityDocument; negotiated: boolean }> {
  try {
    const capabilities = await provider.getTransactionCapabilities?.(
      serverName,
      opts.authToken !== undefined ? { authToken: opts.authToken } : undefined,
    );
    if (
      capabilities?.protocol === TRANSACTION_PROTOCOL_VERSION &&
      capabilities.signingAlgorithms.includes("HS256")
    ) {
      return { capabilities, negotiated: true };
    }
  } catch {
    // Legacy peers may not implement discovery.
  }
  return { capabilities: fallback, negotiated: false };
}

/**
 * Decides whether a dispatch may carry a v1 transaction envelope.
 * Discovery never consumes an invocation ID. Optional mode deliberately falls
 * back to a legacy call; required mode fails closed before the tool executes.
 */
export async function shouldIssueTransaction(
  provider: CapabilityProvider,
  serverName: string,
  env: Record<string, string | undefined> = process.env,
  opts: CapabilityNegotiationOptions = {},
): Promise<boolean> {
  const enforcement = env.AGENT_TRANSACTION_ENFORCEMENT ?? "optional";
  if (enforcement === "off") return false;
  if (
    enforcement !== "optional" &&
    enforcement !== "required"
  ) {
    throw new Error("Invalid AGENT_TRANSACTION_ENFORCEMENT");
  }

  const fallback = createCapabilityDocument({
    issuer: env.AGENT_TRANSACTION_ISSUER ?? "aiperator",
    audience: serverName,
    enforcement: "optional",
  });
  const negotiation = await negotiateCapabilities(
    provider,
    serverName,
    fallback,
    opts,
  );
  const hasSecret =
    (env.AGENT_TRANSACTION_SECRET !== undefined &&
      env.AGENT_TRANSACTION_SECRET !== "") ||
    ((env.TRANSACTION_SIGNING_ALG ?? "HS256") !== "HS256" &&
      env.TRANSACTION_SIGNING_KEY !== undefined &&
      env.TRANSACTION_SIGNING_KEY !== "");

  if (!negotiation.negotiated) {
    if (enforcement === "required") {
      throw new Error(
        `Transaction protocol v1 is required but server "${serverName}" did not advertise it`,
      );
    }
    return false;
  }
  if (!hasSecret) {
    if (
      enforcement === "required" ||
      negotiation.capabilities.enforcement === "required"
    ) {
      throw new Error(
        `Transaction protocol v1 is required for server "${serverName}" but signing is not configured`,
      );
    }
    return false;
  }
  return true;
}
