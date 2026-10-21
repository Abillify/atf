// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Multi-issuer JWT verification: routing on the unverified `iss` claim, key
 * binding per issuer (a token signed for A never passes as B), algorithm
 * allowlist (no `none`, no HS/RS confusion), and generic error reasons.
 */

import { describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createJwtVerifier, JwtVerificationError } from "../src/index.js";

const ISS_A = "https://a.example.com";
const ISS_B = "https://b.example.com";

async function makeKeys() {
	const { publicKey, privateKey } = await generateKeyPair("RS256", {
		extractable: true,
	});
	const jwk = await exportJWK(publicKey);
	jwk.kid = "key-a";
	jwk.alg = "RS256";
	return { publicKey, privateKey, jwk };
}

async function sign(
	privateKey: CryptoKey,
	claims: Record<string, unknown>,
	alg = "RS256",
): Promise<string> {
	let builder = new SignJWT(claims).setProtectedHeader({ alg, kid: "key-a" });
	if (claims.exp === undefined && claims.noExp === undefined) {
		builder = builder.setExpirationTime("1h");
	}
	return builder.sign(privateKey);
}

describe("createJwtVerifier construction", () => {
	test("requires at least one issuer", () => {
		expect(() => createJwtVerifier({ issuers: [] })).toThrow();
	});

	test("rejects duplicate issuer configurations", async () => {
		const { jwk } = await makeKeys();
		expect(() =>
			createJwtVerifier({
				issuers: [
					{ issuer: ISS_A, jwks: { keys: [jwk] } },
					{ issuer: ISS_A, jwks: { keys: [jwk] } },
				],
			}),
		).toThrow(/duplicate/);
	});

	test('rejects "none" in the algorithm allowlist', () => {
		expect(() =>
			createJwtVerifier({ issuers: [{ issuer: ISS_A }], algorithms: ["none"] }),
		).toThrow(/none/);
		expect(() =>
			createJwtVerifier({ issuers: [{ issuer: ISS_A }], algorithms: ["NoNe"] }),
		).toThrow(/none/);
	});
});

