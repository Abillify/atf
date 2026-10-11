"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Status line of the Studio builder (Req 9.3, Task 13.4): message and severity
 * live in one reducer instead of two separate useState pairs. Split out of
 * `components/StudioBuilder.tsx` without behavior change.
 */

import { useCallback, useReducer } from "react";

export type StudioStatusKind = "info" | "error" | "warn" | "ok";

interface StudioStatusState {
  message: string | null;
  kind: StudioStatusKind;
}

type StudioStatusAction =
  | { type: "set"; message: string | null }
  | { type: "setKind"; kind: StudioStatusKind };

function statusReducer(
  state: StudioStatusState,
  action: StudioStatusAction,
): StudioStatusState {
  switch (action.type) {
    case "set":
      return { ...state, message: action.message };
    case "setKind":
      return { ...state, kind: action.kind };
  }
}

/** Tailwind-Textfarben je Status-Schweregrad (war inline in StudioBuilder). */
export const studioStatusColors: Record<StudioStatusKind, string> = {
  info: "text-muted-foreground",
  ok: "text-success",
  warn: "text-warning",
  error: "text-danger",
};

export function useStudioStatus(): {
  status: string | null;
  setStatus: (message: string | null) => void;
  statusKind: StudioStatusKind;
  setStatusKind: (kind: StudioStatusKind) => void;
} {
  const [state, dispatch] = useReducer(statusReducer, {
    message: null,
    kind: "info",
  });
  // As before, setStatus and setStatusKind each set only their own field:
  // `setStatus` does not change the severity, `setStatusKind` not the message.
  const setStatus = useCallback(
    (message: string | null): void => dispatch({ type: "set", message }),
    [],
  );
  const setStatusKind = useCallback(
    (kind: StudioStatusKind): void => dispatch({ type: "setKind", kind }),
    [],
  );
  return {
    status: state.message,
    setStatus,
    statusKind: state.kind,
    setStatusKind,
  };
}
