// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { backendUrl } from "../backend-url";

export type ControlApiTarget = "backend" | "same-origin";

export interface ControlRequestInit extends RequestInit {
  target?: ControlApiTarget;
  token?: string | null;
}

export interface ControlJsonRequestInit extends ControlRequestInit {
  jsonBody?: unknown;
}

export class ControlApiError extends Error {
  readonly status: number;
  readonly response: Response;

  constructor(message: string, response: Response) {
    super(message);
    this.name = "ControlApiError";
    this.status = response.status;
    this.response = response;
  }
}

function resolveTarget(input: string, target: ControlApiTarget): string {
  if (target !== "backend" || !input.startsWith("/")) return input;
  return backendUrl(input);
}

/** Low-level fetch: merges headers, preserves the signal, and never auto-throws. */
export function request(
  input: string,
  init: ControlRequestInit = {},
): Promise<Response> {
  const { target = "same-origin", token, ...fetchInit } = init;
  const headers = new Headers(fetchInit.headers);
  if (token !== undefined && token !== null && token !== "") {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(resolveTarget(input, target), { ...fetchInit, headers });
}

async function errorMessage(response: Response): Promise<string> {
  const fallback = `HTTP ${response.status}`;
  let body: string;
  try {
    body = await response.text();
  } catch {
    return fallback;
  }
  if (!body.trim()) return fallback;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const nested = record.error;
      if (nested && typeof nested === "object") {
        const message = (nested as Record<string, unknown>).message;
        if (typeof message === "string" && message.trim()) return message;
      }
      if (typeof record.message === "string" && record.message.trim()) {
        return record.message;
      }
    }
  } catch {
    // A non-JSON response is itself the safest available error detail.
  }
  return body.trim() || fallback;
}

async function ensureOk(response: Response): Promise<Response> {
  if (!response.ok) throw new ControlApiError(await errorMessage(response), response);
  return response;
}

export async function json<T>(
  input: string,
  init: ControlJsonRequestInit = {},
): Promise<T> {
  const { jsonBody, ...requestInit } = init;
  const headers = new Headers(requestInit.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  let body = requestInit.body;
  if (jsonBody !== undefined) {
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    body = JSON.stringify(jsonBody);
  }
  const response = await ensureOk(
    await request(input, { ...requestInit, headers, body }),
  );
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function text(
  input: string,
  init: ControlRequestInit = {},
): Promise<string> {
  return (await ensureOk(await request(input, init))).text();
}

export async function blob(
  input: string,
  init: ControlRequestInit = {},
): Promise<Blob> {
  return (await ensureOk(await request(input, init))).blob();
}

export interface SseEvent {
  data: string;
  event?: string;
  id?: string;
  retry?: number;
}

export interface StreamSseOptions extends ControlRequestInit {
  onEvent?: (event: SseEvent) => void | Promise<void>;
  stopOnDone?: boolean;
}

/** Streams complete SSE events across arbitrary UTF-8, chunk, and CRLF boundaries. */
export async function* streamSse(
  input: string,
  options: StreamSseOptions = {},
): AsyncGenerator<SseEvent> {
  const { onEvent, stopOnDone = true, ...init } = options;
  const headers = new Headers(init.headers);
  if (!headers.has("Accept")) headers.set("Accept", "text/event-stream");
  const response = await ensureOk(await request(input, { ...init, headers }));
  const reader = response.body?.getReader();
  if (!reader) throw new ControlApiError("No response body", response);

  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;

  const dispatch = async (): Promise<SseEvent | null> => {
    if (data.length === 0) {
      event = undefined;
      retry = undefined;
      return null;
    }
    const parsed: SseEvent = { data: data.join("\n") };
    if (event !== undefined) parsed.event = event;
    if (id !== undefined) parsed.id = id;
    if (retry !== undefined) parsed.retry = retry;
    data = [];
    event = undefined;
    retry = undefined;
    await onEvent?.(parsed);
    return parsed;
  };

  const consumeLine = (line: string): "dispatch" | undefined => {
    if (line === "") return "dispatch";
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id" && !value.includes("\0")) id = value;
    else if (field === "retry" && /^\d+$/.test(value)) retry = Number(value);
    return undefined;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // A CR at the end of a network chunk may be the first half of CRLF.
      // Keep it buffered until the next read so it cannot create a synthetic
      // blank line and prematurely dispatch a multiline event.
      const trailingCr = !done && buffer.endsWith("\r");
      if (trailingCr) buffer = buffer.slice(0, -1);
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = done
        ? ""
        : `${lines.pop() ?? ""}${trailingCr ? "\r" : ""}`;
      for (const line of lines) {
        if (consumeLine(line) !== "dispatch") continue;
        const parsed = await dispatch();
        if (!parsed) continue;
        if (stopOnDone && parsed.data.trim() === "[DONE]") return;
        yield parsed;
      }
      if (done) {
        if (buffer) consumeLine(buffer);
        const parsed = await dispatch();
        if (parsed && !(stopOnDone && parsed.data.trim() === "[DONE]")) {
          yield parsed;
        }
        return;
      }
    }
  } finally {
    // `[DONE]` may terminate the generator before the HTTP body itself closes.
    // Always cancel the reader so an early return cannot retain the connection.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
