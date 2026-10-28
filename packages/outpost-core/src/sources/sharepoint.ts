// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * SharePoint/OneDrive_Source (Microsoft Graph, client credentials).
 *
 * Authentication is OAuth2 client credentials against
 * `login.microsoftonline.com/<tenant>/oauth2/v2.0/token` with the Graph
 * `.default` scope; the secret comes from a file (never the config object)
 * and the access token is cached in memory until 60 s before expiry. The
 * drive is addressed directly by `driveId` or resolved from `siteUrl` +
 * `library` (site path → drives collection). Listing uses the drive `delta`
 * query and pages through `@odata.nextLink`; the final `@odata.deltaLink`
 * is exposed for the next incremental run. An incremental listing carries
 * changes only, so deletions (the `deleted` facet) are yielded as tombstones
 * (`removal: "deleted"`) and the sync layer skips absence-based deletes for
 * it (`listingIsIncremental`). Only `file` items sync;
 * folders are skipped. With `aclFromPermissions` the item permissions map
 * to the document access list: users from `grantedToV2.user` (lower-cased),
 * groups from `grantedToV2.group.id` through `aclGroupMap`; share links are
 * never adopted. An item without a single mappable user or group (shared only
 * via links, or only to identities that cannot be mapped) is never uploaded,
 * with a warning: an empty list would make it visible tenant-wide. It is
 * yielded as a tombstone (`removal: "access-revoked"`), so a previously synced
 * copy is removed even with Mirror_Delete off.
 * At most four Graph requests run in parallel per source; 429/503 honour
 * `Retry-After` with exponential backoff, at most five attempts.
 */

import { createSign, randomUUID, X509Certificate } from "node:crypto";
import { Readable } from "node:stream";
import { Semaphore } from "../sync/concurrency.js";
import { isIncluded } from "./filter.js";
import { SourceRejectedError } from "./types.js";
import type { SourceAdapter, SourceFetch, SourceItem } from "./types.js";

const GRAPH_API = "https://graph.microsoft.com/v1.0";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
/** Hard ceiling on parallel Graph requests per source. */
const MAX_GRAPH_PARALLEL = 4;
/** 429/503 retries: first attempt + four retries. */
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 500;
/** Refresh the token this far before it expires. */
const TOKEN_SKEW_MS = 60_000;
/** Lifetime of a client assertion for the certificate flow. */
const ASSERTION_LIFETIME_SEC = 300;

export interface SharepointSourceOptions {
  id: string;
  tenantId: string;
  clientId: string;
  /** OAuth client secret — read from `clientSecretFile` by the caller. */
  clientSecret?: string;
  /** PEM bundle (private key + certificate) from `certificateFile`. */
  certificatePem?: string;
  /** Direct drive address; alternative to siteUrl + library. */
  driveId?: string;
  siteUrl?: string;
  library?: string;
  /** Map native item permissions to the document ACL. Default false. */
  aclFromPermissions?: boolean;
  /** Graph group id → ACL group name; unmapped ids pass through. */
  aclGroupMap?: Readonly<Record<string, string>>;
  include?: readonly string[];
  exclude?: readonly string[];
  /** Delta link persisted by the previous run, when available. */
  initialDeltaLink?: string;
}

export interface SharepointDeps {
  fetchImpl: SourceFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: { warn(fields: Record<string, unknown>): void };
}

export interface SharepointSource extends SourceAdapter {
  /** Delta link of the last COMPLETE listing; undefined until then. */
  deltaLink(): string | undefined;
  /** True when the listing started from a delta link and holds changes only. */
  listingIsIncremental(): boolean;
}

interface GraphTokenResponse {
  access_token?: string;
  expires_in?: number;
}

interface GraphIdentity {
  user?: { email?: string; userPrincipalName?: string };
  group?: { id?: string };
}

interface GraphPermission {
  grantedToV2?: GraphIdentity;
  /** Share-link facet — deliberately never adopted into the ACL. */
  link?: unknown;
}

interface GraphDriveItem {
  id: string;
  name?: string;
  size?: number;
  lastModifiedDateTime?: string;
  eTag?: string;
  cTag?: string;
  file?: { size?: number; mimeType?: string };
  folder?: unknown;
  deleted?: unknown;
  parentReference?: { path?: string };
}

