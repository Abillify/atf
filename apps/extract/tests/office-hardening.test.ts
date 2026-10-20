// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * LibreOffice profile hardening (requirement 5.6): the generated
 * `registrymodifications.xcu` must disable macro execution and the loading of
 * external links, and `convertToPdf` must install it before the binary starts.
 *
 * The conversion itself is exercised with a stub binary — a shell script that
 * records its arguments and produces a PDF — so the test asserts the contract
 * (profile written, flags passed) without depending on a LibreOffice install.
 */

import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  convertToPdf,
  neutralizeHtmlReferences,
  probeLibreOfficeIdentity,
  writeHardenedProfile,
} from "../src/pipeline/office.js";

describe("writeHardenedProfile", () => {
  it("writes the macro and link blocks into user/registrymodifications.xcu", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lo-profile-"));
    await writeHardenedProfile(dir);
    const xcu = await readFile(join(dir, "user", "registrymodifications.xcu"), "utf8");

    // Macro execution off, verified key names under Common/Security/Scripting.
    expect(xcu).toContain('oor:path="/org.openoffice.Office.Common/Security/Scripting"');
    expect(xcu).toContain('oor:name="MacroSecurityLevel"');
    expect(xcu).toContain("<value>3</value>");
    expect(xcu).toContain('oor:name="DisableMacrosExecution"');
    expect(xcu).toContain('oor:name="BlockUntrustedRefererLinks"');
    // Linked content is never updated on load. The enum value differs per
    // module (Writer 2=Never, Calc 1=Never — LibreOffice's own schema), so
    // both are asserted with their exact value.
    expect(xcu).toContain('oor:path="/org.openoffice.Office.Writer/Content/Update"');
    expect(xcu).toContain('oor:path="/org.openoffice.Office.Calc/Content/Update"');
    // `fuse` merges with factory defaults instead of replacing the node.
    expect(xcu).toContain('oor:op="fuse"');
  });
});

describe("convertToPdf hardening", () => {
  it("installs the hardened profile in the private UserInstallation dir", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "lo-convert-"));
    const stubPath = join(workDir, "fake-lo");
    // A stub converter: records its arguments, writes a minimal PDF to the
    // directory named by --outdir, and exits 0 — the same success-without-
    // guarantees contract the real binary has.
    await writeFile(
      stubPath,
      [
        "#!/bin/sh",
        'outdir=""; profile=""',
        'for arg in "$@"; do',
        '  case "$prev" in --outdir) outdir="$arg" ;;',
        '  esac',
        '  case "$arg" in -env:UserInstallation=file://*)',
        '    profile="$(echo "$arg" | sed "s|^-env:UserInstallation=file://||")" ;;',
        "  esac",
        '  prev="$arg"',
        "done",
        'printf "%%PDF-1.4 stub\\n" > "$outdir/source.pdf"',
        'printf "%s\\n" "$profile" > "$outdir/profile.txt"',
        "exit 0",
      ].join("\n"),
      "utf8",
    );
    await chmod(stubPath, 0o755);

    const pdfPath = await convertToPdf(
      { buffer: new Uint8Array([0x50, 0x4b, 0x03, 0x04]), extension: ".docx" },
      { binary: stubPath, workDir },
    );
    expect(pdfPath.endsWith(".pdf")).toBe(true);

    // The profile LibreOffice was pointed at carries the hardening file.
    const profileDir = (await readFile(join(workDir, "office-out", "profile.txt"), "utf8")).trim();
    const xcu = await readFile(join(profileDir, "user", "registrymodifications.xcu"), "utf8");
    expect(xcu).toContain('oor:name="DisableMacrosExecution"');
  });
});

/**
 * Reference neutralisation (requirement 5.7): every input below was a proven
 * bypass of the old regex rewriter — the tag regex ended at the first `>`, so
 * a quoted `>` or a `/` attribute separator left the URL outside the match,
 * and the CSS scan ran before escapes and character references were resolved.
 * Each vector asserts the URL is gone from the output.
 */
