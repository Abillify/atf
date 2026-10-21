// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * The packages `bun.lock` locks, as `name@version` identities.
 *
 * The supply-chain generator inventories the installed Bun store. That store can
 * hold packages the lockfile no longer mentions (a removed dependency whose
 * directory survived an incremental install), and they would end up in the
 * notices and the SBOM. The lockfile is the source of truth for what the
 * product ships, so the generator keeps only store entries it locks.
 *
 * `bun.lock` is JSONC; every `packages` entry is `"<key>": ["<name>@<spec>", …]`
 * and the first array element is the resolved package. Workspace packages
 * (`@atf/x@workspace:…`) are first-party and never in the third-party store.
 */

export interface LockedPackages {
	/** `name@version` of every registry package the lock resolves. */
	identities: ReadonlySet<string>;
	/**
	 * Names locked through a non-registry spec (git, tarball, file): their store
	 * manifest version is not the spec, so any version of the name is accepted.
	 */
	nonRegistryNames: ReadonlySet<string>;
}

const PACKAGE_ENTRY = /^ {4}"[^"\n]+": \["([^"\n]+)"/gm;
const REGISTRY_VERSION = /^\d+\.\d+\.\d+/;

/** Split `name@spec` at the last `@` that is not the scope marker. */
function splitIdentity(resolved: string): { name: string; spec: string } | undefined {
	const at = resolved.lastIndexOf("@");
	if (at <= 0) return undefined;
	return { name: resolved.slice(0, at), spec: resolved.slice(at + 1) };
}

export function parseLockedPackages(lockText: string): LockedPackages {
	const start = lockText.indexOf('"packages": {');
	const section = start === -1 ? "" : lockText.slice(start);
	const identities = new Set<string>();
	const nonRegistryNames = new Set<string>();
	for (const match of section.matchAll(PACKAGE_ENTRY)) {
		const parts = splitIdentity(match[1] ?? "");
		if (parts === undefined) continue;
		if (parts.spec.startsWith("workspace:")) continue;
		if (REGISTRY_VERSION.test(parts.spec)) identities.add(`${parts.name}@${parts.spec}`);
		else nonRegistryNames.add(parts.name);
	}
	return { identities, nonRegistryNames };
}

/** Whether an installed package (by its own manifest) is locked. */
export function isLocked(locked: LockedPackages, name: string, version: string): boolean {
	return locked.identities.has(`${name}@${version}`) || locked.nonRegistryNames.has(name);
}

/**
 * Keep the installed packages the lock resolves; report how many were left out.
 */
export function filterToLocked<T extends { name: string; version: string }>(
	installed: readonly T[],
	locked: LockedPackages,
): { kept: T[]; ignored: number } {
	const kept = installed.filter((pkg) => isLocked(locked, pkg.name, pkg.version));
	return { kept, ignored: installed.length - kept.length };
}