interface GraphCollection<T> {
  value?: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

/** A 429/503 answer: retryable with an optional server-provided delay. */
class RetryableStatusError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | undefined,
  ) {
    super(`sharepoint graph request failed with ${status}`);
    this.name = "RetryableStatusError";
  }
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** `Retry-After` as milliseconds: delta-seconds or HTTP-date. */
function retryAfterMs(header: string | undefined, now: () => number): number | undefined {
  if (header === undefined || header === "") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) return Math.max(dateMs - now(), 0);
  return undefined;
}

/** `/drive/root:/a/b` → `/a/b`; anything without the root prefix is kept. */
/** A removal marker for an item that must not be (or stay) indexed. */
function tombstone(item: GraphDriveItem, removal: "deleted" | "access-revoked"): SourceItem {
  return {
    quellId: item.id,
    name: item.name ?? item.id,
    size: 0,
    modified: new Date(item.lastModifiedDateTime ?? 0),
    marker: "",
    removal,
  };
}

function stripDriveRootPrefix(path: string): string {
  const marker = "/root:";
  const index = path.indexOf(marker);
  return index >= 0 ? path.slice(index + marker.length) : path;
}

/** Drive id embedded in a Graph delta/next URL, when recognizable. */
function driveIdFromUrl(url: string): string | undefined {
  const match = /\/drives\/([^/]+)\//.exec(url);
  return match?.[1] !== undefined ? decodeURIComponent(match[1]) : undefined;
}

