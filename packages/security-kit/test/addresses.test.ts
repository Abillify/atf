// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * The block table (Sperrtabelle) and its behaviour for every textual form an
 * address can take — including IPv4 hidden inside IPv6 (mapped, compatible,
 * NAT64, 6to4).
 *
 * Property 12 (Egress-Blockade): for arbitrary IPv4/IPv6 addresses, the guard
 * blocks exactly the addresses of the block table. The oracle below is an
 * independent bigint implementation of the same table; the property asserts
 * the production classifier agrees with it for randomly generated addresses
 * rendered in randomly chosen equivalent textual forms.
 */

import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import {
  isAlwaysForbiddenAddress,
  isForbiddenAddress,
  isHostAllowed,
  parseIPv4,
  parseIPv6,
} from "../src/index.js";

describe("parseIPv4", () => {
  test("parses canonical addresses", () => {
    expect(parseIPv4("0.0.0.0")).toBe(0);
    expect(parseIPv4("255.255.255.255")).toBe(0xffffffff);
    expect(parseIPv4("192.168.1.1")).toBe(0xc0a80101);
  });
  test("rejects malformed", () => {
    expect(parseIPv4("1.2.3")).toBeUndefined();
    expect(parseIPv4("1.2.3.4.5")).toBeUndefined();
    expect(parseIPv4("256.0.0.1")).toBeUndefined();
    expect(parseIPv4("1.2.3.a")).toBeUndefined();
    expect(parseIPv4("01.2.3.4")).toBe(0x01020304); // leading zeros are numeric
  });
});

