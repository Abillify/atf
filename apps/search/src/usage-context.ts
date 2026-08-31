// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  modelCosts: Record<string, number>;
}

export const usageStorage = new AsyncLocalStorage<RequestUsage>();

export function getUsageContext(): RequestUsage | undefined {
  return usageStorage.getStore();
}

export function recordUsage(
  inputTokens: number,
  outputTokens: number,
  cost: number,
  model?: string,
): void {
  const store = usageStorage.getStore();
  if (store) {
    store.inputTokens += inputTokens;
    store.outputTokens += outputTokens;
    store.cost += cost;
    if (model) {
      if (!store.modelCosts) {
        store.modelCosts = {};
      }
      store.modelCosts[model] = (store.modelCosts[model] || 0) + cost;
    }
  }
}