export function createSharepointSource(
  options: SharepointSourceOptions,
  deps: SharepointDeps,
): SharepointSource {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const throttle = new Semaphore(MAX_GRAPH_PARALLEL);

  let token: { accessToken: string; expiresAt: number } | undefined;
  let driveIdCache: string | undefined;
  let completedDeltaLink: string | undefined;

  /** RS256 self-signed assertion for the certificate client-credentials flow. */
  function clientAssertion(audience: string): string {
    const pem = options.certificatePem ?? "";
    // indexOf instead of a lazy regex, which backtracked quadratically on
    // many BEGIN markers without an END.
    const begin = pem.indexOf("-----BEGIN CERTIFICATE-----");
    const endMarker = "-----END CERTIFICATE-----";
    const end = begin === -1 ? -1 : pem.indexOf(endMarker, begin);
    if (end === -1) {
      throw new SourceRejectedError(
        "sharepoint: certificateFile must contain the certificate alongside the private key",
      );
    }
    const cert = new X509Certificate(pem.slice(begin, end + endMarker.length));
    // `fingerprint` is the colon-separated SHA-1 hex digest; x5t needs the
    // raw digest bytes, base64url-encoded.
    const fingerprintBytes = Buffer.from(cert.fingerprint.replaceAll(":", ""), "hex");
    const nowSec = Math.floor(now() / 1000);
    const signingInput = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT", x5t: b64url(fingerprintBytes) }))}.${b64url(
      JSON.stringify({
        aud: audience,
        iss: options.clientId,
        sub: options.clientId,
        jti: randomUUID(),
        nbf: nowSec,
        exp: nowSec + ASSERTION_LIFETIME_SEC,
      }),
    )}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    return `${signingInput}.${signer.sign(pem).toString("base64url")}`;
  }

  async function fetchToken(): Promise<string> {
    const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(options.tenantId)}/oauth2/v2.0/token`;
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: options.clientId,
      scope: GRAPH_SCOPE,
    });
    if (options.clientSecret !== undefined && options.clientSecret !== "") {
      form.set("client_secret", options.clientSecret);
    } else if (options.certificatePem !== undefined && options.certificatePem !== "") {
      form.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
      form.set("client_assertion", clientAssertion(tokenUrl));
    } else {
      throw new SourceRejectedError(
        "sharepoint: neither a client secret nor a certificate is configured",
      );
    }
    const response = await deps.fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!response.ok) {
      throw new SourceRejectedError(`sharepoint token request failed with ${response.status}`);
    }
    const body = (await response.json()) as GraphTokenResponse;
    if (typeof body.access_token !== "string" || body.access_token === "") {
      throw new SourceRejectedError("sharepoint token response carries no access token");
    }
    const lifetimeMs = (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000;
    token = { accessToken: body.access_token, expiresAt: now() + Math.max(lifetimeMs - TOKEN_SKEW_MS, 0) };
    return token.accessToken;
  }

  async function ensureToken(): Promise<string> {
    if (token !== undefined && token.expiresAt > now()) return token.accessToken;
    return fetchToken();
  }

  /** 429/503 with Retry-After or exponential backoff, at most MAX_ATTEMPTS. */
  async function attemptWithRetry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      if (Boolean(signal.aborted)) throw new Error("sharepoint request aborted");
      try {
        return await fn();
      } catch (error) {
        if (!(error instanceof RetryableStatusError) || attempt >= MAX_ATTEMPTS) throw error;
        await sleep(error.retryAfterMs ?? BACKOFF_BASE_MS * 2 ** (attempt - 1));
      }
    }
  }

  /** One throttled, retried Graph GET returning JSON. */
  async function graphJson<T>(url: string, signal: AbortSignal): Promise<T> {
    return throttle.run(async () =>
      attemptWithRetry(async () => {
        const accessToken = await ensureToken();
        const response = await deps.fetchImpl(url, {
          headers: { authorization: `Bearer ${accessToken}` },
          signal,
        });
        if (response.status === 429 || response.status === 503) {
          throw new RetryableStatusError(response.status, retryAfterMs(response.header?.("retry-after"), now));
        }
        if (!response.ok) {
          throw new Error(`sharepoint graph request failed with ${response.status}`);
        }
        return (await response.json()) as T;
      }, signal),
    );
  }

  async function resolveDriveId(signal: AbortSignal): Promise<string> {
    if (driveIdCache !== undefined) return driveIdCache;
    if (options.driveId !== undefined && options.driveId !== "") {
      driveIdCache = options.driveId;
      return driveIdCache;
    }
    if (options.siteUrl === undefined || options.library === undefined) {
      throw new Error("sharepoint: driveId or siteUrl + library is required");
    }
    let site: URL;
    try {
      site = new URL(options.siteUrl);
    } catch {
      throw new Error(`sharepoint: siteUrl is not an absolute URL: ${options.siteUrl}`);
    }
    const sitePath = site.pathname.replace(/^\/+/, "");
    const siteRes = await graphJson<{ id?: string }>(
      `${GRAPH_API}/sites/${site.hostname}:/${sitePath}`,
      signal,
    );
    if (siteRes.id === undefined || siteRes.id === "") {
      throw new Error(`sharepoint: site ${site.hostname}/${sitePath} not found`);
    }
    const drives = await graphJson<GraphCollection<{ id?: string; name?: string }>>(
      `${GRAPH_API}/sites/${siteRes.id}/drives`,
      signal,
    );
    const drive = (drives.value ?? []).find((d) => d.name === options.library && d.id !== undefined);
    if (drive?.id === undefined) {
      throw new Error(`sharepoint: library "${options.library}" not found on site`);
    }
    driveIdCache = drive.id;
    return driveIdCache;
  }

  /**
   * Item permissions → document ACL; link facets are never adopted. `skip`
   * names why no access list could be derived.
   */
  async function permissionsOf(
    driveId: string,
    itemId: string,
    signal: AbortSignal,
  ): Promise<
    | { acl: { allowedUsers: string[]; allowedGroups: string[] } }
    | { skip: "link_only" | "no_mappable_permissions" }
  > {
    const res = await graphJson<GraphCollection<GraphPermission>>(
      `${GRAPH_API}/drives/${driveId}/items/${encodeURIComponent(itemId)}/permissions`,
      signal,
    );
    const users = new Set<string>();
    const groups = new Set<string>();
    let hasLink = false;
    for (const permission of res.value ?? []) {
      if (permission.link !== undefined) hasLink = true;
      const identity = permission.grantedToV2;
      const upn = identity?.user?.email ?? identity?.user?.userPrincipalName;
      if (upn !== undefined && upn !== "") users.add(upn.toLowerCase());
      const groupId = identity?.group?.id;
      if (groupId !== undefined && groupId !== "") {
        groups.add(options.aclGroupMap?.[groupId] ?? groupId);
      }
    }
    if (users.size === 0 && groups.size === 0) {
      return { skip: hasLink ? "link_only" : "no_mappable_permissions" };
    }
    return { acl: { allowedUsers: [...users], allowedGroups: [...groups] } };
  }

  async function* walk(signal: AbortSignal): AsyncGenerator<SourceItem> {
    // A stored delta link already addresses the drive — resolving the site
    // again would be a wasted request.
    const initial = options.initialDeltaLink;
    const fromLink = initial !== undefined ? driveIdFromUrl(initial) : undefined;
    if (fromLink !== undefined) driveIdCache ??= fromLink;
    const driveId = await resolveDriveId(signal);
    let url = initial ?? `${GRAPH_API}/drives/${encodeURIComponent(driveId)}/root/delta`;
    for (;;) {
      if (Boolean(signal.aborted)) throw new Error("listing aborted");
      const page = await graphJson<GraphCollection<GraphDriveItem>>(url, signal);
      for (const item of page.value ?? []) {
        // Deletions arrive as the `deleted` facet. An incremental (delta)
        // listing only carries changes, so absence proves nothing there: the
        // deletion is yielded as a tombstone instead.
        if (item.deleted !== undefined) {
          yield tombstone(item, "deleted");
          continue;
        }
        if (item.file === undefined) continue; // folders and special collections
        const name = item.name ?? item.id;
        const parentRaw = item.parentReference?.path ?? "";
        const parent = stripDriveRootPrefix(parentRaw);
        const displayPath = `${parent === "" || parent === "/" ? "" : parent}/${name}`;
        if (!isIncluded(displayPath, options.include, options.exclude)) continue;
        const out: SourceItem = {
          quellId: item.id,
          name,
          size: item.size ?? item.file.size ?? 0,
          modified: new Date(item.lastModifiedDateTime ?? 0),
          // Change detection: cTag (content version) first, then eTag,
          // then the timestamp+size pair as a last resort.
          marker:
            item.cTag ??
            item.eTag ??
            `${item.lastModifiedDateTime ?? ""}:${item.size ?? item.file.size ?? 0}`,
          displayPath,
        };
        if (options.aclFromPermissions === true) {
          const permissions = await permissionsOf(driveId, item.id, signal);
          if ("skip" in permissions) {
            deps.logger?.warn({
              event: "sharepoint.item_skipped_no_acl",
              sourceId: options.id,
              itemId: item.id,
              reason: permissions.skip,
            });
            // Never indexed with an empty (tenant-wide) list; a synced copy
            // is removed even with Mirror_Delete off — access was revoked.
            yield tombstone(item, "access-revoked");
            continue;
          }
          out.acl = permissions.acl;
        }
        yield out;
      }
      const next = page["@odata.nextLink"];
      if (next === undefined) {
        const delta = page["@odata.deltaLink"];
        if (delta !== undefined && delta !== "") completedDeltaLink = delta;
        return;
      }
      url = next;
    }
  }

  return {
    list(signal: AbortSignal): AsyncIterable<SourceItem> {
      completedDeltaLink = undefined;
      return walk(signal);
    },
    listingIsIncremental(): boolean {
      // Started from a stored delta link: the listing holds changes only.
      return options.initialDeltaLink !== undefined && options.initialDeltaLink !== "";
    },
    deltaLink(): string | undefined {
      return completedDeltaLink;
    },
    async open(item: SourceItem, signal: AbortSignal): Promise<Readable> {
      const driveId = await resolveDriveId(signal);
      const url = `${GRAPH_API}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(item.quellId)}/content`;
      const buffer = await throttle.run(async () =>
        attemptWithRetry(async () => {
          const accessToken = await ensureToken();
          // The Graph content endpoint answers with a 302 to the storage
          // blob; fetch follows redirects by default.
          const response = await deps.fetchImpl(url, {
            headers: { authorization: `Bearer ${accessToken}` },
            signal,
          });
          if (response.status === 429 || response.status === 503) {
            throw new RetryableStatusError(
              response.status,
              retryAfterMs(response.header?.("retry-after"), now),
            );
          }
          if (!response.ok) {
            throw new Error(`sharepoint content download failed with ${response.status}`);
          }
          return Buffer.from(await response.arrayBuffer());
        }, signal),
      );
      return Readable.from(buffer);
    },
  };
}
