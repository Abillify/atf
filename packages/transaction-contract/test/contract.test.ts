// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { expect, test } from "bun:test";
import { TransactionV1Schema } from "../src/index.ts";
test("accepts a versioned transaction", () => expect(TransactionV1Schema.parse({ version: "1.0.0", id: "00000000-0000-4000-8000-000000000001", principalId: "principal-1", action: "search.query", occurredAt: "2025-01-01T00:00:00.000Z", correlationId: "correlation-1" }).action).toBe("search.query"));
