"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * ConfirmDialog: replaces `window.confirm`/`window.prompt` with the in-house
 * `Dialog` primitive (Req 9.5, Task 13.5).
 *
 * `ConfirmProvider` is mounted once in the root layout; components request
 * confirmations through `useConfirm()`:
 *
 *   const { confirm, prompt } = useConfirm();
 *   if (!(await confirm({ title: "…", message: "…" }))) return;
 *
 * The API is promise based: `confirm` resolves with `true` (confirmed) or
 * `false` (cancelled, including Escape/backdrop click; same semantics as
 * `window.confirm`), `prompt` with the text or `null` on cancel.
 */

import type React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Dialog } from "./Dialog";
import { Button } from "./Button";
import { translate } from "../i18n";

export interface ConfirmOptions {
  title: string;
  message: string;
  /** Label of the confirm button; default "Confirm". */
  confirmLabel?: string;
  /** Label of the cancel button; default "Cancel". */
  cancelLabel?: string;
  /** Color the confirm button as a destructive action. */
  destructive?: boolean;
}

export interface PromptOptions {
  title: string;
  message?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface ConfirmApi {
  /** Like `window.confirm`: `true` when confirmed, otherwise `false`. */
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** Like `window.prompt`: the text when confirmed, otherwise `null`. */
  prompt(options: PromptOptions): Promise<string | null>;
}

type PendingRequest =
  | ({ kind: "confirm" } & ConfirmOptions)
  | ({ kind: "prompt" } & PromptOptions);

const ConfirmContext = createContext<ConfirmApi | null>(null);

/**
 * Provider: holds exactly one open confirmation request and renders it as a
 * modal `Dialog` (focus trap, Escape, backdrop, all from the primitive).
 */
export function ConfirmProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [request, setRequest] = useState<PendingRequest | null>(null);
  const resolverRef = useRef<((value: boolean | string | null) => void) | null>(
    null,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const messageLabelId = useRef(`confirm-message-${Math.random().toString(36).slice(2)}`).current;

  const settle = useCallback((value: boolean | string | null): void => {
    resolverRef.current?.(value);
    resolverRef.current = null;
    setRequest(null);
  }, []);

  const confirm = useCallback(
    (options: ConfirmOptions): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        resolverRef.current?.(false);
        resolverRef.current = resolve as (
          value: boolean | string | null,
        ) => void;
        setRequest({ kind: "confirm", ...options });
      }),
    [],
  );

  const prompt = useCallback(
    (options: PromptOptions): Promise<string | null> =>
      new Promise<string | null>((resolve) => {
        resolverRef.current?.(null);
        resolverRef.current = resolve as (
          value: boolean | string | null,
        ) => void;
        setRequest({ kind: "prompt", ...options });
      }),
    [],
  );

  // In prompt mode, put the input focus directly on the field.
  useEffect(() => {
    if (request?.kind === "prompt") inputRef.current?.select();
  }, [request]);

  const api: ConfirmApi = { confirm, prompt };

  const onClose = useCallback(
    (): void => settle(request?.kind === "prompt" ? null : false),
    [settle, request],
  );

  return (
    <ConfirmContext.Provider value={api}>
      {children}
      <Dialog
        open={request !== null}
        onClose={onClose}
        title={request?.title ?? ""}
      >
        {request ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (request.kind === "prompt") {
                const value =
                  e.currentTarget.elements.namedItem("confirm-input");
                settle(
                  value instanceof HTMLInputElement ? value.value : null,
                );
              } else {
                settle(true);
              }
            }}
            className="space-y-4"
          >
            {request.message ? (
              <p
                id={messageLabelId}
                className="whitespace-pre-line text-sm text-muted-foreground"
              >
                {request.message}
              </p>
            ) : null}
            {request.kind === "prompt" ? (
              <label className="block">
                <span className="sr-only">{request.title}</span>
                <input
                  ref={inputRef}
                  name="confirm-input"
                  type="text"
                  defaultValue={request.defaultValue ?? ""}
                  className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  settle(request.kind === "prompt" ? null : false)
                }
              >
                {request.cancelLabel ?? translate("confirmDialog.cancel")}
              </Button>
              <Button
                type="submit"
                size="sm"
                variant={
                  request.kind === "confirm" && request.destructive
                    ? "destructive"
                    : "primary"
                }
              >
                {request.confirmLabel ?? translate("confirmDialog.confirm")}
              </Button>
            </div>
          </form>
        ) : null}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

/**
 * Confirmation API (Req 9.5). Deliberately throws when no `ConfirmProvider`
 * is mounted, so a missing provider shows up immediately instead of silently
 * allowing destructive actions.
 */
export function useConfirm(): ConfirmApi {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm requires a ConfirmProvider in the tree.");
  }
  return ctx;
}
