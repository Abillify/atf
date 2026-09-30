// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

export interface SourceStatus {
  sourceId: string;
  type?: string;
  auth?: string;
  status: string;
  pending: boolean;
  lastRun?: { finishedAt: string; result: string; counters: Record<string, number> };
  credentials?: { configured: boolean };
}

export interface OutpostStatus {
  paused: boolean;
  sources: SourceStatus[];
}

export interface EventMessage {
  event: string;
  data: unknown;
}

export class OutpostApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  async status(): Promise<OutpostStatus> {
    return this.request<OutpostStatus>("/status");
  }

  sync(sourceId: string): Promise<void> {
    return this.requestNoContent(`/sources/${encodeURIComponent(sourceId)}/sync`, "POST");
  }

  authorize(sourceId: string): Promise<{ status: string }> {
    return this.request(`/sources/${encodeURIComponent(sourceId)}/authorize`, "POST");
  }

  pause(): Promise<void> {
    return this.requestNoContent("/pause", "POST");
  }

  resume(): Promise<void> {
    return this.requestNoContent("/resume", "POST");
  }

  login(): Promise<{ status: string }> {
    return this.request("/auth/login", "POST");
  }

  config(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/config");
  }

  updateConfig(config: Record<string, unknown>): Promise<void> {
    return this.requestNoContent("/config", "PUT", config);
  }

  logout(): Promise<void> {
    return this.requestNoContent("/auth/logout", "POST");
  }

  confirmDelete(sourceId: string): Promise<void> {
    return this.requestNoContent(`/deletes/${encodeURIComponent(sourceId)}/confirm`, "POST");
  }

  credentials(sourceId: string, body: Record<string, string>): Promise<void> {
    return this.requestNoContent(`/sources/${encodeURIComponent(sourceId)}/credentials`, "PUT", body);
  }

  removeCredentials(sourceId: string): Promise<void> {
    return this.requestNoContent(`/sources/${encodeURIComponent(sourceId)}/credentials`, "DELETE");
  }

  async events(onEvent: (message: EventMessage) => void, signal: AbortSignal): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/events`, {
      headers: this.headers(),
      signal,
    });
    if (!response.ok || response.body === null) throw new Error(`events: HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let event = "message";
    let data = "";
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        if (line.startsWith("data: ")) data += line.slice(6);
        if (line === "" && data !== "") {
          try {
            onEvent({ event, data: JSON.parse(data) as unknown });
          } finally {
            event = "message";
            data = "";
          }
        }
      }
    }
  }

  private headers(): HeadersInit {
    return { Authorization: `Bearer ${this.token}`, Accept: "application/json" };
  }

  private async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { ...this.headers(), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(await this.errorMessage(response));
    return (await response.json()) as T;
  }

  private async requestNoContent(path: string, method: string, body?: unknown): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { ...this.headers(), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(await this.errorMessage(response));
  }

  private async errorMessage(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as { code?: string; reason?: string };
      return body.reason === undefined ? body.code ?? `HTTP ${response.status}` : `${body.code ?? "Fehler"}: ${body.reason}`;
    } catch {
      return `HTTP ${response.status}`;
    }
  }
}
