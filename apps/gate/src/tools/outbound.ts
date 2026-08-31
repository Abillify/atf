// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.google",
  "instance-data.ec2.internal",
  "metadata.azure.internal",
]);

/** Synchronous URL/protocol/allow-list validation. Network addresses are checked by validateOutboundUrl. */
export function checkOutboundHost(urlString: string, allowedHosts: string[]): string | null {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return `invalid outbound URL: ${urlString}`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `outbound protocol not allowed: ${url.protocol}`;
  }
  if (url.username || url.password) return "outbound URL credentials are not allowed";

  const host = normalizeHost(url.hostname);
  if (allowedHosts.length > 0) {
    const allowed = allowedHosts.some((entry) => {
      const candidate = entry.trim().toLowerCase().replace(/\.$/, "");
      if (!candidate) return false;
      return candidate.startsWith(".")
        ? host === candidate.slice(1) || host.endsWith(candidate)
        : host === candidate;
    });
    if (!allowed) return `outbound host not allowed: ${host}`;
  }
  return null;
}

/** Resolve every address and reject the target unless all answers are public. */
export async function validateOutboundUrl(
  urlString: string,
  allowedHosts: string[],
  allowedPrivateHosts: string[] = [],
): Promise<string | null> {
  const blocked = checkOutboundHost(urlString, allowedHosts);
  if (blocked) return blocked;
  const host = normalizeHost(new URL(urlString).hostname);
  if (METADATA_HOSTS.has(host) || host === "localhost" || host.endsWith(".localhost")) {
    return `outbound host not allowed: ${host}`;
  }
  const privateAllowed = isExactHostAllowed(host, allowedPrivateHosts);
  if (isIP(host)) {
    return isForbiddenAddress(host) && !(privateAllowed && isAllowedPrivateAddress(host))
      ? `outbound address not allowed: ${host}`
      : null;
  }
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (addresses.length === 0) return `outbound host did not resolve: ${host}`;
    const forbidden = addresses.find(({ address }) =>
      isForbiddenAddress(address) && !(privateAllowed && isAllowedPrivateAddress(address)),
    );
    return forbidden ? `outbound address not allowed: ${forbidden.address}` : null;
  } catch {
    return `outbound host could not be resolved: ${host}`;
  }
}

export interface SecureOutboundFetchOptions {
  /** Return a validated 3xx response to a caller that handles redirects itself. */
  redirect?: "reject" | "manual";
  /** Exact configured hostnames allowed to resolve to private addresses (split DNS). */
  allowedPrivateHosts?: string[];
}

/**
 * Fetch with a connection-adjacent DNS lookup. The exact address returned to
 * the socket is checked immediately before connect, closing the validation/
 * connect TOCTOU gap. Redirects are rejected by default; callers that explicitly
 * opt into manual handling must validate and issue every subsequent request.
 */
export async function secureOutboundFetch(
  input: string | URL | Request,
  init: RequestInit | undefined,
  allowedHosts: string[],
  options: SecureOutboundFetchOptions = {},
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  const blocked = checkOutboundHost(url.toString(), allowedHosts);
  if (blocked) throw new Error(blocked);
  const host = normalizeHost(url.hostname);
  if (METADATA_HOSTS.has(host) || host === "localhost" || host.endsWith(".localhost")) {
    throw new Error(`outbound host not allowed: ${host}`);
  }
  const privateAllowed = isExactHostAllowed(host, options.allowedPrivateHosts ?? []);

  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => { headers.set(key, value); });
  const body = init?.body;
  if (body !== undefined && typeof body !== "string" && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
    throw new Error("secure outbound transport only accepts buffered request bodies");
  }

  const requestHeaders: Record<string, string> = {};
  headers.forEach((value, key) => { requestHeaders[key] = value; });

  return await new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        headers: requestHeaders,
        signal: init?.signal ?? undefined,
        lookup: async (_hostname, options, callback) => {
          const returnAll = options.all === true;
          try {
            if (isIP(host)) {
              if (isForbiddenAddress(host) && !(privateAllowed && isAllowedPrivateAddress(host))) {
                throw new Error(`outbound address not allowed: ${host}`);
              }
              const selected = { address: host, family: isIP(host) as 4 | 6 };
              if (returnAll) callback(null, [selected]);
              else callback(null, selected.address, selected.family);
              return;
            }
            const addresses = await lookup(host, { all: true, verbatim: true });
            if (addresses.length === 0) throw new Error(`outbound host did not resolve: ${host}`);
            const forbidden = addresses.find(({ address }) =>
              isForbiddenAddress(address) && !(privateAllowed && isAllowedPrivateAddress(address)),
            );
            if (forbidden) throw new Error(`outbound address not allowed: ${forbidden.address}`);
            if (returnAll) callback(null, addresses);
            else {
              const selected = addresses[0]!;
              callback(null, selected.address, selected.family);
            }
          } catch (cause) {
            const error = cause instanceof Error ? cause : new Error(String(cause));
            if (returnAll) callback(error, []);
            else callback(error, "", 0);
          }
        },
      },
      (incoming) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, item);
          else if (value !== undefined) responseHeaders.set(key, value);
        }
        const status = incoming.statusCode ?? 500;
        const isRedirect = [301, 302, 303, 307, 308].includes(status);
        if (isRedirect && options.redirect !== "manual") {
          incoming.resume();
          reject(new Error("outbound redirects are disabled"));
          return;
        }
        const bodyless = isRedirect || [204, 205, 304].includes(status);
        const responseBody = bodyless
          ? null
          : (Readable.toWeb(incoming) as unknown as ReadableStream);
        if (bodyless) incoming.resume();
        resolve(new Response(responseBody, {
          status,
          statusText: incoming.statusMessage,
          headers: responseHeaders,
        }));
      },
    );
    request.once("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isExactHostAllowed(host: string, allowedHosts: string[]): boolean {
  return allowedHosts.some((entry) => normalizeHost(entry.trim()) === host);
}

/** Only RFC1918 IPv4 and unique-local IPv6 may be opened by a split-DNS exception. */
function isAllowedPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0]!;
  if (normalized.startsWith("::ffff:")) return isAllowedPrivateAddress(normalized.slice(7));
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
  }
  return isIP(normalized) === 6 && (normalized.startsWith("fc") || normalized.startsWith("fd"));
}

export function isForbiddenAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0]!;
  if (normalized.startsWith("::ffff:")) return isForbiddenAddress(normalized.slice(7));
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b! >= 64 && b! <= 127) || a! >= 224;
  }
  if (isIP(normalized) === 6) {
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || /^fe[89ab]/.test(normalized) || normalized.startsWith("ff");
  }
  return true;
}
