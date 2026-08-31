// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { expect, test } from "bun:test";
import { EvidenceActionSchema } from "../src/index.ts";
test("requires an evidence digest", () => expect(() => EvidenceActionSchema.parse({ version: "1.0.0", transactionId: "00000000-0000-4000-8000-000000000001", action: "search.query", outcome: "observed", recordedAt: "2025-01-01T00:00:00.000Z", digest: "short" })).toThrow());
