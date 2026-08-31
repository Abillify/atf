"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /pii-vault — Reversible PII Tokenization Vault status page.
 *
 * Read-only view of whether the vault is enabled and how it's backed. The
 * vault itself has no admin actions from the dashboard — it's a transparent
 * layer that requires no operator interaction; this page exists purely so an
 * operator (or auditor) can confirm it's active without shell access.
 */

import dynamic from "next/dynamic";

const PiiVaultPanel = dynamic(
  () => import("../../../components/PiiVaultPanel").then((m) => m.PiiVaultPanel),
  {
    ssr: false,
    loading: () => (
      <div className="p-6 text-sm text-muted-foreground">Loading…</div>
    ),
  },
);

export default function PiiVaultPage() {
  return (
    <div className="p-4 sm:p-6 max-w-2xl">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-foreground">
          PII Tokenization Vault
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Detected PII (emails, phone numbers, IBANs, tax/social-insurance IDs,
          credit cards, secrets) in outbound prompts is replaced with an
          encrypted placeholder before any LLM provider sees it, and
          transparently restored in the streamed response — the model and
          provider never receive the real value.
        </p>
      </div>
      <PiiVaultPanel />
    </div>
  );
}
