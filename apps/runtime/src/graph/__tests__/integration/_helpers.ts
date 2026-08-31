// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Shared setup for explicitly opted-in model integration tests.
 *
 * These tests hit REAL models and must never run in automatic CI. They are
 * gated behind the explicit `RUN_MODEL_INTEGRATION=1` env flag, so a normal
 * `bun test` collects but SKIPS them — exactly like the pg/redis integration
 * suites. Automatic CI must not set the flag; manually and explicitly triggered
 * CI may set it. Run them locally or in such a manual CI job with:
 *
 *   RUN_MODEL_INTEGRATION=1 bun run test:integration:models
 *
 * Models mirror the shipped flows:
 *   - qwen3.6-35b-a3b (LM Studio, OpenAI-compatible) — like abbylocal
 *   - claude-haiku + claude-sonnet (Bedrock)         — like abby
 *
 * Bedrock credentials come from .env.test (auto-loaded by `bun test`); the
 * LM Studio base URL defaults to the standard local port and can be overridden
 * with LMSTUDIO_BASE_URL / OPENAI_BASE_URL.
 *
 * NOTE: this file is NOT a test file (no `.test.ts`), so the runner never
 * executes it directly — it only provides helpers to the suites.
 */
import type { AppConfig } from "../../../config/index.js";
import type { ProviderInstance } from "../../../config/providers.js";
import { setProviderRegistry } from "../../../config/providers.js";
import type { LlmConfig } from "../../../types/flow.js";

/** Master opt-in — automatic CI must not set this; manual explicit CI may. */
export const RUN_MODEL_INTEGRATION = process.env.RUN_MODEL_INTEGRATION === "1";

/** Bedrock is usable when .env.test provided credentials. */
export const BEDROCK_AVAILABLE =
  typeof process.env.BEDROCK_ACCESS_KEY_ID === "string" &&
  process.env.BEDROCK_ACCESS_KEY_ID.length > 0;

/** LM Studio (OpenAI-compatible) endpoint. Default = LM Studio's local port. */
export const LMSTUDIO_BASE_URL =
  process.env.LMSTUDIO_BASE_URL ??
  process.env.OPENAI_BASE_URL ??
  "http://localhost:1234/v1";

/** Minimal AppConfig wiring the local + Bedrock providers from the environment. */
export function integrationAppConfig(): AppConfig {
  return {
    port: 3100,
    flowsDir: "./flows",
    monitoringTransport: "sse",
    mcpServers: [],
    corsOrigins: ["*"],
    monitoringAuthRequired: false,
    logLevel: "error",
    maxToolSteps: 5,
    maxConcurrentExecutions: 50,
    providers: integrationProviders(),
  } as AppConfig;
}

/**
 * The named endpoints the integration models reference. Registering them is what
 * gives `local-lmstudio` / `aws-bedrock` their URL and credentials, since
 * `PROVIDERS` is the only configuration source.
 */
export function integrationProviders(): ProviderInstance[] {
  return [
    {
      name: "local-lmstudio",
      protocol: "openai",
      url: LMSTUDIO_BASE_URL,
      apiKey: process.env.OPENAI_API_KEY ?? "lmstudio",
      local: true,
    },
    {
      name: "aws-bedrock",
      protocol: "bedrock",
      // Sourced from .env.test; absent keys leave the AWS credential chain in play.
      ...(process.env.BEDROCK_REGION !== undefined
        ? { region: process.env.BEDROCK_REGION }
        : {}),
      ...(process.env.BEDROCK_ACCESS_KEY_ID !== undefined
        ? { accessKeyId: process.env.BEDROCK_ACCESS_KEY_ID }
        : {}),
      ...(process.env.BEDROCK_SECRET_ACCESS_KEY !== undefined
        ? { secretAccessKey: process.env.BEDROCK_SECRET_ACCESS_KEY }
        : {}),
    },
  ];
}

/** Publishes the integration endpoints so provider references resolve. */
export function registerIntegrationProviders(): void {
  setProviderRegistry(integrationProviders());
}

export interface ModelCase {
  label: string;
  kind: "local" | "bedrock";
  llm: LlmConfig;
}

/** qwen3.6-35b-a3b via LM Studio — thinking off, exactly like abbylocal. */
export const QWEN: ModelCase = {
  label: "qwen3.6-35b-a3b (LM Studio)",
  kind: "local",
  llm: {
    provider: "local-lmstudio",
    model: "qwen/qwen3.6-35b-a3b",
    parameters: { temperature: 0, reasoningEffort: "none" },
  },
};


/** Claude Haiku via Bedrock — the abby dispatcher/fast model. */
export const HAIKU: ModelCase = {
  label: "claude-haiku-4-5 (Bedrock)",
  kind: "bedrock",
  llm: {
    provider: "aws-bedrock",
    model: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
    parameters: { temperature: 0 },
  },
};

/** Claude Sonnet via Bedrock — the abby responder/planner model. */
export const SONNET: ModelCase = {
  label: "claude-sonnet-5 (Bedrock)",
  kind: "bedrock",
  llm: {
    provider: "aws-bedrock",
    model: "eu.anthropic.claude-sonnet-5",
    parameters: { temperature: 0 },
  },
};

/** All models, in any role (classifier and/or responder). */
export const MODELS: ModelCase[] = [QWEN, HAIKU, SONNET];

/**
 * Models actually used as CLASSIFIERS in the shipped flows (dispatcher/triage/
 * refine). abbylocal → qwen; abby → Haiku. Sonnet-5 is deliberately excluded:
 * it is a RESPONDER/planner only, and the @ai-sdk/amazon-bedrock structured-
 * output path (generateObject) is rejected by claude-sonnet-5 with
 * "output_config.format: Extra inputs are not permitted" — so a classifier must
 * never run on Sonnet-5 (it would always hit the safe fallback).
 */
export const CLASSIFIER_MODELS: ModelCase[] = [QWEN, HAIKU];

/** Whether a given model case should run in this environment. */
export function shouldRun(m: ModelCase): boolean {
  if (!RUN_MODEL_INTEGRATION) return false;
  return m.kind === "bedrock" ? BEDROCK_AVAILABLE : true;
}

/** Per-call timeout for real model calls (ms). Sonnet + tool loops are slow. */
export const MODEL_TIMEOUT_MS = 90_000;
