// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Critical-path tests for ReplayResultCard — the component that shows the
 * time-travel replay diff in the History tab.
 *
 * Covers: null/loading/error states, identical vs changed display,
 * similarity score, dismiss / Close interactions, and cross-flow replay.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, test, expect, vi } from "vitest";
import { ReplayResultCard } from "../components/ReplayResultCard";
import type { ReplayResult } from "../types/control";

const result = (over: Partial<ReplayResult> = {}): ReplayResult => ({
  executionId: "aaaabbbb-cccc-dddd-eeee-ffffffffffff",
  originalFlowId: "helpdesk",
  replayedFlowId: "helpdesk",
  originalResponse: "Hello, World!",
  replayedResponse: "Hello, World!",
  similarity: 1.0,
  changed: false,
  ...over,
});

describe("ReplayResultCard", () => {
  // ── null / hidden state ───────────────────────────────────────────────────
  test("renders nothing when result is null and not running", () => {
    const { container } = render(
      <ReplayResultCard result={null} isRunning={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  // ── loading state ─────────────────────────────────────────────────────────
  test("shows a replay-in-progress banner when isRunning=true", () => {
    render(<ReplayResultCard result={null} isRunning={true} />);
    expect(screen.getByText("Replaying execution…")).toBeInTheDocument();
  });

  test("isRunning=true takes precedence over a stale result", () => {
    render(<ReplayResultCard result={result()} isRunning={true} />);
    expect(screen.getByText("Replaying execution…")).toBeInTheDocument();
    // The stale original response must NOT be visible during the new run.
    expect(screen.queryByText("Hello, World!")).not.toBeInTheDocument();
  });

  // ── error state ───────────────────────────────────────────────────────────
  test("shows a replay-failed banner when error is set", () => {
    render(<ReplayResultCard result={null} error="timeout" />);
    expect(screen.getByText(/Replay failed: timeout/)).toBeInTheDocument();
  });

  test("dismiss button calls onClear when error is set", () => {
    const onClear = vi.fn();
    render(
      <ReplayResultCard result={null} error="timeout" onClear={onClear} />,
    );
    fireEvent.click(screen.getByText("dismiss"));
    expect(onClear).toHaveBeenCalledOnce();
  });

  // ── identical result ──────────────────────────────────────────────────────
  test("shows 'identical · 100% similar' badge for an unchanged replay", () => {
    render(<ReplayResultCard result={result()} />);
    expect(screen.getByText(/identical/)).toBeInTheDocument();
    expect(screen.getByText(/100%/)).toBeInTheDocument();
  });

  // ── changed result ────────────────────────────────────────────────────────
  test("shows 'changed · 75% similar' badge when the answer drifted", () => {
    render(
      <ReplayResultCard
        result={result({
          similarity: 0.75,
          changed: true,
          replayedResponse: "Hi there!",
        })}
      />,
    );
    expect(screen.getByText(/changed/)).toBeInTheDocument();
    expect(screen.getByText(/75%/)).toBeInTheDocument();
  });

  // ── side-by-side diff ─────────────────────────────────────────────────────
  test("renders original and replayed responses side-by-side", () => {
    render(
      <ReplayResultCard
        result={result({
          originalResponse: "original answer",
          replayedResponse: "replayed answer",
        })}
      />,
    );
    expect(screen.getByText("original answer")).toBeInTheDocument();
    expect(screen.getByText("replayed answer")).toBeInTheDocument();
    expect(screen.getByText("Original")).toBeInTheDocument();
    expect(screen.getByText("Replayed")).toBeInTheDocument();
  });

  // ── executionId truncation ────────────────────────────────────────────────
  test("shows only the first 8 chars of the execution ID", () => {
    render(<ReplayResultCard result={result()} />);
    expect(screen.getByText("aaaabbbb")).toBeInTheDocument();
  });

  // ── cross-flow replay ─────────────────────────────────────────────────────
  test("shows flow diff banner when original and replayed flow IDs differ", () => {
    render(
      <ReplayResultCard
        result={result({
          originalFlowId: "helpdesk-v1",
          replayedFlowId: "helpdesk-v2",
        })}
      />,
    );
    expect(screen.getByText("helpdesk-v1")).toBeInTheDocument();
    expect(screen.getByText("helpdesk-v2")).toBeInTheDocument();
  });

  test("does NOT show flow diff banner when flows are the same", () => {
    render(<ReplayResultCard result={result()} />);
    // The only flow-name element should come from the heading (executionId), not a diff line.
    // There should be no "→" flow-transition text.
    expect(screen.queryByText("→")).not.toBeInTheDocument();
  });

  // ── Close button ──────────────────────────────────────────────────────────
  test("Close button calls onClear when a result is displayed", () => {
    const onClear = vi.fn();
    render(<ReplayResultCard result={result()} onClear={onClear} />);
    fireEvent.click(screen.getByText("Close"));
    expect(onClear).toHaveBeenCalledOnce();
  });

  test("does not render Close button when onClear is absent", () => {
    render(<ReplayResultCard result={result()} />);
    expect(screen.queryByText("Close")).not.toBeInTheDocument();
  });

  // ── empty response fallback ───────────────────────────────────────────────
  test("renders em-dash when original response is empty", () => {
    render(<ReplayResultCard result={result({ originalResponse: "" })} />);
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });
});
