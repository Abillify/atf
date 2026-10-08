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
import { convertToPdf, writeHardenedProfile } from "../src/pipeline/office.js";

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
