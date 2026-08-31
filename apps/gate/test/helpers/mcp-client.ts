// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

/** Connect an MCP client to a running mcpgate over SSE with a bearer token. */
export async function connectMcp(baseUrl: string, token: string): Promise<Client> {
  const transport = new SSEClientTransport(new URL(`${baseUrl}/sse`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    eventSourceInit: {
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          headers: { ...init?.headers, Authorization: `Bearer ${token}` },
        }),
    },
  });
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

/** Connect an MCP client to a running mcpgate over Streamable HTTP with a bearer token. */
export async function connectMcpStreamable(baseUrl: string, token: string): Promise<Client> {
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}
