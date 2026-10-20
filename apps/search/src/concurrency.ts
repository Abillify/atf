// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Map `items` with at most `limit` calls in flight, keeping the input order.
 * A rejection rejects the whole mapping (no silent partial result); calls that
 * have not started by then are not started.
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	let failed = false;
	const worker = async (): Promise<void> => {
		for (;;) {
			if (failed) return;
			const index = next++;
			if (index >= items.length) return;
			try {
				results[index] = await fn(items[index] as T, index);
			} catch (err) {
				failed = true;
				throw err;
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker),
	);
	return results;
}
