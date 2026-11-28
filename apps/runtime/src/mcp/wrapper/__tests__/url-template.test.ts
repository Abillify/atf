// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * urlTemplate resolution — unit tests (`src/mcp/wrapper/url-template.ts`)
 *
 * Covers the fail-closed contract: a templated endpoint resolves only from the
 * request metadata, and every failure mode (missing path, non-string value,
 * invalid URL, non-http scheme, embedded credentials) throws instead of
 * falling back to a default peer.
 */

import { describe, test, expect } from "bun:test";
import {
  hasUrlTemplate,
  originMatches,
  parseOriginPattern,
  resolveServerUrl,
  urlTemplatePath,
} from "../url-template.js";

const templated = {
  name: "abiliware",
  urlTemplate: "{{requestParams.deployment.url}}/mcp",
  urlTemplateAllowedOrigins: [
    "https://tenant.example",
    "http://x",
    "https://x.example",
  ],
};

describe("hasUrlTemplate / urlTemplatePath", () => {
  test("static config: no template, no path", () => {
    const cfg = { name: "s", url: "http://x/mcp" };
    expect(hasUrlTemplate(cfg)).toBe(false);
    expect(urlTemplatePath(cfg)).toBeUndefined();
  });

  test("templated config: template detected, dot path extracted", () => {
    expect(hasUrlTemplate(templated)).toBe(true);
    expect(urlTemplatePath(templated)).toBe("deployment.url");
  });

  test("whitespace inside the placeholder is tolerated", () => {
    expect(
      urlTemplatePath({ urlTemplate: "{{ requestParams.a.b_c }}" }),
    ).toBe("a.b_c");
  });
});

describe("resolveServerUrl — static configs", () => {
  test("returns config.url unchanged", () => {
    expect(
      resolveServerUrl({ name: "s", url: "http://x/mcp" }, undefined),
    ).toBe("http://x/mcp");
  });

  test("neither url nor urlTemplate throws", () => {
    expect(() => resolveServerUrl({ name: "s" }, {})).toThrow(
      /neither url nor urlTemplate/,
    );
  });
});

describe("resolveServerUrl — templated configs", () => {
  test("resolves a nested dot path from requestParams", () => {
    expect(
      resolveServerUrl(templated, {
        deployment: { url: "https://tenant.example" },
      }),
    ).toBe("https://tenant.example/mcp");
  });

  test("normalizes the resolved URL", () => {
    expect(
      resolveServerUrl(
        {
          name: "s",
          urlTemplate: "{{requestParams.base}}",
          urlTemplateAllowedOrigins: ["https://example.com"],
        },
        { base: "HTTPS://Example.COM" },
      ),
    ).toBe("https://example.com/");
  });

  test("missing requestParams throws", () => {
    expect(() => resolveServerUrl(templated, undefined)).toThrow(
      /urlTemplate resolved requestParams\.deployment\.url to a missing or empty value/,
    );
  });

  test("missing intermediate segment throws", () => {
    expect(() => resolveServerUrl(templated, {})).toThrow(
      /requestParams\.deployment\.url/,
    );
  });

  test("non-string value throws", () => {
    expect(() =>
      resolveServerUrl(templated, { deployment: { url: 42 } }),
    ).toThrow(/missing or empty value/);
  });

  test("empty / whitespace value throws", () => {
    expect(() =>
      resolveServerUrl(templated, { deployment: { url: "   " } }),
    ).toThrow(/missing or empty value/);
  });

  test("resolved value that is not a URL throws", () => {
    expect(() =>
      resolveServerUrl(templated, { deployment: { url: "not a url" } }),
    ).toThrow(/invalid URL/);
  });

  test("non-http scheme throws", () => {
    expect(() =>
      resolveServerUrl(templated, { deployment: { url: "file:///etc" } }),
    ).toThrow(/unsupported scheme/);
    expect(() =>
      resolveServerUrl(templated, { deployment: { url: "http://x" } }),
    ).not.toThrow();
  });

  test("embedded credentials throw", () => {
    expect(() =>
      resolveServerUrl(templated, {
        deployment: { url: "https://user:pw@x.example" },
      }),
    ).toThrow(/embedded credentials/);
  });

  test("$-sequences in the value are literal, not replacement patterns", () => {
    // Regression guard: String.replace interprets $& / $' in the replacement
    // string — resolution must not be corrupted by them.
    expect(
      resolveServerUrl(templated, {
        deployment: { url: "https://x.example/$&/tick" },
      }),
    ).toBe("https://x.example/$&/tick/mcp");
  });

  test("error messages name the server and urlTemplate", () => {
    expect(() => resolveServerUrl(templated, {})).toThrow(
      /abiliware.*urlTemplate/s,
    );
  });
});

