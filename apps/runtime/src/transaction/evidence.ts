// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

export interface EvidenceReference { id: string; type: string; uri?: string; sha256?: string; createdAt: string }
export interface EvidenceLineage { invocationId: string; executionId: string; inputs: EvidenceReference[]; outputs: EvidenceReference[]; derivedFrom: string[]; policyDecisionIds: string[] }
export type SideEffectKind = "none" | "reversible" | "irreversible";
export interface SideEffectDescriptor { kind: SideEffectKind; resource?: string; operation?: string }
export interface CompensationRequest { originalInvocationId: string; compensationInvocationId: string; reason: string }
export interface CompensationResult { compensated: boolean; evidence?: EvidenceReference[]; error?: string }
export interface CompensableOperation<T = unknown> { sideEffect: SideEffectDescriptor; execute(): Promise<T>; compensate?(request: CompensationRequest): Promise<CompensationResult> }
