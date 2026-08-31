// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Sanitizes decoded JWT payload claims before they cross the debug-trace
 * boundary. The raw compact JWT is deliberately not accepted by this API.
 */

export const REDACTED_CLAIM_VALUE = "[redacted]";

const MAX_STRING_LENGTH = 2_048;
const MAX_ARRAY_LENGTH = 100;
const MAX_OBJECT_ENTRIES = 100;
const MAX_DEPTH = 8;

const SENSITIVE_KEY_FRAGMENTS = [
	"password",
	"passwd",
	"secret",
	"token",
	"authorization",
	"cookie",
	"apikey",
	"privatekey",
	"clientsecret",
	"credential",
	"signature",
];

const SENSITIVE_EXACT_KEYS = new Set(["jwk", "jwks", "x5c", "x5t", "sig"]);
const COMPACT_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const BEARER_CREDENTIAL = /^Bearer\s+\S+$/i;

function canonicalKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string): boolean {
	const canonical = canonicalKey(key);
	return (
		SENSITIVE_EXACT_KEYS.has(canonical) ||
		SENSITIVE_KEY_FRAGMENTS.some((fragment) => canonical.includes(fragment))
	);
}

function sanitizeString(value: string): string {
	if (COMPACT_JWT.test(value) || BEARER_CREDENTIAL.test(value)) {
		return REDACTED_CLAIM_VALUE;
	}
	if (value.length <= MAX_STRING_LENGTH) return value;
	return `${value.slice(0, MAX_STRING_LENGTH)}…[+${value.length - MAX_STRING_LENGTH} chars]`;
}

function sanitizeValue(
	value: unknown,
	depth: number,
	seen: WeakSet<object>,
): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return sanitizeString(value);
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "symbol" || typeof value === "function") {
		return `[${typeof value}]`;
	}
	if (depth >= MAX_DEPTH) return "[depth limit]";

	if (value instanceof Date) return value.toISOString();
	if (seen.has(value)) return "[circular]";
	seen.add(value);

	if (Array.isArray(value)) {
		const sanitized = value
			.slice(0, MAX_ARRAY_LENGTH)
			.map((entry) => sanitizeValue(entry, depth + 1, seen));
		if (value.length > MAX_ARRAY_LENGTH) {
			sanitized.push(`[+${value.length - MAX_ARRAY_LENGTH} more]`);
		}
		return sanitized;
	}

	const sanitized: Record<string, unknown> = Object.create(null);
	const entries = Object.entries(value as Record<string, unknown>);
	for (const [key, entry] of entries.slice(0, MAX_OBJECT_ENTRIES)) {
		sanitized[key] = isSensitiveKey(key)
			? REDACTED_CLAIM_VALUE
			: sanitizeValue(entry, depth + 1, seen);
	}
	if (entries.length > MAX_OBJECT_ENTRIES) {
		sanitized._truncated_entries = entries.length - MAX_OBJECT_ENTRIES;
	}
	return sanitized;
}

/**
 * Returns a detached, JSON-safe copy of decoded JWT payload claims.
 * Credential/signature-shaped fields and embedded raw JWTs are redacted while
 * operational custom claims such as `kb` and `tools` remain available.
 */
export function sanitizeJwtClaims(
	claims: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (claims === undefined) return undefined;
	return sanitizeValue(claims, 0, new WeakSet<object>()) as Record<
		string,
		unknown
	>;
}
