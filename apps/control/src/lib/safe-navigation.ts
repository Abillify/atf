// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what must go
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Returns an internal application target or the supplied safe fallback. */
export function safeReturnTo(
  candidate: string | null | undefined,
  fallback = "/graph",
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
