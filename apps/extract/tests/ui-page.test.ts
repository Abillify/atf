// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * ui-page.test.ts
 *
 * Smoke tests for the hand-written operator console. The page has no build
 * step, so there is nothing to bundle-test; instead we assert the HTML string
 * carries the structure and the accessibility affordances the tabs depend on.
 *
 * The Jobs tab (task 4.5, requirement 18.6) is the focus: it must appear only
 * when the v2 job store is configured, render an accessible tab/panel pair, and
 * expose the live region and progressbar/keyboard affordances the client script
 * populates.
 */

import { describe, expect, it } from "vitest";
import { getUiPageHtml, type UiPageOptions } from "../src/ui-page.js";

function render(overrides: Partial<UiPageOptions> = {}): string {
  return getUiPageHtml({
    logoutPath: null,
    ingestEnabled: true,
    jobsEnabled: true,
    defaultCollection: "documents",
    maxUploadBytes: 50 * 1024 * 1024,
    ...overrides,
  });
}

describe("getUiPageHtml · Jobs tab", () => {
  it("renders the Jobs tab and panel when jobs are enabled", () => {
    const html = render({ jobsEnabled: true });
    // The tab button carries the tab role and links to its panel.
    expect(html).toContain('data-tab="jobs"');
    expect(html).toContain('id="tab-jobs"');
    expect(html).toContain('aria-controls="panel-jobs"');
    // The panel exists and is labelled by its tab.
    expect(html).toContain('id="panel-jobs"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-labelledby="tab-jobs"');
  });

  it("omits the Jobs tab and panel when jobs are disabled", () => {
    const html = render({ jobsEnabled: false });
    expect(html).not.toContain('data-tab="jobs"');
    expect(html).not.toContain('id="panel-jobs"');
  });

  it("exposes the accessibility affordances the tab depends on", () => {
    const html = render({ jobsEnabled: true });
    // A polite live region for action results.
    expect(html).toContain('id="jobs-live"');
    expect(html).toContain('aria-live="polite"');
    // The tab bar declares itself a tablist and the tab is a real tab.
    expect(html).toContain('role="tablist"');
    // The refresh + load-more controls are present for pagination.
    expect(html).toContain('id="jobs-refresh-btn"');
    expect(html).toContain('id="jobs-more-btn"');
    // The client script wires the /ui/jobs cookie-authenticated path and
    // renders accessible progress bars for the per-stage detail.
    expect(html).toContain('/ui/jobs');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow');
  });

  it("still renders the convert and health tabs", () => {
    const html = render({ jobsEnabled: false });
    expect(html).toContain('data-tab="convert"');
    expect(html).toContain('data-tab="health"');
  });
});

describe("getUiPageHtml · Document Intelligence v2", () => {
  it("renders the new-job tab and panel only with the v2 job store", () => {
    const on = render({ jobsEnabled: true });
    expect(on).toContain('data-tab="newjob"');
    expect(on).toContain('id="panel-newjob"');
    expect(on).toContain('aria-labelledby="tab-newjob"');
    const off = render({ jobsEnabled: false });
    expect(off).not.toContain('data-tab="newjob"');
    expect(off).not.toContain('id="panel-newjob"');
  });

  it("exposes every source kind and the job request options", () => {
    const html = render({ jobsEnabled: true });
    for (const id of [
      "newjob-dropzone",
      "newjob-source-url",
      "newjob-sha",
      "newjob-pages",
      "newjob-visibility",
      "newjob-resume-policy",
      "newjob-token-budget",
      "newjob-priority",
      "newjob-callback-url",
      "newjob-dedup",
      "newjob-source-modified",
      "newjob-allowed-groups",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    // The client drives the cookie BFF for uploads, jobs and the preview.
    expect(html).toContain('"/ui/uploads"');
    expect(html).toContain('"/ui/render"');
    expect(html).toContain("x-chunk-checksum-sha256");
  });

  it("shows the v2 identity headers on the ingest tab only on the v2 path", () => {
    const v2 = render({ jobsEnabled: true });
    expect(v2).toContain('id="ingest-dedup"');
    expect(v2).toContain('id="ingest-source-modified"');
    const v1 = render({ jobsEnabled: false });
    expect(v1).not.toContain('id="ingest-dedup"');
    expect(v1).not.toContain('id="ingest-source-modified"');
  });

  it("offers reparse, resume-with-policy and the job filter", () => {
    const html = render({ jobsEnabled: true });
    expect(html).toContain('action: "reparse"');
    expect(html).toContain("resumePolicy");
    expect(html).toContain('id="jobs-filter-status"');
    expect(html).toContain('id="jobs-filter-text"');
  });
});