describe("verification", () => {
	test("accepts a token from a configured issuer", async () => {
		const { privateKey, jwk } = await makeKeys();
		const verifier = createJwtVerifier({
			issuers: [{ issuer: ISS_A, jwks: { keys: [jwk] }, audiences: ["atf"] }],
		});
		const token = await sign(privateKey, {
			iss: ISS_A,
			aud: "atf",
			sub: "user-1",
		});
		const result = await verifier.verify(token);
		expect(result.payload.sub).toBe("user-1");
		expect(result.issuer).toBe(ISS_A);
	});

	test("routes by iss and rejects a wrong key (issuer confusion)", async () => {
		const a = await makeKeys();
		const b = await makeKeys();
		const verifier = createJwtVerifier({
			issuers: [
				{ issuer: ISS_A, jwks: { keys: [a.jwk] } },
				{ issuer: ISS_B, jwks: { keys: [b.jwk] } },
			],
		});
		// Signed with A's key but claims issuer B → must fail signature.
		const forged = await sign(b.privateKey, { iss: ISS_A, sub: "x" });
		await expect(verifier.verify(forged)).rejects.toMatchObject({
			reason: "bad_signature",
		});
	});

	test("unknown issuer is rejected without touching a key source", async () => {
		const { jwk } = await makeKeys();
		const verifier = createJwtVerifier({
			issuers: [{ issuer: ISS_A, jwks: { keys: [jwk] } }],
		});
		const { privateKey } = await makeKeys();
		const token = await sign(privateKey, {
			iss: "https://evil.example.com",
			sub: "x",
		});
		await expect(verifier.verify(token)).rejects.toMatchObject({
			reason: "unknown_issuer",
		});
	});

	test("expired token maps to reason expired", async () => {
		const { privateKey, jwk } = await makeKeys();
		const verifier = createJwtVerifier({
			issuers: [{ issuer: ISS_A, jwks: { keys: [jwk] } }],
		});
		const nowSec = Math.floor(Date.now() / 1000);
		const token = await new SignJWT({ iss: ISS_A, sub: "x" })
			.setProtectedHeader({ alg: "RS256" })
			.setIssuedAt(nowSec - 7200)
			.setExpirationTime(nowSec - 3600)
			.sign(privateKey);
		await expect(verifier.verify(token)).rejects.toMatchObject({
			reason: "expired",
		});
	});

	test("missing exp is rejected by default, accepted with requireExpiry=false", async () => {
		const { privateKey, jwk } = await makeKeys();
		const claims = { iss: ISS_A, sub: "x", noExp: true };
		const token = await new SignJWT(claims)
			.setProtectedHeader({ alg: "RS256" })
			.sign(privateKey);
		const strict = createJwtVerifier({
			issuers: [{ issuer: ISS_A, jwks: { keys: [jwk] } }],
		});
		await expect(strict.verify(token)).rejects.toMatchObject({
			reason: "missing_claim",
		});
		const lenient = createJwtVerifier({
			issuers: [{ issuer: ISS_A, jwks: { keys: [jwk] } }],
			requireExpiry: false,
		});
		expect((await lenient.verify(token)).payload.sub).toBe("x");
	});

	test("wrong audience maps to bad_audience", async () => {
		const { privateKey, jwk } = await makeKeys();
		const verifier = createJwtVerifier({
			issuers: [
				{ issuer: ISS_A, jwks: { keys: [jwk] }, audiences: ["my-service"] },
			],
		});
		const token = await sign(privateKey, {
			iss: ISS_A,
			aud: "other-service",
			sub: "x",
		});
		await expect(verifier.verify(token)).rejects.toMatchObject({
			reason: "bad_audience",
		});
	});

	test("HS256 token cannot impersonate RS256 (alg confusion)", async () => {
		const { jwk } = await makeKeys();
		const verifier = createJwtVerifier({
			issuers: [{ issuer: ISS_A, jwks: { keys: [jwk] } }],
		});
		const secret = new TextEncoder().encode(
			"a-super-secret-key-for-hs256-attack!!",
		);
		const hsToken = await new SignJWT({ iss: ISS_A, sub: "x" })
			.setProtectedHeader({ alg: "HS256" })
			.setExpirationTime("1h")
			.sign(secret);
		await expect(verifier.verify(hsToken)).rejects.toBeInstanceOf(
			JwtVerificationError,
		);
	});

	test("alg none is rejected", async () => {
		const { jwk } = await makeKeys();
		const verifier = createJwtVerifier({
			issuers: [{ issuer: ISS_A, jwks: { keys: [jwk] } }],
		});
		const enc = (o: unknown) =>
			btoa(JSON.stringify(o))
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");
		const noneToken = `${enc({ alg: "none", typ: "JWT" })}.${enc({ iss: ISS_A, sub: "x" })}.`;
		await expect(verifier.verify(noneToken)).rejects.toBeInstanceOf(
			JwtVerificationError,
		);
	});

	test("garbage input is invalid_token, not a crash", async () => {
		const { jwk } = await makeKeys();
		const verifier = createJwtVerifier({
			issuers: [{ issuer: ISS_A, jwks: { keys: [jwk] } }],
		});
		await expect(verifier.verify("not-a-jwt")).rejects.toMatchObject({
			reason: "invalid_token",
		});
		await expect(verifier.verify("")).rejects.toMatchObject({
			reason: "invalid_token",
		});
	});

	test("key_unavailable when discovery fails", async () => {
		const verifier = createJwtVerifier({
			issuers: [
				{
					issuer: ISS_A,
					discovery: {
						discoveryUrl: `${ISS_A}/.well-known/openid-configuration`,
						getMetadata: async () => {
							throw new Error("idp down");
						},
					},
				},
			],
		});
		const { privateKey } = await makeKeys();
		const token = await sign(privateKey, { iss: ISS_A, sub: "x" });
		await expect(verifier.verify(token)).rejects.toMatchObject({
			reason: "key_unavailable",
		});
	});

	test("error messages never leak jose internals", async () => {
		const { privateKey, jwk } = await makeKeys();
		const verifier = createJwtVerifier({
			issuers: [{ issuer: ISS_A, jwks: { keys: [jwk] } }],
		});
		const token = await new SignJWT({ iss: ISS_A, sub: "x" })
			.setProtectedHeader({ alg: "RS256" })
			.setIssuedAt("-2h")
			.setExpirationTime("-1h")
			.sign(privateKey);
		const err = await verifier.verify(token).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(JwtVerificationError);
		expect((err as Error).message).not.toMatch(/jose|JWS|JWT/i);
	});
});

