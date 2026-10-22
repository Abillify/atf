// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Bypass corpus for `neutralizeHtmlReferences` (requirement 5.7).
 *
 * Every input below is a payload that would make the converter fetch or
 * execute something remote if the sanitizer mis-parsed it. The assertion is
 * deliberately format-agnostic: the output is decoded (HTML character
 * references resolved, backslashes removed) and then scanned for any forbidden
 * marker, so a rewrite that merely re-encodes the URL still fails.
 *
 * Case 9b is the positive control: an inline raster `data:` image must survive
 * untouched, otherwise the corpus would pass by deleting everything.
 */

import { describe, expect, it } from "vitest";
import { neutralizeHtmlReferences } from "../src/pipeline/office.js";

/** Run a page through the sanitizer and read the bytes back as text. */
function neutralize(html: string): string {
  return Buffer.from(neutralizeHtmlReferences(Buffer.from(html, "utf8"))).toString("utf8");
}

/**
 * Resolve the character references a renderer would resolve before acting on
 * the value. `&amp;` is decoded last so `&amp;#106;` is not over-decoded into a
 * second pass — the renderer does not do that either, but decoding it last
 * keeps this scanner from inventing a hit that no parser would see.
 */
function decodeEntities(s: string): string {
  let out = s;
  const named: Record<string, string> = {
    colon: ":",
    Tab: "\t",
    NewLine: "\n",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
  };
  // Numeric references decode without ";" as well, like an HTML parser.
  out = out.replace(/&(#x[0-9a-fA-F]{1,6};?|#\d{1,7};?|[a-zA-Z][a-zA-Z0-9]{1,31};)/g, (all, raw: string) => {
    const e = raw.endsWith(";") ? raw.slice(0, -1) : raw;
    if (e.startsWith("#x") || e.startsWith("#X")) {
      const code = Number.parseInt(e.slice(2), 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    if (e.startsWith("#")) {
      const code = Number.parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return named[e] ?? all;
  });
  return out.replace(/&amp;/g, "&");
}

/** Anything in sanitized output that means "the renderer may load this". */
const FORBIDDEN =
  /198\.51\.100\.7|file:|javascript:|vbscript:|data:text\/html|data:image\/svg|<base[\s/>]|http-equiv\s*=\s*["']?refresh/i;

/** Assert a payload leaves nothing loadable behind. */
function expectNeutralized(input: string): void {
  const decoded = decodeEntities(neutralize(input)).replace(/\\/g, "");
  expect(FORBIDDEN.test(decoded), `${input}\n--> ${decoded}`).toBe(false);
}

describe("neutralizeHtmlReferences bypass corpus", () => {
  it("1. keeps a quoted '>' inside an attribute value from ending the tag", () => {
    expectNeutralized('<img alt="a>b" src="http://198.51.100.7/a.png">');
  });

  it("2. treats '/' as an attribute separator", () => {
    expectNeutralized('<img/src="http://198.51.100.7/b.png">');
    expectNeutralized("<img/src=http://198.51.100.7/c.png/>");
  });

  it("3. accepts tab and newline separators in any case", () => {
    expectNeutralized("<IMG\tSRC=HTTP://198.51.100.7/d.png>");
    expectNeutralized('<img\nsrc="http://198.51.100.7/e.png">');
  });

  it("4. resolves CSS escapes in a style attribute", () => {
    expectNeutralized('<div style="background:u\\72 l(http://198.51.100.7/f)">x</div>');
    expectNeutralized('<div style="background:\\75\\72\\6c(http://198.51.100.7/g)">x</div>');
  });

  it("5. resolves CSS escapes inside <style>", () => {
    expectNeutralized("<style>@\\69mport 'http://198.51.100.7/h.css';</style>");
    expectNeutralized("<style>@import url(http://198.51.100.7/i.css);</style>");
  });

  it("6. sees through whitespace, quotes and comments around url()", () => {
    expectNeutralized(`<p style="background-image: url( 'file:///etc/hosts' )">x</p>`);
    expectNeutralized('<p style="background:url/**/(http://198.51.100.7/j)">x</p>');
  });

  it("7. covers the SVG namespace", () => {
    expectNeutralized('<svg><image href="http://198.51.100.7/k.svg"/></svg>');
    expectNeutralized('<svg><use xlink:href="file:///etc/passwd#x"/></svg>');
    expectNeutralized('<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>');
  });

  it("8. covers MathML", () => {
    expectNeutralized('<math><mi xlink:href="http://198.51.100.7/l">x</mi></math>');
    expectNeutralized('<math href="javascript:alert(1)"><mi>x</mi></math>');
  });

  it("9a. drops non-raster data: URLs", () => {
    expectNeutralized('<iframe src="data:text/html;base64,PHNjcmlwdD4=">');
    expectNeutralized('<img src="data:image/svg+xml;base64,PHN2Zy8+">');
  });

  it("9b. keeps an inline raster data: image", () => {
    const out = neutralize('<img src="data:image/png;base64,iVBORw0KGgo=">');
    expect(out).toContain("data:image/png;base64,iVBORw0KGgo=");
  });

  it("10. drops entity-encoded script link targets", () => {
    expectNeutralized('<a href="jav&#x61;script:alert(1)">x</a>');
    expectNeutralized('<a href="&#106;avascript:alert(1)">x</a>');
    expectNeutralized('<a href="java&Tab;script:alert(1)">x</a>');
    expectNeutralized('<a href="javascript&colon;alert(1)">x</a>');
    // Numeric references without the closing ";".
    expectNeutralized('<a href="&#106avascript:alert(1)">x</a>');
    expectNeutralized('<a href="jav&#x61script:alert(1)">x</a>');
  });

  it("11. drops <base>", () => {
    expectNeutralized('<base href="http://198.51.100.7/">');
    expectNeutralized("<BASE HREF=//198.51.100.7/>");
  });

  it("12. drops a refreshing <meta>", () => {
    expectNeutralized('<meta http-equiv="refresh" content="0;url=http://198.51.100.7/m">');
    expectNeutralized('<meta HTTP-EQUIV=Refresh content="0; URL=file:///etc/hosts">');
  });

  it("13. drops srcset candidates", () => {
    expectNeutralized('<img srcset="http://198.51.100.7/n.png 1x, http://198.51.100.7/o.png 2x">');
    expectNeutralized('<picture><source srcset="http://198.51.100.7/p.webp"></picture>');
  });

  it("14. drops @import in a style attribute", () => {
    expectNeutralized(`<div style="@import 'http://198.51.100.7/q.css'">x</div>`);
  });

  it("15. sees through comment tricks", () => {
    expectNeutralized('<!--><img src="http://198.51.100.7/r.png">-->');
    expectNeutralized("<!-- --!><img src=http://198.51.100.7/s.png>");
    expectNeutralized("<!---><img src=http://198.51.100.7/t.png>");
    expectNeutralized("<![CDATA[<img src=http://198.51.100.7/u.png>]]>");
  });

  it("16. drops embedding elements", () => {
    expectNeutralized('<object data="http://198.51.100.7/v">x</object>');
    expectNeutralized('<embed src="http://198.51.100.7/w">');
    expectNeutralized('<link rel="stylesheet" href="http://198.51.100.7/x.css">');
    expectNeutralized('<iframe srcdoc="<img src=http://198.51.100.7/y.png>"></iframe>');
  });

  it("17. drops form targets", () => {
    expectNeutralized(
      '<form action="http://198.51.100.7/z"><button formaction="http://198.51.100.7/z2">x</button></form>',
    );
  });
});
