// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Removes trailing occurrences of one character in linear time. A regex such
 * as `/\/+$/` backtracks quadratically on a long run of that character that
 * is not at the end of the string.
 */
export function trimTrailingChar(value: string, char: string): string {
	const code = char.charCodeAt(0);
	let end = value.length;
	while (end > 0 && value.charCodeAt(end - 1) === code) end--;
	return end === value.length ? value : value.slice(0, end);
}