describe("parseIPv6", () => {
  test("expands compression", () => {
    expect(parseIPv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("2001:db8::ff")).toEqual([0x2001, 0x0db8, 0, 0, 0, 0, 0, 0xff]);
    expect(parseIPv6("fe80::1%eth0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });
  test("embeds a dotted IPv4 tail", () => {
    expect(parseIPv6("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
  });
  test("rejects malformed", () => {
    expect(parseIPv6("1:2:3:4:5:6:7")).toBeUndefined(); // 7 groups, no ::
    expect(parseIPv6("1:2:3:4:5:6:7:8:9")).toBeUndefined();
    expect(parseIPv6(":::1")).toBeUndefined();
    expect(parseIPv6("g::1")).toBeUndefined();
  });
});

describe("isForbiddenAddress (table spot-checks)", () => {
  const forbidden = [
    "0.0.0.0",
    "10.255.255.254",
    "100.64.0.1",
    "100.100.100.200", // CGNAT incl. metadata
    "127.0.0.1",
    "127.1.2.3",
    "169.254.169.254", // cloud metadata
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.1", // TEST-NET-1
    "192.168.0.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7", // TEST-NET-2
    "203.0.113.5", // TEST-NET-3
    "::ffff:203.0.113.5", // mapped TEST-NET-3
    "2001:db8::1", // IPv6 documentation prefix
    "2001:db8:ffff::1",
    "224.0.0.5",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1", // mapped loopback
    "::ffff:169.254.169.254", // mapped metadata
    "::10.0.0.1", // IPv4-compatible private
    "64:ff9b::192.168.0.1", // NAT64 to private
    "2002:7f00:0001::", // 6to4 carrying 127.0.0.1
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
    "[fe80::1]",
    "not-an-ip", // fail closed
    "",
  ];
  for (const address of forbidden) {
    test(`forbids ${address}`, () => {
      expect(isForbiddenAddress(address)).toBe(true);
    });
  }

  const allowed = [
    "1.1.1.1",
    "8.8.8.8",
    "93.184.216.34",
    "100.63.255.255", // just below CGNAT
    "100.128.0.1", // just above CGNAT
    "172.15.0.1",
    "172.32.0.1",
    "192.169.255.255",
    "198.17.255.255",
    "198.20.0.1",
    "192.0.3.1", // just above TEST-NET-1
    "198.51.101.1", // just above TEST-NET-2
    "203.0.114.1", // just above TEST-NET-3
    "2001:db9::1", // just above the IPv6 documentation prefix
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
    "2002:0101:0101::", // 6to4 carrying 1.1.1.1
  ];
  for (const address of allowed) {
    test(`permits ${address}`, () => {
      expect(isForbiddenAddress(address)).toBe(false);
    });
  }
});

describe("isAlwaysForbiddenAddress", () => {
  test("link-local and metadata stay forbidden", () => {
    for (const address of ["169.254.1.1", "100.100.100.200", "fe80::1", "fd00:ec2::254"]) {
      expect(isAlwaysForbiddenAddress(address)).toBe(true);
    }
  });
  test("ordinary private space is not always-forbidden", () => {
    for (const address of ["10.0.0.1", "192.168.1.1", "127.0.0.1", "::1"]) {
      expect(isAlwaysForbiddenAddress(address)).toBe(false);
    }
  });
  test("mapped metadata is always-forbidden", () => {
    expect(isAlwaysForbiddenAddress("::ffff:169.254.169.254")).toBe(true);
  });
  test("unparseable fails closed", () => {
    expect(isAlwaysForbiddenAddress("garbage")).toBe(true);
  });
});

describe("isHostAllowed", () => {
  test("exact and subdomain suffix matching", () => {
    expect(isHostAllowed("api.example.com", ["api.example.com"])).toBe(true);
    expect(isHostAllowed("sub.api.example.com", [".api.example.com"])).toBe(true);
    expect(isHostAllowed("api.example.com", [".api.example.com"])).toBe(false);
    expect(isHostAllowed("evil-example.com", [".example.com"])).toBe(false);
    expect(isHostAllowed("API.Example.COM", ["api.example.com"])).toBe(true);
    expect(isHostAllowed("api.example.com", [])).toBe(false);
  });
});

// ── Property 12: Egress-Blockade ────────────────────────────────────────────

/** Independent bigint oracle for the block table (128-bit space). */
const ORACLE_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];
const ORACLE_V6: ReadonlyArray<readonly [string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
];

function v4ToBits(value: number): bigint {
  return BigInt(value >>> 0);
}

function bitsInCidr(bits: bigint, base: string, prefix: number, width: 32 | 128): boolean {
  const baseBits = width === 32 ? v4ToBits(parseOracleV4(base)) : parseOracleV6(base);
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(width - prefix);
  return (bits & mask) === (baseBits & mask);
}

function parseOracleV4(text: string): number {
  const parts = text.split(".");
  if (parts.length !== 4) throw new Error(`bad oracle v4 ${text}`);
  let value = 0;
  for (const part of parts) value = value * 256 + Number(part);
  return value;
}

function parseOracleV6(text: string): bigint {
  // Independent expansion via full-form padding.
  let body = text.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  let v4Tail: number | undefined;
  const lastColon = body.lastIndexOf(":");
  if (body.slice(lastColon + 1).includes(".")) {
    v4Tail = parseOracleV4(body.slice(lastColon + 1));
    body = `${body.slice(0, lastColon + 1)}0:0`;
  }
  const halves = body.split("::");
  const head = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const tail = halves.length === 2 ? (halves[1] === "" ? [] : (halves[1] ?? "").split(":")) : [];
  const fillCount = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array.from({ length: fillCount }, () => "0"), ...tail];
  let bits = 0n;
  for (const g of groups) bits = (bits << 16n) | BigInt(Number.parseInt(g, 16));
  if (v4Tail !== undefined) bits = (bits & ~0xffffffffn) | v4ToBits(v4Tail);
  return bits;
}

function oracleForbidden(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const isV6 = bare.includes(":");
  if (!isV6) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return true; // fail closed
    const value = parseOracleV4(bare);
    if ([...bare.split(".")].some((o) => Number(o) > 255)) return true;
    return ORACLE_V4.some(([base, prefix]) => bitsInCidr(v4ToBits(value), base, prefix, 32));
  }
  const bits = parseOracleV6(bare);
  if (ORACLE_V6.some(([base, prefix]) => bitsInCidr(bits, base, prefix, 128))) return true;
  // Embedded IPv4 forms, keyed on the top 96 bits: mapped (::ffff:0:0/96),
  // compatible (::/96), NAT64 well-known (64:ff9b::/96); 6to4 (2002::/16)
  // carries the IPv4 in bits 95..64 instead.
  const top96 = bits >> 32n;
  const embedded = Number(bits & 0xffffffffn);
  const v4Forbidden = (value: number) =>
    ORACLE_V4.some(([base, prefix]) => bitsInCidr(v4ToBits(value), base, prefix, 32));
  if (top96 === 0xffffn || top96 === 0n) return v4Forbidden(embedded);
  if (top96 === 0x0064ff9b0000000000000000n) return v4Forbidden(embedded); // NAT64 well-known
  if ((bits >> 112n) === 0x2002n) return v4Forbidden(Number((bits >> 80n) & 0xffffffffn)); // 6to4
  return false;
}

/** Arbitrary 32-bit addresses rendered as IPv4 text or an equivalent IPv6 form. */
const v4FormsArb = fc.integer({ min: 0, max: 0xffffffff }).chain((value) => {
  const dotted = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
  const hex = (n: number) => n.toString(16);
  const g6 = (value >>> 16) & 0xffff;
  const g7 = value & 0xffff;
  const forms: string[] = [
    dotted,
    `::ffff:${dotted}`,
    `0:0:0:0:0:ffff:${hex(g6)}:${hex(g7)}`,
    `::${dotted}`, // IPv4-compatible form
    `64:ff9b::${dotted}`, // NAT64
    `2002:${hex(g6)}:${hex(g7)}::`, // 6to4
  ];
  return fc.constantFrom(...forms);
});

const v6Arb = fc
  .tuple(
    fc.integer({ min: 0, max: 0xffff }),
    fc.integer({ min: 0, max: 0xffff }),
    fc.integer({ min: 0, max: 0xffff }),
    fc.integer({ min: 0, max: 0xffff }),
    fc.integer({ min: 0, max: 0xffff }),
    fc.integer({ min: 0, max: 0xffff }),
    fc.integer({ min: 0, max: 0xffff }),
    fc.integer({ min: 0, max: 0xffff }),
  )
  .chain(([a, b, c, d, e, f, g, h]) => {
    const full = [a, b, c, d, e, f, g, h].map((n) => n.toString(16).padStart(4, "0")).join(":");
    const compressed = [a, b, c, d, e, f, g, h]
      .map((n) => n.toString(16))
      .join(":")
      .replace(/(^|:)0(:0)+(:|$)/, "::");
    return fc.constantFrom(full, compressed, `[${full}]`);
  });

describe("Property 12: Egress-Blockade", () => {
  test("classification agrees with the independent oracle for IPv4 in every form", () => {
    fc.assert(
      fc.property(v4FormsArb, (address) => isForbiddenAddress(address) === oracleForbidden(address)),
      { numRuns: 5000 },
    );
  });

  test("classification agrees with the independent oracle for arbitrary IPv6", () => {
    fc.assert(
      fc.property(v6Arb, (address) => isForbiddenAddress(address) === oracleForbidden(address)),
      { numRuns: 5000 },
    );
  });

  test("always-forbidden implies forbidden", () => {
    fc.assert(
      fc.property(fc.oneof(v4FormsArb, v6Arb), (address) => {
        const always = isAlwaysForbiddenAddress(address);
        return !always || isForbiddenAddress(address);
      }),
      { numRuns: 2000 },
    );
  });
});
