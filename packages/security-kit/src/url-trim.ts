// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Removes trailing "/" characters in linear time.
 *
 * `value.replace(/\/+$/, "")` backtracks quadratically on a long run of
 * slashes that is not at the end (each start position re-scans the run), so
 * a hostile issuer or URL could stall the event loop. A reverse scan is
 * linear and returns the same result.
 */
export function trimTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value.charCodeAt(end - 1) === 47 /* "/" */) end--;
	return end === value.length ? value : value.slice(0, end);
}
