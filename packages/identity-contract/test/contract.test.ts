// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { expect, test } from "bun:test";
import { IdentityPrincipalSchema } from "../src/index.ts";
test("parses an identity principal", () => expect(IdentityPrincipalSchema.parse({ version: "1.0.0", id: "principal-1", subject: "subject-1", issuer: "issuer", authenticatedAt: "2025-01-01T00:00:00.000Z" }).roles).toEqual([]));
