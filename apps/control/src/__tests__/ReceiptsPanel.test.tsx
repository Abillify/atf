// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Component tests for the trace-viewer ReceiptsPanel (Req 15.7).
 *
 * The verification layer (`lib/receipt-verify`) is mocked — its own unit tests
 * cover the crypto. Here we assert the panel wiring: list rendering, the
 * verify flow (signature + inclusion badges), and the export buttons.
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, test, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReceiptsPanel } from "../components/ReceiptsPanel";
import type {
  InclusionCheck,
  ReceiptListItem,
  ReceiptSignatureCheck,
} from "../lib/receipt-verify";

vi.mock("../lib/receipt-verify", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/receipt-verify")>();
  return {
    ...actual,
    fetchExecutionReceipts: vi.fn(),
    fetchReceiptProof: vi.fn(),
    fetchReceiptJwks: vi.fn(),
    verifyReceiptSignature: vi.fn(),
    verifyReceiptInclusion: vi.fn(),
    downloadReceipt: vi.fn(),
    downloadAllReceipts: vi.fn(),
  };
});

import * as rv from "../lib/receipt-verify";

function receipt(id: string, kind: string): ReceiptListItem {
  return {
    receipt_id: id,
    kind,
    cose_base64: "c2lnbmVk",
    payload: {
      receipt_id: id,
      kind,
      status: "completed",
      flow_id: "helpdesk",
      flow_version: "3",
      models: [{ model: "openai/gpt-4o", provider: "openai" }],
      pii: { method: "tokenized" },
      retrieval_sources: [{ id: "doc-1", revision: "r7" }],
      approvals: [],
      tool_calls: [],
      cost: { usd: 0.0042 },
      started_at: "2026-10-05T10:00:00Z",
      finished_at: "2026-10-05T10:00:02Z",
      response_hash: "sha256:abc",
    },
  };
}

function renderPanel(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ReceiptsPanel", () => {
  test("renders the receipt list with kind badges", async () => {
    vi.mocked(rv.fetchExecutionReceipts).mockResolvedValue({
      execution_id: "exec-1",
      receipts: [receipt("rp", "chat_completion"), receipt("rc", "tool_call")],
    });
    renderPanel(
      <ReceiptsPanel executionId="exec-1" token="t" enabled={true} />,
    );
    expect(await screen.findByText("rp")).toBeDefined();
    expect(await screen.findByText("rc")).toBeDefined();
    expect(screen.getByText("chat_completion")).toBeDefined();
    expect(screen.getByText("tool_call")).toBeDefined();
    expect(screen.getByText(/2 receipts/)).toBeDefined();
  });

  test("empty state when no receipts exist", async () => {
    vi.mocked(rv.fetchExecutionReceipts).mockResolvedValue({
      execution_id: "exec-1",
      receipts: [],
    });
    renderPanel(
      <ReceiptsPanel executionId="exec-1" token="t" enabled={true} />,
    );
    expect(
      await screen.findByText(/No decision receipts/),
    ).toBeDefined();
  });

  test("neutral state when the endpoint errors (feature off)", async () => {
    vi.mocked(rv.fetchExecutionReceipts).mockRejectedValue(
      new Error("404 Not Found"),
    );
    renderPanel(
      <ReceiptsPanel executionId="exec-1" token="t" enabled={true} />,
    );
    expect(
      await screen.findByText(/not available for this deployment/),
    ).toBeDefined();
  });

  test("verify flow shows signature + inclusion badges", async () => {
    const r = receipt("rp", "chat_completion");
    vi.mocked(rv.fetchExecutionReceipts).mockResolvedValue({
      execution_id: "exec-1",
      receipts: [r],
    });
    vi.mocked(rv.fetchReceiptJwks).mockResolvedValue([
      { kty: "OKP", crv: "Ed25519", kid: "k1" },
    ]);
    const sig: ReceiptSignatureCheck = { signatureValid: true, kid: "k1" };
    vi.mocked(rv.verifyReceiptSignature).mockResolvedValue(sig);
    vi.mocked(rv.fetchReceiptProof).mockResolvedValue({
      receipt_id: "rp",
      proof: { leaf_index: 0, tree_size: 1, node_hashes: [] },
      tree_head: { tree_size: 1, cose_base64: "aGVhZA" },
    });
    const inc: InclusionCheck = {
      headSignatureValid: true,
      inclusionValid: true,
      leafIndex: 0,
      treeSize: 1,
      rootHash: "aa".repeat(32),
      headTimestamp: "2026-10-05T10:05:00Z",
    };
    vi.mocked(rv.verifyReceiptInclusion).mockResolvedValue(inc);

    renderPanel(
      <ReceiptsPanel executionId="exec-1" token="t" enabled={true} />,
    );
    const verifyBtn = await screen.findByRole("button", { name: "Verify" });
    fireEvent.click(verifyBtn);
    expect(
      await screen.findByText(/signature \+ inclusion valid/),
    ).toBeDefined();
    expect(rv.verifyReceiptSignature).toHaveBeenCalledWith(r.cose_base64, [
      { kty: "OKP", crv: "Ed25519", kid: "k1" },
    ]);
  });

  test("invalid signature is surfaced", async () => {
    vi.mocked(rv.fetchExecutionReceipts).mockResolvedValue({
      execution_id: "exec-1",
      receipts: [receipt("rp", "chat_completion")],
    });
    vi.mocked(rv.fetchReceiptJwks).mockResolvedValue([]);
    vi.mocked(rv.verifyReceiptSignature).mockResolvedValue({
      signatureValid: false,
      kid: null,
      error: "no JWKS key with kid k9",
    });
    renderPanel(
      <ReceiptsPanel executionId="exec-1" token="t" enabled={true} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Verify" }));
    expect(await screen.findByText(/signature invalid/)).toBeDefined();
  });

  test("export buttons call the download helpers", async () => {
    const r = receipt("rp", "chat_completion");
    vi.mocked(rv.fetchExecutionReceipts).mockResolvedValue({
      execution_id: "exec-1",
      receipts: [r],
    });
    renderPanel(
      <ReceiptsPanel executionId="exec-1" token="t" enabled={true} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Export all" }));
    expect(rv.downloadAllReceipts).toHaveBeenCalledWith("exec-1", [r]);
    fireEvent.click(screen.getAllByRole("button", { name: "Export" })[0] as HTMLElement);
    expect(rv.downloadReceipt).toHaveBeenCalledWith(r, undefined);
  });
});
