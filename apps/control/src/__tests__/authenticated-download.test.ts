// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, describe, expect, test, vi } from "vitest";
import { downloadAuthenticated } from "../lib/authenticated-download";

describe("downloadAuthenticated", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("uses a bearer header and sanitizes the response filename", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Blob(["report"]), {
        headers: {
          "Content-Disposition": 'attachment; filename="../report.csv"',
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const createObjectURL = vi.fn().mockReturnValue("blob:test");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    await downloadAuthenticated({
      url: "http://control.test/report.csv",
      token: "secret token",
      fallbackFilename: "fallback.csv",
      accept: "text/csv",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("token=");
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer secret token",
    );
    expect(new Headers(init.headers).get("Accept")).toBe("text/csv");
    expect(click).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
  });

  test("does not create a download for an error response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 403 })),
    );
    const createObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL }));

    await expect(
      downloadAuthenticated({
        url: "http://control.test/report.csv",
        token: "secret",
        fallbackFilename: "report.csv",
      }),
    ).rejects.toThrow("HTTP 403");
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