describe("neutralizeHtmlReferences bypasses", () => {
  const clean = (page: string): string =>
    Buffer.from(neutralizeHtmlReferences(Buffer.from(page, "utf8"))).toString("utf8");

  it("does not end a tag at a '>' inside a quoted attribute value", () => {
    const out = clean('<p>x</p><img alt=">" src="http://10.0.0.1/x.png"><span>y</span>');
    expect(out).not.toContain("10.0.0.1");
    expect(out).not.toMatch(/\bsrc=/i);
    expect(out).toContain("<p>x</p>");
    expect(out).toContain("<span>y</span>");
  });

  it("treats '/' as an attribute separator, not the end of the tag", () => {
    const out = clean('<img/src="http://10.0.0.1/y.png"><img/src=http://10.0.0.1/z.png>');
    expect(out).not.toContain("10.0.0.1");
  });

  it("resolves CSS escape sequences before scanning for url(", () => {
    // `\72` is `r`, so this is `url(http://evil/x)` to the CSS parser.
    const out = clean('<p style="background: u\\72l(http://evil.example/x)">t</p>');
    expect(out).not.toContain("evil.example");
    expect(out).toContain(">t</p>");
  });

  it("resolves HTML character references in a style attribute", () => {
    // `&#40;`/`&#41;` are the parentheses of url(…).
    const out = clean('<p style="background: url&#40;http://evil.example/a&#41;">t</p>');
    expect(out).not.toContain("evil.example");
  });

  it("drops <link> and <base> even with a slash separator", () => {
    const out = clean('<link/href="http://evil.example/a.css"><base/href=http://evil/><p>t</p>');
    expect(out).not.toContain("evil.example");
    expect(out).not.toMatch(/<(link|base)\b/i);
    expect(out).toContain("<p>t</p>");
  });

  it("skips a raw-text element body without re-parsing it", () => {
    // The `</div>` and the <img> inside the script are JavaScript, not markup;
    // the whole element must vanish, smuggled tag included.
    const out = clean('<div>a</div><script>var s = "</div><img src=\\"http://evil/x\\">";</script><p>b</p>');
    expect(out).not.toContain("evil");
    expect(out).not.toMatch(/<script|<img/i);
    expect(out).toContain("<div>a</div>");
    expect(out).toContain("<p>b</p>");
  });

  it("cannot be closed out of a <style> body by a CSS escape", () => {
    // `\3c` decodes to `<`; an unescaped `</style` in the kept CSS would end
    // the element early and hand the smuggled tag to the renderer.
    const out = clean('<style>a{content:"\\3c /style><img src=http://evil/x>"}</style><p>t</p>');
    expect((out.match(/<\/style>/g) ?? []).length).toBe(1);
    expect(out).not.toMatch(/<img/i);
    expect(out).toContain("<p>t</p>");
  });

  it("drops a srcset whose candidates are not all inline images", () => {
    const out = clean('<img srcset="data:image/png;base64,AAA 1x, http://evil/b.png 2x">');
    expect(out).not.toContain("evil");
    expect(out).not.toMatch(/srcset/i);
  });

  it("keeps text, link targets, inline images and plain CSS", () => {
    const out = clean(
      '<p style="color: red">Grüße</p><a href="https://example.com/doc">Link</a>' +
        '<img src="data:image/png;base64,iVBOR" srcset="data:image/png;base64,AAA 2x">',
    );
    expect(out).toContain("Grüße");
    expect(out).toContain('<a href="https://example.com/doc">Link</a>');
    expect(out).toContain('src="data:image/png;base64,iVBOR"');
    expect(out).toContain("color: red");
  });

  it("keeps a stray '<' in text verbatim", () => {
    expect(clean("<p>if (a < b && c > d) x</p>")).toContain("if (a < b && c > d) x");
  });
});

/**
 * Second-round bypasses (P0-10 follow-up): the tokenizer fixed the structural
 * mistakes of the regex rewriter, but passed anything it did not model. Each
 * case below is one of those, asserted against the exact output.
 */
