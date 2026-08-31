// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/** Public in-memory case store. Applications may replace this interface with durable storage. */
import type { StudioEvalCase } from "./studio-eval-case.js";
export interface EvalCaseStore { list(): Promise<StudioEvalCase[]>; add(evalCase: StudioEvalCase): Promise<void>; remove(id: string): Promise<boolean>; }
export class InMemoryEvalCaseStore implements EvalCaseStore { private readonly cases = new Map<string, StudioEvalCase>(); async list(): Promise<StudioEvalCase[]> { return [...this.cases.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); } async add(evalCase: StudioEvalCase): Promise<void> { this.cases.set(evalCase.id, evalCase); } async remove(id: string): Promise<boolean> { return this.cases.delete(id); } }

/** Creates the neutral in-memory store used when no durable adapter is provided. */
export function createEvalCaseStore(): EvalCaseStore { return new InMemoryEvalCaseStore(); }
