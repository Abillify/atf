// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// Regression guard for the dev console (test-page.ts): the browser's fetch
// rejects header values outside ISO-8859-1 ("String contains non ISO-8859-1
// code point") before the request is sent. References, titles, filters and
// collections routinely contain umlauts or en dashes, so every user-controlled
// header value must go through the base64: encoding helper that the server's
// readHeader decodes.
import { describe, expect, it } from "vitest";

import { getTestPageHtml } from "../src/test-page.js";

const html = getTestPageHtml();

describe("dev console header encoding", () => {
  it("defines the base64 header helper", () => {
    expect(html).toContain("function hdr(v)");
    expect(html).toContain("'base64:' + btoa(unescape(encodeURIComponent(s)))");
  });

  it("encodes every user-controlled free-text header", () => {
    const encoded = [
      "h['X-Reference']      = hdr(opts.reference)",
      "h['X-Collection']      = hdr(opts.collection)",
      "h['X-Title']           = hdr(opts.title)",
      "h['X-Source']          = hdr(opts.source)",
      "h['X-Link']            = hdr(opts.link)",
      "h['X-Tags']            = hdr(opts.tags)",
      "h['X-Allowed-Users']   = hdr(opts.allowedUsers)",
      "h['X-Allowed-Groups']  = hdr(opts.allowedGroups)",
      "'X-Base-Ref': hdr(reference)",
      "headers['X-Path-Prefix']           = hdr(pathPrefix)",
      "headers['X-Filter']                = hdr(filter)",
    ];
    for (const needle of encoded) {
      expect(html, `missing encoded header assignment: ${needle}`).toContain(
        needle,
      );
    }
  });

  it("does not assign raw user input to free-text headers", () => {
    // Raw (unencoded) assignments of variables that can hold non-ASCII input.
    const raw = [
      "'X-Base-Ref': reference",
      "= opts.reference",
      "= pathPrefix",
      "= filter;",
      "headers['X-Reference']  = reference",
    ];
    for (const needle of raw) {
      // Allow occurrences only when wrapped by hdr(...)
      const withoutEncoded = html.replaceAll(/hdr\([^)]*\)/g, "hdr()");
      expect(withoutEncoded, `raw header assignment found: ${needle}`).not.toContain(needle);
    }
  });
});
