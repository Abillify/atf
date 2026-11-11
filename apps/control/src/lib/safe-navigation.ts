// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what must go
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Returns an internal application target or the supplied safe fallback.
 *
 * The default fallback is the dashboard's own start page: `/` redirects to
 * `/overview` (review follow-up F1), so a sign-in without a usable `returnTo`
 * lands in the same place the root would have taken the operator.
 */
export function safeReturnTo(
  candidate: string | null | undefined,
  fallback = "/overview",
): string {
  if (
    !candidate?.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    CONTROL_CHARACTERS.test(candidate)
  ) {
    return fallback;
  }

  try {
    const base = new URL("https://control.invalid");
    const target = new URL(candidate, base);
    if (target.origin !== base.origin) return fallback;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return fallback;
  }
}

/**
 * Returns the URL unchanged when it is a safe absolute web link (`http:` or
 * `https:` only), or `null` for anything else — active schemes such as
 * `javascript:` and `data:`, protocol-relative URLs, and relative paths.
 *
 * Used for operator-supplied external targets (e.g. the `SERVICE_LINKS` URLs
 * on `/services`), where a relative path is not a meaningful destination and
 * the value comes from configuration rather than this application.
 */
export function safeExternalHref(raw: string): string | null {
  const candidate = raw.trim();
  if (
    !candidate ||
    candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    CONTROL_CHARACTERS.test(candidate)
  ) {
    return null;
  }
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? candidate
      : null;
  } catch {
    return null;
  }
}

/** Allows ordinary web and application links while rejecting active schemes. */
export function safeMarkdownHref(raw: string): string | null {
  const candidate = raw.trim();
  if (
    !candidate ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    CONTROL_CHARACTERS.test(candidate)
  ) {
    return null;
  }

  if (
    candidate.startsWith("/") ||
    candidate.startsWith("./") ||
    candidate.startsWith("../") ||
    candidate.startsWith("#")
  ) {
    return candidate;
  }

  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? candidate
      : null;
  } catch {
    return null;
  }
}
