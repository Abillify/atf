// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createPublicKey } from "node:crypto";
import {
  calculateJwkThumbprint,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
} from "jose";

/** Imported asymmetric key (jose 6 dropped the `KeyLike` alias). */
type ImportedKey = Awaited<ReturnType<typeof importPKCS8>>;
import { TransactionEnvelopeV1Schema } from "@atf/transaction-contract";
import { TRANSACTION_PROTOCOL_VERSION } from "./types.js";
import type { EnforcementMode, TransactionEnvelope } from "./types.js";

const DEFAULT_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 300;

/**
 * Transaction-token signing algorithms (Req 7.11). HS256 stays configurable
 * for backward compatibility; ES256 and EdDSA are the asymmetric options so
 * verifiers (the Gate) only need the public JWKS, never the signing secret.
 */
export type TransactionSigningAlg = "HS256" | "ES256" | "EdDSA";
const TRANSACTION_SIGNING_ALGS: readonly TransactionSigningAlg[] = [
  "HS256",
  "ES256",
  "EdDSA",
];

export function isTransactionSigningAlg(
  value: string,
): value is TransactionSigningAlg {
  return (TRANSACTION_SIGNING_ALGS as readonly string[]).includes(value);
}

export interface TransactionTokenConfig {
  issuer: string;
  audience: string;
  /** HMAC secret — required for HS256, unused for asymmetric algorithms. */
  secret?: string;
  /** Signing algorithm; defaults to HS256 (backward compatible). */
  alg?: TransactionSigningAlg;
  /** PKCS8 PEM private key — required for ES256/EdDSA (TRANSACTION_SIGNING_KEY). */
  signingKeyPem?: string;
  ttlSeconds?: number;
  enforcement?: EnforcementMode;
}
export type UnsignedTransactionEnvelope = Omit<TransactionEnvelope, "version" | "iss" | "aud" | "iat" | "exp" | "jti"> & { jti?: string };

function key(secret: string): Uint8Array { return new TextEncoder().encode(secret); }
function ttl(value = DEFAULT_TTL_SECONDS): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TTL_SECONDS) throw new Error(`Transaction token TTL must be between 1 and ${MAX_TTL_SECONDS} seconds`);
  return value;
}

/** Resolve the configured algorithm, defaulting to HS256. */
function algOf(config: { alg?: TransactionSigningAlg }): TransactionSigningAlg {
  return config.alg ?? "HS256";
}