describe("resolveServerUrl — urlTemplateAllowedOrigins", () => {
  const erp = {
    name: "abiliware",
    urlTemplate: "{{requestParams.deployment.url}}/mcp",
    urlTemplateAllowedOrigins: [
      "https://*.abillify.io",
      "https://erp.kunde.example:8443",
    ],
  };
  const at = (url: string) => resolveServerUrl(erp, { deployment: { url } });

  test("a templated config without an allowlist is refused (fail closed)", () => {
    expect(() =>
      resolveServerUrl(
        { name: "s", urlTemplate: "{{requestParams.u}}" },
        { u: "https://a.example" },
      ),
    ).toThrow(/no urlTemplateAllowedOrigins/);
  });

  test("wildcard covers one or more leading labels", () => {
    expect(at("https://tenant-a.abillify.io")).toBe(
      "https://tenant-a.abillify.io/mcp",
    );
    expect(at("https://a.b.abillify.io")).toBe("https://a.b.abillify.io/mcp");
  });

  test("wildcard never covers the bare suffix or a look-alike host", () => {
    expect(() => at("https://abillify.io")).toThrow(/not listed/);
    expect(() => at("https://evilabillify.io")).toThrow(/not listed/);
    expect(() => at("https://abillify.io.attacker.example")).toThrow(/not listed/);
  });

  test("scheme and port must match exactly", () => {
    expect(() => at("http://tenant-a.abillify.io")).toThrow(/not listed/);
    expect(() => at("https://tenant-a.abillify.io:8443")).toThrow(/not listed/);
    expect(at("https://erp.kunde.example:8443")).toBe(
      "https://erp.kunde.example:8443/mcp",
    );
    expect(() => at("https://erp.kunde.example")).toThrow(/not listed/);
  });

  test("host comparison ignores case", () => {
    expect(at("https://TENANT-A.Abillify.IO")).toBe(
      "https://tenant-a.abillify.io/mcp",
    );
  });

  test("the error names the refused origin but not the full URL", () => {
    expect(() => at("https://attacker.example/steal?x=1")).toThrow(
      /origin "https:\/\/attacker\.example"/,
    );
  });
});

describe("parseOriginPattern / originMatches", () => {
  test("accepts exact and wildcard origins, with and without port", () => {
    expect(parseOriginPattern("https://erp.example.com")).toEqual({
      protocol: "https:",
      host: "erp.example.com",
      wildcard: false,
      port: "",
    });
    expect(parseOriginPattern("http://*.example.com:8080/")).toEqual({
      protocol: "http:",
      host: "example.com",
      wildcard: true,
      port: "8080",
    });
  });

  test("default port in the pattern equals no port", () => {
    expect(
      originMatches("https://erp.example.com:443", new URL("https://erp.example.com/x")),
    ).toBe(true);
  });

  test("rejects paths, other schemes, inner wildcards and public-suffix wildcards", () => {
    for (const bad of [
      "https://erp.example.com/mcp",
      "ftp://erp.example.com",
      "https://erp.*.example.com",
      "https://*.com",
      "*.example.com",
      "https://user:pw@erp.example.com",
    ]) {
      expect(typeof parseOriginPattern(bad)).toBe("string");
    }
  });
});
