// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * S3_Source (requirements 6.3, 6.4, 6.5, 8.4).
 *
 * `ListObjectsV2` paginated per `ContinuationToken`; folder markers (key
 * suffix `/`, size 0) are skipped. A configured `endpoint` replaces the AWS
 * default (6.5) with optional path-style addressing. Credentials come from
 * the Credential_Store (`source:<id>:s3-*`), an AWS profile, or the default
 * chain (6.4). Requests are SigV4-signed with `node:crypto` only — the core
 * stays dependency-free (design: Node APIs + fetch/undici).
 */

import { trimTrailingChar } from "../text-trim.js";
import { createHmac, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { sourceS3AccessKeyKey, sourceS3SecretKeyKey } from "../credentials/keys.js";
import type { CredentialStore } from "../credentials/store.js";
import type { Env } from "../config/secrets-file.js";
import { isIncluded } from "./filter.js";
import type { SourceAdapter, SourceFetch, SourceItem } from "./types.js";

export interface S3SourceOptions {
  id: string;
  bucket: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  credentials: "store" | { profile: string } | "default-chain";
  include?: readonly string[];
  exclude?: readonly string[];
}

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3Deps {
  fetchImpl: SourceFetch;
  store: CredentialStore;
  env: Env;
  /** Injectable AWS config/credentials file reader (profile chain). */
  readFile?: (path: string) => Promise<string>;
  /** Injectable home directory for `~/.aws/credentials`. */
  homeDir?: string;
  now?: () => Date;
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

const sha256hex = (data: string): string => createHash("sha256").update(data, "utf8").digest("hex");

/** AWS-URI-encode per SigV4 (RFC 3986, `/` preserved unless path=false). */
function uriEncode(value: string, encodeSlash = true): string {
  let out = "";
  for (const ch of value) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else if (ch === "/" && !encodeSlash) out += ch;
    else {
      for (const byte of Buffer.from(ch, "utf8")) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    }
  }
  return out;
}

interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/** Build a SigV4-signed GET request (unsigned payload = sha256 of ""). */
export function signS3Get(args: {
  method: string;
  host: string;
  /** Path portion, already URI-encoded per object-key rules. */
  canonicalUri: string;
  /** Raw (unencoded) query parameters. */
  query: Record<string, string | undefined>;
  region: string;
  credentials: S3Credentials;
  now: Date;
  scheme?: "http" | "https";
}): SignedRequest {
  const amzDate = args.now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host: args.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": EMPTY_SHA256,
  };
  if (args.credentials.sessionToken !== undefined) {
    headers["x-amz-security-token"] = args.credentials.sessionToken;
  }
  const sortedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderNames
    .map((name) => `${name}:${(headers[name] ?? "").trim()}\n`)
    .join("");
  const signedHeaders = sortedHeaderNames.join(";");
  const queryEntries = Object.entries(args.query)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => [uriEncode(key), uriEncode(value)] as const)
    .sort(([ak, av], [bk, bv]) => (ak === bk ? av.localeCompare(bv) : ak.localeCompare(bk)));
  const canonicalQuery = queryEntries.map(([k, v]) => `${k}=${v}`).join("&");
  const canonicalRequest = [
    args.method,
    args.canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    EMPTY_SHA256,
  ].join("\n");
  const scope = `${dateStamp}/${args.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join("\n");
  const kDate = hmac(`AWS4${args.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, args.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");
  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${args.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const scheme = args.scheme ?? "https";
  const url = `${scheme}://${args.host}${args.canonicalUri}${canonicalQuery === "" ? "" : `?${canonicalQuery}`}`;
  return { url, headers };
}

interface ResolvedTarget {
  host: string;
  /** Path prefix for path-style addressing ("" for virtual-hosted). */
  pathPrefix: string;
  scheme: "http" | "https";
}

/** Resolve host/path per endpoint and forcePathStyle (6.5). */
export function resolveS3Target(
  bucket: string,
  region: string,
  endpoint?: string,
  forcePathStyle?: boolean,
): ResolvedTarget {
  if (endpoint === undefined || endpoint === "") {
    return {
      host: `${bucket}.s3.${region}.amazonaws.com`,
      pathPrefix: "",
      scheme: "https",
    };
  }
  const url = new URL(endpoint);
  const scheme = url.protocol === "http:" ? "http" : "https";
  const pathStyle = forcePathStyle === true || url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (pathStyle) {
    const base = trimTrailingChar(url.pathname, "/");
    return { host: url.host, pathPrefix: `${base}/${bucket}`, scheme };
  }
  return { host: `${bucket}.${url.host}`, pathPrefix: "", scheme };
}

/**
 * The text between `open` and the next `close` at or after `from`, and the
 * offset after `close`. indexOf-based: the lazy regexes it replaces
 * (`<Contents>([\s\S]*?)</Contents>`) backtracked quadratically on many
 * unterminated elements.
 */
function textBetween(
  text: string,
  open: string,
  close: string,
  from: number,
): { text: string; next: number } | undefined {
  const start = text.indexOf(open, from);
  if (start === -1) return undefined;
  const end = text.indexOf(close, start + open.length);
  if (end === -1) return undefined;
  return { text: text.slice(start + open.length, end), next: end + close.length };
}

/** Content of the first `<name ...>…</name>` element in `text`. */
function elementText(text: string, name: string): string | undefined {
  const start = text.indexOf(`<${name}`);
  if (start === -1) return undefined;
  const tagEnd = text.indexOf(">", start);
  if (tagEnd === -1) return undefined;
  const close = text.indexOf(`</${name}>`, tagEnd + 1);
  return close === -1 ? undefined : text.slice(tagEnd + 1, close);
}

/** Minimal ListBucketResult XML extraction (no external parser). */
export function parseListObjectsV2(xml: string): {
  contents: { key: string; size: number; lastModified: string; etag: string }[];
  isTruncated: boolean;
  nextContinuationToken?: string;
} {
  const decode = (s: string): string =>
    s
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  const contents: { key: string; size: number; lastModified: string; etag: string }[] = [];
  const encoded = xml.includes("<EncodingType>url</EncodingType>");
  for (let from = 0; ; ) {
    const block = textBetween(xml, "<Contents>", "</Contents>", from);
    if (block === undefined) break;
    from = block.next;
    const field = (name: string): string | undefined => elementText(block.text, name);
    const rawKey = field("Key");
    if (rawKey === undefined) continue;
    const key = decode(encoded ? decodeURIComponent(rawKey) : rawKey);
    contents.push({
      key,
      size: Number(field("Size") ?? "0"),
      lastModified: field("LastModified") ?? "",
      etag: (field("ETag") ?? "").replace(/^"|"$/g, ""),
    });
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml);
  const token = textBetween(xml, "<NextContinuationToken>", "</NextContinuationToken>", 0);
  return {
    contents,
    isTruncated: truncated,
    nextContinuationToken: token !== undefined ? decode(token.text) : undefined,
  };
}

/** Parse an AWS credentials/config INI file into profile maps. */
export function parseAwsIni(content: string): Map<string, Record<string, string>> {
  const profiles = new Map<string, Record<string, string>>();
  let current: Record<string, string> | undefined;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    // Plain string scanning: the section and key=value regexes this replaces
    // backtracked quadratically on long blank runs.
    if (line.startsWith("[") && line.endsWith("]") && line.length > 2) {
      const inner = line.slice(1, -1);
      if (!inner.includes("]")) {
        const named = /^profile\s/.test(inner) ? inner.slice("profile".length).trimStart() : "";
        current = {};
        profiles.set(named !== "" ? named : inner, current);
        continue;
      }
    }
    const eq = line.indexOf("=");
    if (eq > 0 && current !== undefined) {
      current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  return profiles;
}

/** Resolve credentials per mode (6.4): store → profile → default chain. */
export async function resolveS3Credentials(
  options: S3SourceOptions,
  deps: S3Deps,
): Promise<S3Credentials | undefined> {
  if (options.credentials === "store") {
    const accessKeyId = await deps.store.get(sourceS3AccessKeyKey(options.id));
    const secretAccessKey = await deps.store.get(sourceS3SecretKeyKey(options.id));
    if (accessKeyId !== null && secretAccessKey !== null) {
      return { accessKeyId, secretAccessKey };
    }
    // Missing store credentials fall through to the default chain (6.4:
    // "without stored keys, the profile or chain is used afterwards").
    return chainCredentials(deps);
  }
  if (typeof options.credentials === "object") {
    return profileCredentials(options.credentials.profile, deps);
  }
  return chainCredentials(deps);
}

async function profileCredentials(
  profile: string,
  deps: S3Deps,
): Promise<S3Credentials | undefined> {
  const readFile = deps.readFile;
  const home = deps.homeDir ?? "~";
  if (readFile === undefined) return undefined;
  try {
    const ini = parseAwsIni(await readFile(`${home}/.aws/credentials`));
    const entry = ini.get(profile);
    const id = entry?.["aws_access_key_id"];
    const secret = entry?.["aws_secret_access_key"];
    if (id !== undefined && secret !== undefined) {
      return {
        accessKeyId: id,
        secretAccessKey: secret,
        sessionToken: entry?.["aws_session_token"],
      };
    }
  } catch {
    // fall through
  }
  return undefined;
}

async function chainCredentials(deps: S3Deps): Promise<S3Credentials | undefined> {
  const envId = deps.env["AWS_ACCESS_KEY_ID"];
  const envSecret = deps.env["AWS_SECRET_ACCESS_KEY"];
  if (envId !== undefined && envSecret !== undefined) {
    return {
      accessKeyId: envId,
      secretAccessKey: envSecret,
      sessionToken: deps.env["AWS_SESSION_TOKEN"],
    };
  }
  return profileCredentials(deps.env["AWS_PROFILE"] ?? "default", deps);
}

export function createS3Source(options: S3SourceOptions, deps: S3Deps): SourceAdapter {
  const region = options.region ?? "us-east-1";
  const now = deps.now ?? (() => new Date());
  return {
    async *list(signal: AbortSignal): AsyncIterable<SourceItem> {
      const credentials = await resolveS3Credentials(options, deps);
      if (credentials === undefined) {
        throw new Error(`s3 source ${options.id}: no credentials available`);
      }
      const target = resolveS3Target(options.bucket, region, options.endpoint, options.forcePathStyle);
      let continuationToken: string | undefined;
      do {
        const query: Record<string, string | undefined> = {
          "list-type": "2",
          "encoding-type": "url",
          prefix: options.prefix,
          "continuation-token": continuationToken,
        };
        const signed = signS3Get({
          method: "GET",
          host: target.host,
          canonicalUri: `${target.pathPrefix}/`,
          query,
          region,
          credentials,
          now: now(),
          scheme: target.scheme,
        });
        const response = await deps.fetchImpl(signed.url, {
          method: "GET",
          headers: signed.headers,
          signal,
        });
        if (!response.ok) {
          throw new Error(`s3 ListObjectsV2 failed with ${response.status}`);
        }
        const xml = await response.text();
        const page = parseListObjectsV2(xml);
        for (const obj of page.contents) {
          // Folder markers: key ends with "/" and size 0 (skip).
          if (obj.key.endsWith("/") && obj.size === 0) continue;
          if (!isIncluded(obj.key, options.include, options.exclude)) continue;
          yield {
            quellId: obj.key,
            name: obj.key.slice(obj.key.lastIndexOf("/") + 1),
            size: obj.size,
            modified: new Date(obj.lastModified),
            marker: obj.etag,
            link:
              options.endpoint !== undefined && options.endpoint !== ""
                ? `${target.scheme}://${target.host}${target.pathPrefix}/${obj.key.split("/").map((s) => encodeURIComponent(s)).join("/")}`
                : `s3://${options.bucket}/${obj.key}`,
          };
        }
        continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (continuationToken !== undefined);
    },
    async open(item: SourceItem, signal: AbortSignal): Promise<Readable> {
      const credentials = await resolveS3Credentials(options, deps);
      if (credentials === undefined) {
        throw new Error(`s3 source ${options.id}: no credentials available`);
      }
      const target = resolveS3Target(options.bucket, region, options.endpoint, options.forcePathStyle);
      const canonicalUri = `${target.pathPrefix}/${item.quellId
        .split("/")
        .map((s) => uriEncode(s))
        .join("/")}`;
      const signed = signS3Get({
        method: "GET",
        host: target.host,
        canonicalUri,
        query: {},
        region,
        credentials,
        now: now(),
        scheme: target.scheme,
      });
      const response = await deps.fetchImpl(signed.url, {
        method: "GET",
        headers: signed.headers,
        signal,
      });
      if (!response.ok) {
        throw new Error(`s3 GET ${item.quellId} failed with ${response.status}`);
      }
      const bytes = await response.arrayBuffer();
      return Readable.from(Buffer.from(bytes));
    },
  };
}