/** Import a PKCS8 PEM private key for the given asymmetric algorithm. */
async function importSigningKey(
  pem: string,
  alg: TransactionSigningAlg,
): Promise<ImportedKey> {
  try {
    return await importPKCS8(pem, alg);
  } catch (cause) {
    throw new Error(
      `Transaction signing key could not be imported as a PKCS8 PEM key for ${alg}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * Import the verification (public) key for a PKCS8 PEM private key. Bun's
 * jose rejects private CryptoKeys for verification ("must be of type
 * public"), so the SPKI public key is derived via node:crypto first.
 */
async function importVerificationKey(
  pem: string,
  alg: TransactionSigningAlg,
): Promise<ImportedKey> {
  let spkiPem: string;
  try {
    spkiPem = createPublicKey(pem).export({
      type: "spki",
      format: "pem",
    }) as string;
  } catch (cause) {
    throw new Error(
      `Transaction signing key could not be read as a PKCS8 PEM key for ${alg}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  try {
    return await importSPKI(spkiPem, alg);
  } catch (cause) {
    throw new Error(
      `Transaction verification key could not be imported for ${alg}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * JWK members that may be published. Private/secret scalar (`d`), symmetric
 * key material (`k`), and CRT exponents (`p`,`q`,`dp`,`dq`,`qi`) are never
 * part of this whitelist.
 */
const PUBLIC_JWK_MEMBERS = ["kty", "crv", "x", "y", "n", "e"] as const;

/**
 * Derive the public JWK and its JWK-thumbprint `kid` from a PKCS8 PEM private
 * key. jose's `exportJWK` is NOT usable here: Bun's WebCrypto `importPKCS8`
 * returns a non-extractable CryptoKey, so the public members are read through
 * node:crypto instead — which structurally only ever exposes public material.
 */
export async function transactionPublicJwk(
  pem: string,
  alg: TransactionSigningAlg,
): Promise<{ jwk: Record<string, unknown>; kid: string }> {
  if (alg === "HS256") {
    throw new Error("HS256 has no public JWK — only ES256/EdDSA publish one");
  }
  try {
    const exported = createPublicKey(pem).export({
      format: "jwk",
    }) as Record<string, unknown>;
    const jwk: Record<string, unknown> = {};
    for (const member of PUBLIC_JWK_MEMBERS) {
      if (typeof exported[member] === "string") jwk[member] = exported[member];
    }
    const kid = await calculateJwkThumbprint(
      jwk as Parameters<typeof calculateJwkThumbprint>[0],
    );
    return { jwk, kid };
  } catch (cause) {
    throw new Error(
      `Transaction signing key could not be read as a PKCS8 PEM key for ${alg}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}
export class TransactionTokenIssuer {
  readonly enforcement: EnforcementMode;
  readonly alg: TransactionSigningAlg;
  private imported: Promise<{ key: ImportedKey; kid: string }> | undefined;
  constructor(
    private readonly config: TransactionTokenConfig,
    private readonly now = () => Date.now(),
  ) {
    this.alg = algOf(config);
    if (this.alg === "HS256") {
      if ((config.secret ?? "").length < 32)
        throw new Error(
          "Transaction signing secret must contain at least 32 characters",
        );
    } else if ((config.signingKeyPem ?? "").trim().length === 0) {
      throw new Error(
        `Transaction signing key (PKCS8 PEM, TRANSACTION_SIGNING_KEY) is required when TRANSACTION_SIGNING_ALG=${this.alg}`,
      );
    }
    this.enforcement = config.enforcement ?? "optional";
    ttl(config.ttlSeconds);
  }
  /** Import the asymmetric key once and derive its JWK thumbprint as `kid`. */
  private asymmetricKey(): Promise<{ key: ImportedKey; kid: string }> {
    this.imported ??= (async () => {
      const pem = this.config.signingKeyPem ?? "";
      const signingKey = await importSigningKey(pem, this.alg);
      const { kid } = await transactionPublicJwk(pem, this.alg);
      return { key: signingKey, kid };
    })();
    return this.imported;
  }
  async issue(input: UnsignedTransactionEnvelope): Promise<string> {
    const issuedAt = Math.floor(this.now() / 1000);
    const builder = new SignJWT({
      ...input,
      version: TRANSACTION_PROTOCOL_VERSION,
    })
      .setIssuer(this.config.issuer)
      .setAudience(this.config.audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ttl(this.config.ttlSeconds))
      .setJti(input.jti ?? crypto.randomUUID());
    if (this.alg === "HS256") {
      return builder
        .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
        .sign(key(this.config.secret ?? ""));
    }
    const { key: signingKey, kid } = await this.asymmetricKey();
    return builder
      .setProtectedHeader({ alg: this.alg, typ: "at+jwt", kid })
      .sign(signingKey);
  }
}
export class TransactionTokenValidator {
  private imported: Promise<ImportedKey> | undefined;
  constructor(
    private readonly config: TransactionTokenConfig,
    private readonly now = () => Date.now(),
  ) {}
  private asymmetricKey(): Promise<ImportedKey> {
    // Verification uses the derived PUBLIC key — Bun's jose refuses private
    // CryptoKey instances when verifying ES256/EdDSA signatures.
    this.imported ??= importVerificationKey(
      this.config.signingKeyPem ?? "",
      algOf(this.config),
    );
    return this.imported;
  }
  async validate(
    token: string | undefined,
  ): Promise<TransactionEnvelope | undefined> {
    const mode = this.config.enforcement ?? "optional";
    if (!token) {
      if (mode === "required") throw new Error("Transaction token is required");
      return undefined;
    }
    if (mode === "off") return undefined;
    const alg = algOf(this.config);
    const verifyKey =
      alg === "HS256"
        ? key(this.config.secret ?? "")
        : await this.asymmetricKey();
    const { payload, protectedHeader } = await jwtVerify(token, verifyKey, {
      issuer: this.config.issuer,
      audience: this.config.audience,
      algorithms: [alg],
      currentDate: new Date(this.now()),
    });
    if (
      protectedHeader.typ !== "at+jwt" ||
      payload.version !== TRANSACTION_PROTOCOL_VERSION
    )
      throw new Error("Unsupported transaction token protocol");
    // Envelope structure is validated by the shared contract schema (Req 11.3)
    // instead of the runtime's former hand-written field checks.
    const parsed = TransactionEnvelopeV1Schema.safeParse(payload);
    if (!parsed.success) throw new Error("Invalid transaction envelope");
    return parsed.data;
  }
}
export function transactionTokenConfigFromEnv(env: Record<string, string | undefined> = process.env): TransactionTokenConfig | undefined {
  const algRaw = env.TRANSACTION_SIGNING_ALG ?? "HS256";
  if (!isTransactionSigningAlg(algRaw))
    throw new Error(
      "Invalid TRANSACTION_SIGNING_ALG (must be HS256, ES256, or EdDSA)",
    );
  const signingKeyPem = env.TRANSACTION_SIGNING_KEY;
  const secret = env.AGENT_TRANSACTION_SECRET;
  // HS256 keeps the legacy gate: no secret, no transaction tokens.
  // Asymmetric modes key off TRANSACTION_SIGNING_KEY instead.
  if (algRaw === "HS256") {
    if (!secret) return undefined;
  } else if (!signingKeyPem) {
    throw new Error(
      `TRANSACTION_SIGNING_KEY (PKCS8 PEM) is required when TRANSACTION_SIGNING_ALG=${algRaw}`,
    );
  }
  const mode = env.AGENT_TRANSACTION_ENFORCEMENT;
  if (mode !== undefined && mode !== "off" && mode !== "optional" && mode !== "required") throw new Error("Invalid AGENT_TRANSACTION_ENFORCEMENT");
  return {
    ...(secret ? { secret } : {}),
    alg: algRaw,
    ...(signingKeyPem ? { signingKeyPem } : {}),
    issuer: env.AGENT_TRANSACTION_ISSUER ?? "aiperator",
    audience: env.AGENT_TRANSACTION_AUDIENCE ?? "agent-transaction-fabric",
    ...(env.AGENT_TRANSACTION_TTL_SECONDS
      ? { ttlSeconds: Number(env.AGENT_TRANSACTION_TTL_SECONDS) }
      : {}),
    ...(mode ? { enforcement: mode } : {}),
  };
}