describe("typ allow-list", () => {
  test("without the option a typ: JWT token is accepted (backwards compatible)", async () => {
    const { privateKey, jwk } = await makeKeys();
    const verifier = createJwtVerifier({
      issuers: [{ issuer: ISS_A, jwks: { keys: [jwk] } }],
    });
    const token = await new SignJWT({ iss: ISS_A, sub: "x" })
      .setProtectedHeader({ alg: "RS256", kid: "key-a", typ: "JWT" })
      .setExpirationTime("1h")
      .sign(privateKey);
    const result = await verifier.verify(token);
    expect(result.payload.sub).toBe("x");
  });

  test("with allowedTypes a typ: JWT token is rejected", async () => {
    const { privateKey, jwk } = await makeKeys();
    const verifier = createJwtVerifier({
      issuers: [{ issuer: ISS_A, jwks: { keys: [jwk] } }],
      allowedTypes: ["at+jwt"],
    });
    const token = await new SignJWT({ iss: ISS_A, sub: "x" })
      .setProtectedHeader({ alg: "RS256", kid: "key-a", typ: "JWT" })
      .setExpirationTime("1h")
      .sign(privateKey);
    await expect(verifier.verify(token)).rejects.toThrow(
      /typ "jwt" is not accepted/,
    );
  });

  test("typ: at+jwt is accepted when allowed", async () => {
    const { privateKey, jwk } = await makeKeys();
    const verifier = createJwtVerifier({
      issuers: [{ issuer: ISS_A, jwks: { keys: [jwk] } }],
      allowedTypes: ["at+jwt"],
    });
    const token = await new SignJWT({ iss: ISS_A, sub: "x" })
      .setProtectedHeader({ alg: "RS256", kid: "key-a", typ: "at+jwt" })
      .setExpirationTime("1h")
      .sign(privateKey);
    const result = await verifier.verify(token);
    expect(result.payload.sub).toBe("x");
  });

  test("application/at+jwt is treated as at+jwt", async () => {
    const { privateKey, jwk } = await makeKeys();
    const verifier = createJwtVerifier({
      issuers: [{ issuer: ISS_A, jwks: { keys: [jwk] } }],
      allowedTypes: ["at+jwt"],
    });
    const token = await new SignJWT({ iss: ISS_A, sub: "x" })
      .setProtectedHeader({
        alg: "RS256",
        kid: "key-a",
        typ: "application/at+jwt",
      })
      .setExpirationTime("1h")
      .sign(privateKey);
    const result = await verifier.verify(token);
    expect(result.payload.sub).toBe("x");
  });

  test("a missing typ is rejected when an allow-list is active", async () => {
    const { privateKey, jwk } = await makeKeys();
    const verifier = createJwtVerifier({
      issuers: [{ issuer: ISS_A, jwks: { keys: [jwk] } }],
      allowedTypes: ["at+jwt"],
    });
    const token = await new SignJWT({ iss: ISS_A, sub: "x" })
      .setProtectedHeader({ alg: "RS256", kid: "key-a" })
      .setExpirationTime("1h")
      .sign(privateKey);
    await expect(verifier.verify(token)).rejects.toThrow(
      /typ "missing" is not accepted/,
    );
  });
});
