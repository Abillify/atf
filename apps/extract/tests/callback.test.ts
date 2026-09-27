// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callbackAddressRefusal,
  deliverCallback,
  isHostAllowed,
  pinnedPostRequest,
  resolveCallbackUrl,
  type CallbackConfig,
  type CallbackRequester,
} from "../src/handlers/callback.js";
import type { HostResolver, ResolvedAddress } from "../src/handlers/source-url.js";
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

describe("resolveCallbackUrl · IP literals", () => {
  it.each(["http://10.0.0.5/hook", "http://127.0.0.1:9000/hook", "http://[::1]/hook", "http://[fd12::1]/"])(
    "refuses the private/loopback literal %s without an allow-list",
    (url) => {
      expect(() => resolveCallbackUrl(url, OPEN)).toThrow(/private, loopback or reserved/);
    },
  );

  it("permits an allow-listed private literal, but never a metadata literal", () => {
    const config = { ...OPEN, callbackAllowedHosts: ["127.0.0.1", "100.100.100.200"] };
    expect(resolveCallbackUrl("http://127.0.0.1:9000/hook", config).hostname).toBe("127.0.0.1");
    expect(() => resolveCallbackUrl("http://100.100.100.200/", config)).toThrow(
      /link-local or metadata address/,
    );
  });

  it("refuses an IPv4-mapped metadata literal", () => {
    // The URL parser serialises it as ::ffff:a9fe:a9fe.
    expect(() => resolveCallbackUrl("http://[::ffff:169.254.169.254]/", OPEN)).toThrow(
      /link-local or metadata address/,
    );
  });
});

describe("callbackAddressRefusal", () => {
  it("accepts public addresses in open mode", () => {
    expect(callbackAddressRefusal(["93.184.216.34", "2606:2800:220:1::1"], OPEN)).toBeNull();
  });

  it("refuses a mixed public/private answer in open mode", () => {
    expect(callbackAddressRefusal(["93.184.216.34", "10.1.2.3"], OPEN)).toMatch(/private/);
  });

  it("lets an allow-listed host resolve to private space but not to metadata", () => {
    expect(callbackAddressRefusal(["10.1.2.3"], RESTRICTED)).toBeNull();
    expect(callbackAddressRefusal(["10.1.2.3", "169.254.169.254"], RESTRICTED)).toMatch(
      /metadata/,
    );
    expect(callbackAddressRefusal(["fd00:ec2::254"], RESTRICTED)).toMatch(/metadata/);
    expect(callbackAddressRefusal(["fe80::1"], RESTRICTED)).toMatch(/metadata/);
  });
});

type RequestCall = Parameters<CallbackRequester>;

/** A requester stub answering with `statuses` in order (last one repeats). */
function stubRequester(statuses: number[]) {
  const calls: RequestCall[] = [];
  const impl = vi.fn(async (...args: RequestCall) => {
    calls.push(args);
    return { status: statuses[Math.min(calls.length - 1, statuses.length - 1)] ?? 204 };
  });
  return { impl, calls };
}

const PUBLIC: HostResolver = async () => [{ address: "93.184.216.34", family: 4 }];

