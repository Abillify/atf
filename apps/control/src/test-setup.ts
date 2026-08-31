// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import "@testing-library/jest-dom";

// Node.js 26 exposes an experimental localStorage global. Vitest preserves that
// property when it installs jsdom globals, so bind the test global explicitly to
// jsdom's origin-aware Storage implementation.
const jsdomLocalStorage = (
  globalThis as typeof globalThis & {
    jsdom?: { window: { localStorage: Storage } };
  }
).jsdom?.window.localStorage;

if (jsdomLocalStorage) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: jsdomLocalStorage,
  });
}

// jsdom lacks ResizeObserver, which recharts' ResponsiveContainer relies on.
// Provide a minimal no-op polyfill so chart components can mount in tests.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    ResizeObserverStub;
}
