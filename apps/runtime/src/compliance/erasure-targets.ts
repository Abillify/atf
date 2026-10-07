// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Remote erasure target configuration (platform-hardening Req 2.9).
 *
 * A leaf module (no imports) so the config schema can reference the type
 * without an import cycle with the orchestrator itself.
 */

/**
 * One remote `POST /v1/erasure` endpoint of a downstream service
 * (Search, Extract, Gate, …). `tokenEnv` names an environment variable
 * holding the service token so that secrets never appear in the
 * configuration list itself.
 */
export interface ErasureTargetConfig {
	/** Stable store name reported in DSAR results, e.g. `search`. */
	readonly service: string;
	/** Absolute URL of the service's erasure endpoint. */
	readonly url: string;
	/** Name of the environment variable carrying the bearer token. */
	readonly tokenEnv: string;
}
