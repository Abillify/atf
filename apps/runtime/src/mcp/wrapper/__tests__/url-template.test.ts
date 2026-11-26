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
  resolveServerUrl,
  urlTemplatePath,
} from "../url-template.js";

const templated = {
  name: "abiliware",
  urlTemplate: "{{requestParams.deployment.url}}/mcp",
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
        { name: "s", urlTemplate: "{{requestParams.base}}" },
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
