// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

export interface StudioEvalCase { id: string; flowId: string; prompt: string; expected?: unknown; actual?: unknown; createdBy: string; tenantId: string; createdAt: string; }
const REQUIRED_STRING_FIELDS = ["flowId", "prompt", "createdBy", "tenantId"] as const;
export function validateStudioEvalCase(value: Partial<StudioEvalCase>): { valid: boolean; missingFields: string[] } {
  const missingFields: string[] = REQUIRED_STRING_FIELDS.filter((field) =>
    typeof value[field] !== "string" || value[field].trim() === ""
  );
  if (value.expected === undefined || value.expected === null || (typeof value.expected === "string" && value.expected.trim() === "")) missingFields.push("expected");
  return { valid: missingFields.length === 0, missingFields };
}
export function buildStudioEvalCase(value: Omit<StudioEvalCase, "id" | "createdAt">, id?: string): StudioEvalCase { return { ...value, id: id ?? crypto.randomUUID(), createdAt: new Date().toISOString() }; }
