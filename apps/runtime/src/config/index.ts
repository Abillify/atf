// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Central typed configuration facade for the AI-Agent Orchestration Platform.
 *
 * Re-exports all public symbols from the submodules so existing imports
 * (`import { loadConfig, AppConfig, ... } from "./config/index.js"`) continue
 * to work unchanged.
 *
 */

// --- Types & schemas from schema.ts ---
export type {
  AppConfig,
  McpServerConfig,
  EmbeddingConfig,
  TokenExchangeConfig,
  TokenExchangeActorConfig,
} from "./schema.js";
export {
  EnvSchema,
  McpServerConfigSchema,
  TokenExchangeConfigSchema,
  TokenExchangeActorConfigSchema,
  LlmConfigSchema,
  LlmParametersSchema,
  EmbeddingConfigSchema,
} from "./schema.js";

// --- Secure defaults from defaults.ts ---
export { SECURE_DEFAULTS, applySecureDefaults } from "./defaults.js";
export type { SecureDefaults } from "./defaults.js";

// --- Production-readiness gate from prod-gate.ts ---
export type { ClusterStateContext } from "./prod-gate.js";
export { checkCompliancePolicyRequirement, checkProductionReadiness } from "./prod-gate.js";

// --- Config loader from load.ts ---
export { loadConfig } from "./load.js";

// --- Configuration profiles / presets from profiles.ts ---
export { PROFILES, listProfiles, applyProfile } from "./profiles.js";
export type { RawEnv, ApplyProfileResult } from "./profiles.js";
