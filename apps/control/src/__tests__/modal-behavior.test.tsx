// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, it, expect, vi, afterEach } from "vitest";
import React, { useRef } from "react";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useModalBehavior, usePresence } from "../lib/ui/useModalBehavior";

afterEach(cleanup);

function TrapHarness({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalBehavior({ open, onClose, containerRef: ref });
  if (!open) return null;
  return (
    <div ref={ref} data-testid="panel">
      <button>Inside</button>
    </div>
  );
}

describe("useModalBehavior", () => {
  it("locks body scroll while open and restores it on close", () => {
    const { rerender } = render(<TrapHarness open={false} onClose={() => {}} />);
    expect(document.body.style.overflow).toBe("");

    rerender(<TrapHarness open onClose={() => {}} />);
    expect(document.body.style.overflow).toBe("hidden");

    rerender(<TrapHarness open={false} onClose={() => {}} />);
    expect(document.body.style.overflow).toBe("");
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    render(<TrapHarness open onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

function PresenceHarness({ open }: { open: boolean }) {
  const { mounted, visible } = usePresence(open, 50);
  return <div data-testid="p">{mounted ? `mounted:${visible}` : "unmounted"}</div>;
}

describe("usePresence", () => {
  it("mounts immediately on open and unmounts after the exit duration", async () => {
    const { rerender } = render(<PresenceHarness open />);
    expect(screen.getByTestId("p").textContent).toContain("mounted");

    rerender(<PresenceHarness open={false} />);
    // still mounted right after close (exit transition), then unmounts
    await waitFor(
      () => expect(screen.getByTestId("p").textContent).toBe("unmounted"),
      { timeout: 500 },
    );
  });
});
