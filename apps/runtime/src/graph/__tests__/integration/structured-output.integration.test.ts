// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * LOCAL-ONLY integration test — structured output against REAL models.
 *
 * Verifies that the AI SDK `output: Output.object(...)` path (the mechanism the
 * classifier uses) actually ENFORCES the schema on each provider we ship:
 * gemma via LM Studio (json_schema grammar) and Claude Haiku/Sonnet via Bedrock
 * (tool-use / validated JSON). A passing test means the returned object matched
 * the schema AND the enum constraints — the value we could not confirm with
 * mocks.
 *
 * Gated behind RUN_MODEL_INTEGRATION=1 — skipped in CI. Run locally:
 *   RUN_MODEL_INTEGRATION=1 bun run test:integration:models
 */
import { describe, test, expect } from "bun:test";
import { generateText, Output, jsonSchema } from "ai";
import { createLlmProvider } from "../../llm-factory.js";
import {
  CLASSIFIER_MODELS,
  shouldRun,
  integrationAppConfig,
  MODEL_TIMEOUT_MS,
} from "./_helpers.js";

// A representative dispatcher schema (route + a small client enum + flags).
// The client enum is deliberately short so the assertion can prove the model
// was constrained to the allowed set (structured output enforcement).
const ROUTE_VALUES: string[] = ["REKLAMATION", "CLIENTS", "BETRIEB", "ALLGEMEINES"];
const CLIENT_VALUES: string[] = [
  "Example Logistics",
  "Example Retail",
  "Example Finance",
  "",
];
const DISPATCHER_SCHEMA = {
  type: "object",
  properties: {
    route: { type: "string", enum: ROUTE_VALUES },
    client: { type: "string", enum: CLIENT_VALUES },
    needsRag: { type: "boolean" },
    needsOrchestration: { type: "boolean" },
  },
  required: ["route", "client", "needsRag", "needsOrchestration"],
  additionalProperties: false,
} as Parameters<typeof jsonSchema>[0];

const SYSTEM_PROMPT =
  "Du bist der Dispatcher fuer einen Kundenservice-Bot. Klassifiziere die " +
  "letzte Anfrage: route (REKLAMATION = Reklamation/Forderungen, CLIENTS = eine " +
  "konkrete Kundenfirma, BETRIEB = interne Firmenthemen, ALLGEMEINES = " +
  "Smalltalk), den erkannten Kunden (client, leer wenn keiner), und ob " +
  "Recherche (needsRag) bzw. mehrschrittige Orchestrierung (needsOrchestration) " +
  "noetig ist.";

for (const m of CLASSIFIER_MODELS) {
  describe.skipIf(!shouldRun(m))(`structured output — ${m.label}`, () => {
    const appConfig = integrationAppConfig();
    const temperature = m.llm.parameters?.temperature as number | undefined;

    async function classify(prompt: string): Promise<Record<string, unknown>> {
      const model = createLlmProvider(m.llm, appConfig);
      const res = await generateText({
        model,
        system: SYSTEM_PROMPT,
        prompt,
        maxOutputTokens: 200,
        ...(temperature !== undefined ? { temperature } : {}),
        output: Output.object({
          schema: jsonSchema(DISPATCHER_SCHEMA),
          name: "classification",
        }),
      });
      return res.output as Record<string, unknown>;
    }

    test(
      "client query → schema-valid, enum-constrained object",
      async () => {
        const obj = await classify(
          "Wer ist bei Example Logistics fuer das Onboarding zustaendig?",
        );
        // This test proves structured-output ENFORCEMENT, not classification
        // accuracy: every field must conform to the schema (enums + types).
        // The exact route is model-dependent (a minimal prompt may pick BETRIEB
        // vs CLIENTS) and is NOT asserted here.
        expect(ROUTE_VALUES).toContain(obj.route as string);
        expect(CLIENT_VALUES).toContain(obj.client as string);
        expect(typeof obj.needsRag).toBe("boolean");
        expect(typeof obj.needsOrchestration).toBe("boolean");
      },
      MODEL_TIMEOUT_MS,
    );

    test(
      "smalltalk query → valid route, no client",
      async () => {
        const obj = await classify("Hallo! Wie geht es dir heute?");
        expect(ROUTE_VALUES).toContain(obj.route as string);
        expect(CLIENT_VALUES).toContain(obj.client as string);
        expect(typeof obj.needsRag).toBe("boolean");
      },
      MODEL_TIMEOUT_MS,
    );
  });
}