describe("neutralizeHtmlReferences · hardening beyond the tokenizer", () => {
  const clean = (page: string): string =>
    Buffer.from(neutralizeHtmlReferences(Buffer.from(page, "utf8"))).toString("utf8");

  it("re-emits a doctype as the bare <!DOCTYPE html>: no internal subset, no external id", () => {
    const xxe = clean(
      '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><p>t</p>',
    );
    expect(xxe).not.toContain("passwd");
    expect(xxe).not.toContain("ENTITY");
    expect(xxe.startsWith("<!DOCTYPE html>")).toBe(true);
    const legacy = clean(
      '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><p>t</p>',
    );
    expect(legacy).not.toContain("w3.org");
    expect(legacy).toBe("<!DOCTYPE html><p>t</p>");
  });

  it("drops an SVG data: image (a nested document can reference files), keeps rasters", () => {
    const svg = clean(
      "<img src=\"data:image/svg+xml,<svg><image href='file:///etc/passwd'/></svg>\">",
    );
    expect(svg).not.toContain("passwd");
    expect(svg).not.toMatch(/\bsrc=/i);
    for (const type of ["png", "jpeg", "jpg", "gif", "webp", "bmp"]) {
      const raster = clean(`<img src="data:image/${type};base64,AAAA">`);
      expect(raster).toContain(`src="data:image/${type};base64,AAAA"`);
    }
  });

  it("also refuses a data: SVG inside CSS url()", () => {
    const out = clean(
      '<p style="background:url(data:image/svg+xml;base64,PHN2Zz4=)">t</p><style>p{background:url("data:image/svg+xml,x")}</style>',
    );
    expect(out).not.toContain("svg");
    expect(out).toContain("none");
  });

  it("keeps a raster data: url() in CSS", () => {
    const out = clean('<p style="background:url(data:image/png;base64,AAAA)">t</p>');
    expect(out).toContain("data:image/png;base64,AAAA");
  });

  it.each([
    ["image-set with a string", "background:image-set('http://evil.example/x' 1x)"],
    ["image-set with url()", "background:image-set(url(http://evil.example/x) 1x)"],
    ["-webkit-image-set", "background:-webkit-image-set('http://evil.example/x' 1x)"],
    ["src()", "background:src('http://evil.example/x')"],
    ["image()", "background:image('http://evil.example/x')"],
    ["cross-fade()", "background:cross-fade(url(http://evil.example/a), url(http://evil.example/b), 50%)"],
    ["element()", "background:element(#a, 'http://evil.example/x')"],
    ["escaped function name", "background:\\69mage-set('http://evil.example/x' 1x)"],
    ["comment-split function name", "background:image-set/**/('http://evil.example/x' 1x)"],
    ["quoted paren inside the call", "background:image-set('http://evil.example/x)y' 1x)"],
  ])("removes the URL-loading CSS function: %s", (_label, css) => {
    const attr = clean(`<p style="${css}">t</p>`);
    expect(attr).not.toContain("evil.example");
    const sheet = clean(`<style>p{${css}}</style><p>t</p>`);
    expect(sheet).not.toContain("evil.example");
    expect(sheet).toContain("<p>t</p>");
  });

  it("does not damage ordinary CSS that merely contains those words", () => {
    const out = clean(
      '<p style="background-image:none;list-style-image:none;font-family:source sans">t</p>',
    );
    expect(out).toContain("background-image:none");
    expect(out).toContain("list-style-image:none");
    expect(out).toContain("source sans");
  });

  it("drops an element whose tag name contains punctuation", () => {
    const out = clean('<p>a</p><img"src=http://evil.example/x.png><p>b</p>');
    expect(out).not.toContain("evil.example");
    expect(out).toContain("<p>a</p>");
    expect(out).toContain("<p>b</p>");
  });

  it("drops an attribute whose name contains a quote, with its value", () => {
    const out = clean('<img a"src="http://evil.example/x.png" alt="ok">');
    expect(out).not.toContain("evil.example");
    expect(out).toContain('alt="ok"');
  });

  it("drops an end tag whose name is not a plain element name", () => {
    const out = clean('<p>a</p"><b>x</b>');
    expect(out).not.toContain('"');
    expect(out).toContain("<b>x</b>");
  });

  it.each(["\u00a0", "\u0085", "\u000b", "\u0001"])(
    "splits tokens at the non-HTML separator U+%s instead of gluing them",
    (sep) => {
      const out = clean(`<img${sep}src=http://evil.example/x.png alt=ok>`);
      expect(out).not.toContain("evil.example");
    },
  );

  it("escapes < and > inside kept attribute values", () => {
    const out = clean('<a href="https://example.com/?q=<b>x</b>" title="a>b">l</a>');
    expect(out).not.toMatch(/href="[^"]*[<>]/);
    expect(out).toContain("&lt;b&gt;");
    expect(out).toContain('title="a&gt;b"');
  });

  it("neutralises an unterminated comment and CDATA/bogus-comment openers", () => {
    for (const page of [
      '<!--><img src="http://evil.example/a"><p>t</p>',
      '<!---><img src="http://evil.example/a"><p>t</p>',
      '<![CDATA[<img src="http://evil.example/a">]]><p>t</p>',
      '<!--a--!><img src="http://evil.example/a"><p>t</p>',
    ]) {
      expect(clean(page)).not.toContain("evil.example");
    }
  });

  it("does not parse markup inside RCDATA elements as a tag it keeps unchecked", () => {
    const out = clean(
      '<title><img src="http://evil.example/a"></title><textarea><img src="http://evil.example/b"></textarea><p>t</p>',
    );
    expect(out).not.toContain("evil.example");
  });

  it("resolves a numeric reference without a trailing semicolon in a style attribute", () => {
    // The ampersand is re-encoded, so an undecoded reference reaches the CSS
    // parser as inert text (`url&#40http…`) instead of `url(http…`.
    const out = clean('<p style="background: url&#40http://evil.example/a&#41">t</p>');
    expect(out).not.toMatch(/url\(/i);
  });

  it("is idempotent: sanitizing the output again changes nothing", () => {
    const page =
      '<!DOCTYPE html><p style="color:red">Hallo</p><a href="https://example.com/">x</a>' +
      '<img src="data:image/png;base64,AAAA"><style>p{color:blue}</style>';
    const once = clean(page);
    expect(clean(once)).toBe(once);
  });
});

