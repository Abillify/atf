// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deliverCallback,
  isHostAllowed,
  resolveCallbackUrl,
  type CallbackConfig,
} from "../src/handlers/callback.js";
import { testLogger } from "./helpers.js";

const OPEN: CallbackConfig = {
  callbackMaxRetries: 0,
  callbackTimeoutMs: 1_000,
  callbackAllowedHosts: [],
};

const RESTRICTED: CallbackConfig = {
  ...OPEN,
  callbackAllowedHosts: ["orchestrator.internal", ".svc.cluster.local"],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveCallbackUrl", () => {
  it("accepts a plain http(s) URL when no allow-list is set", () => {
    expect(resolveCallbackUrl("https://hooks.example/done", OPEN).toString()).toBe(
      "https://hooks.example/done",
    );
  });

  it("rejects a non-absolute URL", () => {
    expect(() => resolveCallbackUrl("/done", OPEN)).toThrow(/absolute http\(s\) URL/);
  });

  it("rejects a non-http scheme", () => {
    // file:, gopher: and data: are all reachable from a URL parser and none is a
    // callback.
    expect(() => resolveCallbackUrl("file:///etc/passwd", OPEN)).toThrow(/must use http or https/);
    expect(() => resolveCallbackUrl("gopher://x/", OPEN)).toThrow(/must use http or https/);
  });

  it("rejects credentials embedded in the URL", () => {
    expect(() => resolveCallbackUrl("https://user:pass@hooks.example/", OPEN)).toThrow(
      /must not contain credentials/,
    );
  });

  describe("link-local and metadata addresses are always refused", () => {
    // The only thing at 169.254.169.254 is cloud instance credentials.
    it.each([
      "http://169.254.169.254/latest/meta-data/",
      "http://169.254.170.2/v2/credentials",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://[fe80::1]/",
    ])("refuses %s even with an open allow-list", (url) => {
      expect(() => resolveCallbackUrl(url, OPEN)).toThrow(/link-local or metadata address/);
    });
  });

  describe("allow-list", () => {
    it("permits an exact host", () => {
      expect(resolveCallbackUrl("https://orchestrator.internal/hook", RESTRICTED).hostname).toBe(
        "orchestrator.internal",
      );
    });

    it("permits a subdomain via a leading-dot entry", () => {
      expect(
        resolveCallbackUrl("http://runner.default.svc.cluster.local:8080/hook", RESTRICTED).hostname,
      ).toBe("runner.default.svc.cluster.local");
    });

    it("refuses anything else", () => {
      expect(() => resolveCallbackUrl("https://attacker.example/hook", RESTRICTED)).toThrow(
        /not in CALLBACK_ALLOWED_HOSTS/,
      );
    });

    it("is case-insensitive", () => {
      expect(
        resolveCallbackUrl("https://Orchestrator.Internal/hook", RESTRICTED).hostname,
      ).toBeTruthy();
    });

    it("does not let a suffix entry match a lookalike host", () => {
      // ".svc.cluster.local" must not match "evilsvc.cluster.local".
      expect(isHostAllowed("evilsvc.cluster.local", [".svc.cluster.local"])).toBe(false);
      expect(isHostAllowed("a.svc.cluster.local", [".svc.cluster.local"])).toBe(true);
    });

    it("ignores empty entries", () => {
      expect(isHostAllowed("anything", ["", "  "])).toBe(false);
    });
  });
});

describe("deliverCallback", () => {
  const url = new URL("https://hooks.example/done");

  it("posts the payload with the job id", async () => {
    // A fresh Response per call: a Response body can only be read once, so a
    // shared instance makes the second attempt fail for the wrong reason. The
    // parameters are typed so `mock.calls` keeps its tuple shape.
    const fetchMock = vi.fn(
      async (_url: URL, _init: RequestInit) => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await deliverCallback({
      url,
      jobId: "job-1",
      body: { status: "completed" },
      config: OPEN,
      logger: testLogger,
    });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init).toBeDefined();
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string> | undefined)?.["x-job-id"]).toBe("job-1");
    expect(JSON.parse(String(init?.body))).toEqual({ status: "completed" });
  });

  it("refuses to follow a redirect", async () => {
    // Following one would let the caller bounce the request somewhere the
    // allow-list never approved.
    const fetchMock = vi.fn(
      async (_url: URL, _init: RequestInit) => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await deliverCallback({ url, jobId: "j", body: {}, config: OPEN, logger: testLogger });
    expect(fetchMock.mock.calls[0]?.[1].redirect).toBe("manual");
  });

  it("does not retry a 4xx", async () => {
    // The receiver understood and refused; repeating wastes the budget.
    const fetchMock = vi.fn(async () => new Response("no", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await deliverCallback({
      url,
      jobId: "j",
      body: {},
      config: { ...OPEN, callbackMaxRetries: 3 },
      logger: testLogger,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx up to the configured budget", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await deliverCallback({
      url,
      jobId: "j",
      body: {},
      config: { ...OPEN, callbackMaxRetries: 2 },
      logger: testLogger,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops retrying once delivery succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await deliverCallback({
      url,
      jobId: "j",
      body: {},
      config: { ...OPEN, callbackMaxRetries: 3 },
      logger: testLogger,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never throws, because there is nobody left to tell", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ENOTFOUND")));
    await expect(
      deliverCallback({ url, jobId: "j", body: {}, config: OPEN, logger: testLogger }),
    ).resolves.toBeUndefined();
  });
});
