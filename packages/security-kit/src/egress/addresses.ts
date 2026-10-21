// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * addresses.ts
 *
 * IP address classification shared by every guarded egress call. Lifted from
 * the Extract `source-url` module (the most complete table in the product) so
 * all services refuse exactly the same address space: private, loopback,
 * link-local/metadata, ULA, CGNAT, unspecified, multicast, reserved, the
 * benchmarking range 198.18.0.0/15, the IETF protocol-assignment range
 * 192.0.0.0/24, the documentation ranges (TEST-NET-1/2/3 and 2001:db8::/32 —
 * never routable, so a name resolving there is a misconfiguration or an
 * attempt to reach something internal), and every form in which a forbidden IPv4 can hide inside an
 * IPv6 literal — IPv4-mapped (`::ffff:0:0/96`), IPv4-compatible, NAT64
 * well-known (`64:ff9b::/96`) and 6to4 (`2002::/16`).
 *
 * Fail-closed: anything that does not parse as an IP address is forbidden.
 */

import { isIP } from "node:net";

/** IPv4 CIDR blocks that are never a legitimate outbound target. */
const FORBIDDEN_V4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8 "this network" (incl. 0.0.0.0)
  [0x0a000000, 8], // 10.0.0.0/8 private
  [0x64400000, 10], // 100.64.0.0/10 CGNAT (incl. 100.100.100.200 metadata)
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local / cloud metadata
  [0xac100000, 12], // 172.16.0.0/12 private
  [0xc0000000, 24], // 192.0.0.0/24 IETF protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24 TEST-NET-1 documentation
  [0xc0a80000, 16], // 192.168.0.0/16 private
  [0xc6120000, 15], // 198.18.0.0/15 benchmarking
  [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2 documentation
  [0xcb007100, 24], // 203.0.113.0/24 TEST-NET-3 documentation
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4], // 240.0.0.0/4 reserved (incl. 255.255.255.255)
];

/** IPv4 CIDRs that stay forbidden even when `allowPrivateHosts` relaxes the rest. */
const ALWAYS_FORBIDDEN_V4: ReadonlyArray<readonly [number, number]> = [
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local / cloud metadata
  [0x64400000, 10], // 100.64.0.0/10 CGNAT (incl. 100.100.100.200 metadata)
];

export function parseIPv4(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

function inCidr(value: number, base: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((value & mask) >>> 0) === ((base & mask) >>> 0);
}

function isForbiddenIPv4(value: number): boolean {
  return FORBIDDEN_V4.some(([base, bits]) => inCidr(value, base, bits));
}

/** Expand an IPv6 literal (optionally with an embedded IPv4 tail) to 8 hextets. */
export function parseIPv6(address: string): number[] | undefined {
  let text = address.replace(/^\[|\]$/g, "");
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIPv4(maybeV4);
    if (v4 === undefined) return undefined;
    tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const toGroups = (part: string | undefined) =>
    part === undefined || part === "" ? [] : part.split(":").map((g) => Number.parseInt(g, 16));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const groups = [...head, ...Array.from({ length: fill }, () => 0), ...rest];
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) {
    return undefined;
  }
  if (tail.length === 2) {
    groups[6] = tail[0] ?? 0;
    groups[7] = tail[1] ?? 0;
  }
  return groups;
}

/** The IPv4 embedded in an IPv6 address, when the form carries one. */
function embeddedIPv4(groups: number[]): number | undefined {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const upperZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (upperZero && (g5 === 0xffff || g5 === 0)) return ((g6 << 16) >>> 0) + g7;
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return ((g6 << 16) >>> 0) + g7;
  }
  if (g0 === 0x2002) return ((g1 << 16) >>> 0) + g2;
  return undefined;
}

function isForbiddenIPv6(groups: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const embedded = embeddedIPv4(groups);
  const upperZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // :: (unspecified) and ::1 (loopback).
  if (upperZero && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;
  // IPv4-mapped / IPv4-compatible / NAT64 / 6to4: judge the embedded IPv4.
  if (embedded !== undefined && isForbiddenIPv4(embedded)) return true;
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation
  return false;
}

/**
 * Whether an IP literal is outside the public unicast space. Unparseable input
 * counts as forbidden (fail closed).
 */
export function isForbiddenAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const family = isIP(bare.split("%")[0] ?? bare);
  if (family === 4) {
    const value = parseIPv4(bare);
    return value === undefined || isForbiddenIPv4(value);
  }
  if (family === 6) {
    const groups = parseIPv6(bare);
    return groups === undefined || isForbiddenIPv6(groups);
  }
  return true;
}

/**
 * Whether an IP literal is link-local or a cloud-metadata address — the set
 * that stays forbidden even under `allowPrivateHosts`. Unparseable input
 * counts as forbidden (fail closed).
 */
export function isAlwaysForbiddenAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const family = isIP(bare.split("%")[0] ?? bare);
  if (family === 4) {
    const value = parseIPv4(bare);
    if (value === undefined) return true;
    return ALWAYS_FORBIDDEN_V4.some(([base, bits]) => inCidr(value, base, bits));
  }
  if (family === 6) {
    const groups = parseIPv6(bare);
    if (groups === undefined) return true;
    const [g0 = 0] = groups;
    const embedded = embeddedIPv4(groups);
    if (embedded !== undefined) {
      if (ALWAYS_FORBIDDEN_V4.some(([base, bits]) => inCidr(embedded, base, bits))) return true;
    }
    if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10
    // AWS IPv6 instance metadata endpoint fd00:ec2::254.
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = groups;
    return a === 0xfd00 && b === 0x0ec2 && c === 0 && d === 0 && e === 0 && f === 0 && g === 0 && h === 0x0254;
  }
  return true;
}

/** Host names that always name a metadata endpoint, whatever DNS says. */
export const FORBIDDEN_HOST_PATTERNS: readonly RegExp[] = [
  /^169\.254\./,
  /^\[?fe80:/i,
  /^\[?::ffff:169\.254\./i,
  /^metadata\.google\.internal$/i,
];

/** Exact match, or a `.example.com` suffix entry matching any subdomain. */
export function isHostAllowed(host: string, allowed: readonly string[]): boolean {
  const lower = host.toLowerCase();
  return allowed.some((entry) => {
    const candidate = entry.trim().toLowerCase();
    if (candidate === "") return false;
    if (candidate.startsWith(".")) return lower.endsWith(candidate);
    return lower === candidate;
  });
}