describe("deliverCallback", () => {
  const url = new URL("https://hooks.example/done");

  it("posts the payload with the job id to the pinned address", async () => {
    const { impl, calls } = stubRequester([204]);
    await deliverCallback({
      url,
      jobId: "job-1",
      body: { status: "completed" },
      config: OPEN,
      logger: testLogger,
      resolver: PUBLIC,
      requestImpl: impl,
    });
    const [calledUrl, pinned, init] = calls[0] ?? [];
    expect(calledUrl?.toString()).toBe("https://hooks.example/done");
    expect(pinned).toEqual({ address: "93.184.216.34", family: 4 });
    expect(init?.headers["x-job-id"]).toBe("job-1");
    expect(JSON.parse(String(init?.body))).toEqual({ status: "completed" });
  });

  it("treats a redirect as a refusal and does not follow it", async () => {
    // Following one would let the caller bounce the request somewhere the
    // allow-list never approved.
    const { impl } = stubRequester([302]);
    await deliverCallback({
      url,
      jobId: "j",
      body: {},
      config: { ...OPEN, callbackMaxRetries: 3 },
      logger: testLogger,
      resolver: PUBLIC,
      requestImpl: impl,
    });
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 4xx", async () => {
    // The receiver understood and refused; repeating wastes the budget.
    const { impl } = stubRequester([404]);
    await deliverCallback({
      url,
      jobId: "j",
      body: {},
      config: { ...OPEN, callbackMaxRetries: 3 },
      logger: testLogger,
      resolver: PUBLIC,
      requestImpl: impl,
    });
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx up to the configured budget", async () => {
    const { impl } = stubRequester([500]);
    await deliverCallback({
      url,
      jobId: "j",
      body: {},
      config: { ...OPEN, callbackMaxRetries: 2 },
      logger: testLogger,
      resolver: PUBLIC,
      requestImpl: impl,
    });
    expect(impl).toHaveBeenCalledTimes(3);
  });

  it("stops retrying once delivery succeeds", async () => {
    const { impl } = stubRequester([500, 200]);
    await deliverCallback({
      url,
      jobId: "j",
      body: {},
      config: { ...OPEN, callbackMaxRetries: 3 },
      logger: testLogger,
      resolver: PUBLIC,
      requestImpl: impl,
    });
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it("bounds a callback attempt when the receiver never responds", async () => {
    const impl = vi.fn(
      (_url: URL, _pinned: ResolvedAddress, init: { signal: AbortSignal }) =>
        new Promise<{ status: number }>((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    await expect(
      deliverCallback({
        url,
        jobId: "j",
        body: {},
        config: { ...OPEN, callbackTimeoutMs: 1 },
        logger: testLogger,
        resolver: PUBLIC,
        requestImpl: impl,
      }),
    ).resolves.toBeUndefined();
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("never throws, because there is nobody left to tell", async () => {
    const impl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(
      deliverCallback({
        url,
        jobId: "j",
        body: {},
        config: OPEN,
        logger: testLogger,
        resolver: PUBLIC,
        requestImpl: impl,
      }),
    ).resolves.toBeUndefined();
  });

  it("retries a DNS failure like a network failure", async () => {
    const resolver = vi
      .fn<HostResolver>()
      .mockRejectedValueOnce(new Error("ENOTFOUND"))
      .mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const { impl } = stubRequester([204]);
    await deliverCallback({
      url,
      jobId: "j",
      body: {},
      config: { ...OPEN, callbackMaxRetries: 1 },
      logger: testLogger,
      resolver,
      requestImpl: impl,
    });
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("never connects when the host resolves to a private address (open mode, no retry)", async () => {
    // DNS rebinding / internal name: the literal check passed, the resolved
    // address must still be public.
    const resolver = vi.fn<HostResolver>(async () => [{ address: "10.0.0.7", family: 4 }]);
    const { impl } = stubRequester([204]);
    await deliverCallback({
      url,
      jobId: "j",
      body: {},
      config: { ...OPEN, callbackMaxRetries: 3 },
      logger: testLogger,
      resolver,
      requestImpl: impl,
    });
    expect(impl).not.toHaveBeenCalled();
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("never connects when an allow-listed host resolves to a metadata address", async () => {
    const resolver: HostResolver = async () => [{ address: "169.254.169.254", family: 4 }];
    const { impl } = stubRequester([204]);
    await deliverCallback({
      url: new URL("https://orchestrator.internal/hook"),
      jobId: "j",
      body: {},
      config: RESTRICTED,
      logger: testLogger,
      resolver,
      requestImpl: impl,
    });
    expect(impl).not.toHaveBeenCalled();
  });

  it("delivers to an allow-listed internal host resolving to private space", async () => {
    const resolver: HostResolver = async () => [{ address: "10.0.0.7", family: 4 }];
    const { impl, calls } = stubRequester([204]);
    await deliverCallback({
      url: new URL("https://orchestrator.internal/hook"),
      jobId: "j",
      body: {},
      config: RESTRICTED,
      logger: testLogger,
      resolver,
      requestImpl: impl,
    });
    expect(calls[0]?.[1]).toEqual({ address: "10.0.0.7", family: 4 });
  });
});

describe("pinnedPostRequest", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it("connects to the pinned address, never re-resolving the host name", async () => {
    const received: Array<{ host?: string; body: string; method?: string }> = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push({ host: req.headers.host, body: Buffer.concat(chunks).toString(), method: req.method });
        res.statusCode = 204;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    // `.invalid` never resolves (RFC 6761); reaching the server proves the
    // socket used the pinned address and the Host header kept the name.
    const response = await pinnedPostRequest(
      new URL(`http://pinned.invalid:${port}/hook`),
      { address: "127.0.0.1", family: 4 },
      { headers: { "content-type": "application/json" }, body: '{"ok":true}', signal: new AbortController().signal },
    );
    expect(response.status).toBe(204);
    expect(received).toEqual([{ host: `pinned.invalid:${port}`, body: '{"ok":true}', method: "POST" }]);
  });
});
