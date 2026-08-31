// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { checkOutboundHost, validateOutboundUrl } from "../../src/tools/outbound.ts";

describe("checkOutboundHost", () => {
  it("allows any host when the allow-list is empty", () => {
    expect(checkOutboundHost("https://anything.example/x", [])).toBeNull();
  });

  it("permits an exact host match (case-insensitive)", () => {
    expect(checkOutboundHost("https://API.example.com/v1", ["api.example.com"])).toBeNull();
  });

  it("refuses a host that is not listed", () => {
    const reason = checkOutboundHost("https://evil.example/x", ["api.example.com"]);
    expect(reason).toContain("outbound host not allowed");
    expect(reason).toContain("evil.example");
  });

  it("matches sub-domains for a leading-dot entry", () => {
    expect(checkOutboundHost("https://a.b.example.com/x", [".example.com"])).toBeNull();
    expect(checkOutboundHost("https://example.com/x", [".example.com"])).toBeNull();
    expect(checkOutboundHost("https://example.org/x", [".example.com"])).not.toBeNull();
  });

  it("reports an invalid URL", () => {
    expect(checkOutboundHost("not a url", ["api.example.com"])).toContain("invalid outbound URL");
  });
});


describe("SSRF address and protocol policy", () => {
  it("rejects non-HTTP protocols and URL credentials", () => {
    expect(checkOutboundHost("file:///etc/passwd", [])).toContain("protocol");
    expect(checkOutboundHost("https://user:pass@example.com", [])).toContain("credentials");
  });

  it("rejects IPv4 and IPv6 local, private, link-local, multicast and metadata targets", async () => {
    for (const url of [
      "http://127.0.0.1", "http://10.0.0.1", "http://169.254.169.254",
      "http://0.0.0.0", "http://224.0.0.1", "http://[::1]", "http://[fe80::1]",
      "http://[fc00::1]", "http://[ff02::1]", "http://metadata.google.internal",
    ]) expect(await validateOutboundUrl(url, [])).not.toBeNull();
  });
});