/**
 * The converter must write the SANITIZED bytes for an HTML source, and the
 * original bytes for everything else. Stub binary: it copies its input file to
 * the output directory so the test can compare exactly what LibreOffice would
 * have been handed.
 */
describe("convertToPdf · HTML input is sanitized before the binary sees it", () => {
  async function runWithStub(
    extension: string,
    bytes: Uint8Array,
  ): Promise<{ seen: Buffer; workDir: string }> {
    const workDir = await mkdtemp(join(tmpdir(), "lo-html-"));
    const stubPath = join(workDir, "fake-lo");
    await writeFile(
      stubPath,
      [
        "#!/bin/sh",
        'outdir=""; last=""',
        'for arg in "$@"; do',
        '  case "$prev" in --outdir) outdir="$arg" ;;',
        "  esac",
        '  prev="$arg"; last="$arg"',
        "done",
        'printf "%%PDF-1.4 stub\n" > "$outdir/source.pdf"',
        'cp "$last" "$outdir/seen-input.bin"',
        "exit 0",
      ].join("\n"),
      "utf8",
    );
    await chmod(stubPath, 0o755);
    await convertToPdf(
      { buffer: bytes, extension },
      { binary: stubPath, workDir },
    );
    return {
      seen: await readFile(join(workDir, "office-out", "seen-input.bin")),
      workDir,
    };
  }

  const PAGE =
    '<p>keep</p><img src="http://10.0.0.1/x.png"><script>x()</script><link href="file:///etc/passwd">';

  it.each([".html", ".htm"])("hands LibreOffice the sanitized bytes for %s", async (ext) => {
    const { seen } = await runWithStub(ext, Buffer.from(PAGE, "utf8"));
    const text = seen.toString("utf8");
    expect(text).toContain("<p>keep</p>");
    expect(text).not.toContain("10.0.0.1");
    expect(text).not.toContain("passwd");
    expect(text).not.toMatch(/<script|<link/i);
  });

  it("does not rewrite a non-HTML source", async () => {
    const original = Buffer.from(PAGE, "utf8");
    const { seen } = await runWithStub(".docx", original);
    expect(seen.equals(original)).toBe(true);
  });
});

describe("probeLibreOfficeIdentity", () => {
  async function stub(body: string): Promise<{ bin: string; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), "lo-version-"));
    const bin = join(dir, "soffice");
    await writeFile(bin, `#!/bin/sh\n${body}\n`, "utf8");
    await chmod(bin, 0o755);
    return { bin, dir };
  }

  it("returns the trimmed version line", async () => {
    const { bin, dir } = await stub('echo "  LibreOffice 24.8.1.2 abcdef  "');
    expect(await probeLibreOfficeIdentity(bin, dir, { timeoutMs: 5000 })).toBe(
      "LibreOffice 24.8.1.2 abcdef",
    );
  });

  it("is null when the binary fails, answers nothing, or does not exist", async () => {
    const failing = await stub("exit 1");
    const silent = await stub("exit 0");
    expect(await probeLibreOfficeIdentity(failing.bin, failing.dir, { timeoutMs: 5000 })).toBeNull();
    expect(await probeLibreOfficeIdentity(silent.bin, silent.dir, { timeoutMs: 5000 })).toBeNull();
    expect(
      await probeLibreOfficeIdentity(join(silent.dir, "missing"), silent.dir, { timeoutMs: 5000 }),
    ).toBeNull();
  });
});
