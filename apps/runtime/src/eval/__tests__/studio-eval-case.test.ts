// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { buildStudioEvalCase, validateStudioEvalCase } from "../studio-eval-case.js";

describe("validateStudioEvalCase", () => {
  it("returns valid when all required fields are present", () => {
    const result = validateStudioEvalCase({ id: "ec-1", flowId: "my-flow", prompt: "What is 2+2?", expected: "4", actual: "4", createdBy: "operator@example.test", tenantId: "tenant-a", createdAt: new Date().toISOString() });
    expect(result.valid).toBe(true);
    expect(result.missingFields).toHaveLength(0);
  });
  it("rejects when expected is missing", () => {
    expect(validateStudioEvalCase({ flowId: "my-flow", prompt: "What is 2+2?", createdBy: "operator@example.test", tenantId: "tenant-a" }).missingFields).toContain("expected");
  });
  it("rejects when prompt is missing", () => {
    expect(validateStudioEvalCase({ flowId: "my-flow", expected: "some answer", createdBy: "operator@example.test", tenantId: "tenant-a" }).missingFields).toContain("prompt");
  });
  it("rejects when flowId is missing", () => {
    expect(validateStudioEvalCase({ prompt: "What is 2+2?", expected: "4", createdBy: "operator@example.test", tenantId: "tenant-a" }).missingFields).toContain("flowId");
  });
  it("rejects when createdBy is missing", () => {
    expect(validateStudioEvalCase({ flowId: "my-flow", prompt: "Hello", expected: "World", tenantId: "tenant-a" }).missingFields).toContain("createdBy");
  });
  it("rejects when tenantId is missing", () => {
    expect(validateStudioEvalCase({ flowId: "my-flow", prompt: "Hello", expected: "World", createdBy: "op" }).missingFields).toContain("tenantId");
  });
  it("names all missing fields when multiple are absent", () => {
    const result = validateStudioEvalCase({ actual: "some result" });
    for (const field of ["prompt", "flowId", "expected", "createdBy", "tenantId"]) expect(result.missingFields).toContain(field);
  });
  it("rejects when prompt is an empty string", () => {
    expect(validateStudioEvalCase({ flowId: "my-flow", prompt: "   ", expected: "4", createdBy: "op", tenantId: "t" }).missingFields).toContain("prompt");
  });
  it("allows validating an empty partial case without throwing", () => {
    expect(() => validateStudioEvalCase({})).not.toThrow();
    expect(validateStudioEvalCase({}).valid).toBe(false);
  });
});

describe("buildStudioEvalCase", () => {
  it("creates a case with auto-generated id and createdAt", () => {
    const evalCase = buildStudioEvalCase({ flowId: "my-flow", prompt: "Hello?", expected: "Hi!", actual: "Hi!", createdBy: "op", tenantId: "t" });
    expect(evalCase.id).toBeTruthy();
    expect(evalCase.createdAt).toBeTruthy();
    expect(evalCase.flowId).toBe("my-flow");
    expect(evalCase.prompt).toBe("Hello?");
  });
  it("uses provided id when given", () => {
    expect(buildStudioEvalCase({ flowId: "f", prompt: "p", expected: "e", createdBy: "op", tenantId: "t" }, "custom-id-123").id).toBe("custom-id-123");
  });
  it("allows building a case without expected", () => {
    const evalCase = buildStudioEvalCase({ flowId: "f", prompt: "p", createdBy: "op", tenantId: "t" });
    expect(evalCase.expected).toBeUndefined();
    expect(validateStudioEvalCase(evalCase).missingFields).toContain("expected");
  });
});

describe("validateStudioEvalCase runtime types", () => {
  it("rejects non-string identity and prompt fields", () => {
    const result = validateStudioEvalCase({
      flowId: 42 as unknown as string,
      prompt: {} as unknown as string,
      expected: { structured: true },
      createdBy: false as unknown as string,
      tenantId: [] as unknown as string,
    });
    expect(result.valid).toBe(false);
    for (const field of ["flowId", "prompt", "createdBy", "tenantId"]) {
      expect(result.missingFields).toContain(field);
    }
    expect(result.missingFields).not.toContain("expected");
  });
});
