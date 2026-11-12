// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * CIDR support for the egress allow-list: parsing (`<ip>/<bits>` for both
 * families), range membership — including an IPv4 written in IPv6 form, which
 * must be judged as the address it embeds — and the host/CIDR partition used
 * by `EGRESS_ALLOW_PRIVATE_HOSTS`.
 */

import { describe, expect, test } from "bun:test";
import {
	isAddressInCidr,
	parseCidr,
	partitionAllowlistEntries,
} from "../src/index.js";

describe("parseCidr", () => {
	test("parses IPv4 ranges", () => {
		expect(parseCidr("10.64.0.0/14")).toEqual({
			family: 4,
			base: 0x0a400000,
			bits: 14,
		});
		expect(parseCidr("0.0.0.0/0")).toEqual({ family: 4, base: 0, bits: 0 });
		expect(parseCidr("192.168.1.1/32")).toEqual({
			family: 4,
			base: 0xc0a80101,
			bits: 32,
		});
	});

	test("parses IPv6 ranges, with and without brackets", () => {
		const v6 = parseCidr("fd00::/8");
		expect(v6?.family).toBe(6);
		expect(v6?.bits).toBe(8);
		expect(parseCidr("[fd00::]/8")).toEqual(v6);
	});

	test("rejects non-ranges and out-of-range prefixes", () => {
		expect(parseCidr("10.64.2.7")).toBeUndefined();
		expect(parseCidr("example.com/14")).toBeUndefined();
		expect(parseCidr("10.0.0.0/33")).toBeUndefined();
		expect(parseCidr("fd00::/129")).toBeUndefined();
		expect(parseCidr("10.0.0.0/")).toBeUndefined();
		expect(parseCidr("10.0.0.0/abc")).toBeUndefined();
		expect(parseCidr("/14")).toBeUndefined();
	});
});

function mustParse(entry: string) {
	const range = parseCidr(entry);
	if (range === undefined) throw new Error(`expected a valid CIDR: ${entry}`);
	return range;
}

describe("isAddressInCidr", () => {
	const net14 = mustParse("10.64.0.0/14");

	test("matches the boundaries of a /14", () => {
		expect(isAddressInCidr("10.64.0.0", net14)).toBe(true);
		expect(isAddressInCidr("10.64.2.7", net14)).toBe(true);
		expect(isAddressInCidr("10.67.255.255", net14)).toBe(true);
		expect(isAddressInCidr("10.63.255.255", net14)).toBe(false);
		expect(isAddressInCidr("10.68.0.0", net14)).toBe(false);
		expect(isAddressInCidr("192.168.1.1", net14)).toBe(false);
	});

	test("/0 matches every address of the family", () => {
		const any = mustParse("0.0.0.0/0");
		expect(isAddressInCidr("8.8.8.8", any)).toBe(true);
		expect(isAddressInCidr("10.0.0.1", any)).toBe(true);
	});

	test("/32 matches exactly one address", () => {
		const single = mustParse("10.64.2.7/32");
		expect(isAddressInCidr("10.64.2.7", single)).toBe(true);
		expect(isAddressInCidr("10.64.2.8", single)).toBe(false);
	});

	test("judges an IPv4 written in IPv6 form as the embedded IPv4", () => {
		expect(isAddressInCidr("::ffff:10.64.2.7", net14)).toBe(true);
		expect(isAddressInCidr("::ffff:10.68.0.1", net14)).toBe(false);
	});

	test("never matches across families", () => {
		const v6 = mustParse("fd00::/8");
		expect(isAddressInCidr("fd12:3456::1", v6)).toBe(true);
		expect(isAddressInCidr("fe80::1", v6)).toBe(false);
		// A v4 range never matches a plain v6 address…
		expect(isAddressInCidr("fd00::1", net14)).toBe(false);
		// …and a v6 range never matches a plain v4 address.
		expect(isAddressInCidr("10.64.2.7", v6)).toBe(false);
	});

	test("unparseable input never matches (fail closed)", () => {
		expect(isAddressInCidr("not-an-ip", net14)).toBe(false);
		expect(isAddressInCidr("", net14)).toBe(false);
	});
});

describe("partitionAllowlistEntries", () => {
	test("keeps plain hosts as hosts and slashes as ranges", () => {
		const result = partitionAllowlistEntries([
			"mcpgate",
			"db.example.internal",
			"10.64.0.0/14",
			"192.168.1.50",
			"fd00::/8",
		]);
		expect(result.hosts).toEqual([
			"mcpgate",
			"db.example.internal",
			"192.168.1.50",
		]);
		expect(result.cidrs.map((range) => range.bits)).toEqual([14, 8]);
		expect(result.invalid).toEqual([]);
	});

	test("reports malformed CIDR entries instead of dropping them silently", () => {
		const result = partitionAllowlistEntries([
			"10.0.0.0/33",
			"example.com/8",
			"ok.example",
		]);
		expect(result.hosts).toEqual(["ok.example"]);
		expect(result.cidrs).toEqual([]);
		expect(result.invalid).toEqual(["10.0.0.0/33", "example.com/8"]);
	});

	test("ignores blank entries", () => {
		expect(partitionAllowlistEntries(["", "  "])).toEqual({
			hosts: [],
			cidrs: [],
			invalid: [],
		});
	});
});
