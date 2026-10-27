// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for the SharePoint/OneDrive adapter (Microsoft Graph).
 *
 * Covered: client-credentials token fetch, site/drive resolution, delta
 * paging and delta-link reuse, the deleted facet, download, permission →
 * ACL mapping (users, group map, link-only), 429/503 retry behaviour and
 * the four-request Graph throttle. All fetches are mocked; tenant and hosts
 * are synthetic.
 */

import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  collectListing,
  createSharepointSource,
  sourceConfigSchema,
  type SourceFetch,
  type SourceItem,
} from "../../index.js";
import { makeHarness } from "../../../tests/fakes/run-harness.js";

const TENANT = "00000000-0000-0000-0000-000000000000";
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const GRAPH = "https://graph.microsoft.com/v1.0";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const noSignal = new AbortController().signal;

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

interface FakeResponse {
  status: number;
  json?: unknown;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
}

type FakeHandler = (
  url: string,
  init: { method?: string; body?: string } | undefined,
) => FakeResponse | Promise<FakeResponse>;

interface FakeCall {
  url: string;
  method: string;
  body?: string;
}

function fakeGraph(handler: FakeHandler): {
  fetchImpl: SourceFetch;
  calls: FakeCall[];
  tokenCalls: number;
} {
  const calls: FakeCall[] = [];
  let tokenCalls = 0;
  const fetchImpl: SourceFetch = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      ...(init?.body !== undefined ? { body: init.body } : {}),
    });
    if (url.includes("/oauth2/v2.0/token")) tokenCalls += 1;
    const reply = await handler(url, init);
    return {
      status: reply.status,
      ok: reply.status >= 200 && reply.status < 300,
      json: async () => reply.json,
      text: async () => "",
      arrayBuffer: async () => {
        const bytes = reply.bytes ?? new Uint8Array();
        return bytes.slice().buffer as ArrayBuffer;
      },
      header: (name: string) => reply.headers?.[name.toLowerCase()],
    };
  };
  return {
    fetchImpl,
    calls,
    get tokenCalls() {
      return tokenCalls;
    },
  };
}

const tokenReply = (expiresIn = 3600): FakeResponse => ({
  status: 200,
  json: { access_token: "tok-1", expires_in: expiresIn },
});

const driveItem = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  id: "item-1",
  name: "a.pdf",
  size: 10,
  lastModifiedDateTime: "2026-10-01T10:00:00Z",
  cTag: "ctag-1",
  eTag: "etag-1",
  file: { size: 10, mimeType: "application/pdf" },
  parentReference: { path: "/drive/root:/Docs" },
  ...over,
});

const baseOptions = {
  id: "sp",
  tenantId: TENANT,
  clientId: "app-client",
  clientSecret: "s3cret",
  driveId: "drive-9",
};

describe("SharePoint client-credentials Token", () => {
  it("POST an Tenant-Endpoint mit scope .default und cached den Token", async () => {
    const graph = fakeGraph((url) => {
      if (url.includes("/oauth2/v2.0/token")) return tokenReply();
      if (url.includes("/root/delta")) {
        return { status: 200, json: { value: [driveItem()], "@odata.deltaLink": `${GRAPH}/x/delta?d=1` } };
      }
      return { status: 404 };
    });
    const adapter = createSharepointSource(baseOptions, { fetchImpl: graph.fetchImpl });
    const result = await collectListing(adapter, noSignal);
    expect(result.kind).toBe("complete");
    const tokenCall = graph.calls.find((c) => c.url === TOKEN_URL);
    expect(tokenCall?.method).toBe("POST");
    expect(tokenCall?.body).toContain("grant_type=client_credentials");
    expect(tokenCall?.body).toContain("client_id=app-client");
    expect(tokenCall?.body).toContain("client_secret=s3cret");
    expect(tokenCall?.body).toContain("scope=https%3A%2F%2Fgraph.microsoft.com%2F.default");
    // Two pages would mean two Graph calls — the token is fetched once.
    expect(graph.tokenCalls).toBe(1);
  });

  it("ablaufender Token wird neu geholt (60-s-Fenster)", async () => {
    let clock = 1_000_000;
    const graph = fakeGraph((url) => {
      if (url.includes("/oauth2/v2.0/token")) return tokenReply(120);
      if (url.includes("/root/delta")) {
        return { status: 200, json: { value: [], "@odata.deltaLink": `${GRAPH}/x/delta?d=1` } };
      }
      return { status: 404 };
    });
    const adapter = createSharepointSource(baseOptions, {
      fetchImpl: graph.fetchImpl,
      now: () => clock,
    });
    await collectListing(adapter, noSignal);
    expect(graph.tokenCalls).toBe(1);
    // Inside the 60 s skew window → refresh on the next call.
    clock += 70_000;
    await collectListing(adapter, noSignal);
    expect(graph.tokenCalls).toBe(2);
  });
});

describe("SharePoint Site-/Drive-Auflösung", () => {
  it("siteUrl + library → Site-ID, dann Bibliothek per name", async () => {
    const graph = fakeGraph((url) => {
      if (url.includes("/oauth2/v2.0/token")) return tokenReply();
      if (url === `${GRAPH}/sites/contoso.example:/sites/team`) {
        return { status: 200, json: { id: "site-1" } };
      }
      if (url === `${GRAPH}/sites/site-1/drives`) {
        return {
          status: 200,
          json: { value: [{ id: "d-other", name: "Other" }, { id: "d-lib", name: "Shared Docs" }] },
        };
      }
      if (url === `${GRAPH}/drives/d-lib/root/delta`) {
        return { status: 200, json: { value: [], "@odata.deltaLink": `${GRAPH}/y/delta?d=1` } };
      }
      return { status: 404 };
    });
    const adapter = createSharepointSource(
      {
        id: "sp",
        tenantId: TENANT,
        clientId: "app-client",
        clientSecret: "s3cret",
        siteUrl: "https://contoso.example/sites/team",
        library: "Shared Docs",
      },
      { fetchImpl: graph.fetchImpl },
    );
    const result = await collectListing(adapter, noSignal);
    expect(result.kind).toBe("complete");
    expect(graph.calls.some((c) => c.url === `${GRAPH}/sites/contoso.example:/sites/team`)).toBe(true);
    expect(graph.calls.some((c) => c.url === `${GRAPH}/drives/d-lib/root/delta`)).toBe(true);
  });

  it("Delta-Link-Wiederverwendung: direkter Aufruf ohne Site-Auflösung", async () => {
    const initial = `${GRAPH}/drives/drive-9/root/delta?token=old`;
    const graph = fakeGraph((url) => {
      if (url.includes("/oauth2/v2.0/token")) return tokenReply();
      if (url === initial) {
        return { status: 200, json: { value: [driveItem()], "@odata.deltaLink": `${GRAPH}/drives/drive-9/root/delta?token=new` } };
      }
      return { status: 404 };
    });
    const adapter = createSharepointSource(
      { ...baseOptions, initialDeltaLink: initial },
      { fetchImpl: graph.fetchImpl },
    );
    const result = await collectListing(adapter, noSignal);
    expect(result.kind).toBe("complete");
    expect(result.kind === "complete" && result.items).toHaveLength(1);
    expect(graph.calls.some((c) => c.url.includes("/sites/"))).toBe(false);
    expect(graph.calls.some((c) => c.url === initial)).toBe(true);
    expect(adapter.deltaLink()).toBe(`${GRAPH}/drives/drive-9/root/delta?token=new`);
  });
});

describe("SharePoint Delta-Listing", () => {
  it("Paging über zwei Seiten, Marker cTag, displayPath ohne root-Präfix", async () => {
    const page1Url = `${GRAPH}/drives/drive-9/root/delta`;
    const page2Url = `${GRAPH}/drives/drive-9/root/delta?token=p2`;
    const graph = fakeGraph((url) => {
      if (url.includes("/oauth2/v2.0/token")) return tokenReply();
      if (url === page1Url) {
        return {
          status: 200,
          json: {
            value: [
              driveItem({ id: "f1", name: "a.pdf" }),
              // Ordner werden übersprungen.
              driveItem({ id: "folder-1", name: "Sub", file: undefined, folder: { childCount: 0 } }),
            ],
            "@odata.nextLink": page2Url,
          },
        };
      }
      if (url === page2Url) {
        return {
          status: 200,
          json: {
            value: [
              driveItem({
                id: "f2",
                name: "b.docx",
                cTag: undefined,
                eTag: "etag-2",
                parentReference: { path: "/drive/root:" },
              }),
            ],
            "@odata.deltaLink": `${GRAPH}/drives/drive-9/root/delta?token=final`,
          },
        };
      }
      return { status: 404 };
    });
    const adapter = createSharepointSource(baseOptions, { fetchImpl: graph.fetchImpl });
    const result = await collectListing(adapter, noSignal);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.items.map((i) => i.quellId)).toEqual(["f1", "f2"]);
    expect(result.items[0]?.marker).toBe("ctag-1");
    expect(result.items[0]?.displayPath).toBe("/Docs/a.pdf");
    // eTag als Fallback, Pfad ohne Präfix → "/b.docx".
    expect(result.items[1]?.marker).toBe("etag-2");
    expect(result.items[1]?.displayPath).toBe("/b.docx");
    expect(adapter.deltaLink()).toBe(`${GRAPH}/drives/drive-9/root/delta?token=final`);
  });

  it("deleted-Facet wird als Tombstone geliefert (Delta enthält nur Änderungen)", async () => {
    const graph = fakeGraph((url) => {
      if (url.includes("/oauth2/v2.0/token")) return tokenReply();
      if (url.includes("/root/delta")) {
        return {
          status: 200,
          json: {
            value: [driveItem({ id: "alive" }), driveItem({ id: "gone", deleted: { state: "deleted" } })],
            "@odata.deltaLink": `${GRAPH}/x/delta?d=1`,
          },
        };
      }
      return { status: 404 };
    });
    const adapter = createSharepointSource(baseOptions, { fetchImpl: graph.fetchImpl });
    const result = await collectListing(adapter, noSignal);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.items.map((i) => [i.quellId, i.removal])).toEqual([
      ["alive", undefined],
      ["gone", "deleted"],
    ]);
  });
  it("meldet ein Listing ab gespeichertem Delta-Link als inkrementell", () => {
    const graph = fakeGraph(() => ({ status: 404 }));
    expect(createSharepointSource(baseOptions, { fetchImpl: graph.fetchImpl }).listingIsIncremental()).toBe(false);
    const incremental = createSharepointSource(
      { ...baseOptions, initialDeltaLink: `${GRAPH}/drives/drive-9/root/delta?token=t` },
      { fetchImpl: graph.fetchImpl },
    );
    expect(incremental.listingIsIncremental()).toBe(true);
  });
});

describe("SharePoint Download", () => {
  it("open lädt /content und folgt Redirects (fetch-Default)", async () => {
    const graph = fakeGraph((url) => {
      if (url.includes("/oauth2/v2.0/token")) return tokenReply();
      if (url === `${GRAPH}/drives/drive-9/items/f1/content`) {
        return { status: 200, bytes: enc("sharepoint-bytes") };
      }
      return { status: 404 };
    });
    const adapter = createSharepointSource(baseOptions, { fetchImpl: graph.fetchImpl });
    const item: SourceItem = {
      quellId: "f1",
      name: "a.pdf",
      size: 16,
      modified: new Date("2026-10-01T10:00:00Z"),
      marker: "ctag-1",
    };
    const content = await readAll(await adapter.open(item, noSignal));
    expect(content).toBe("sharepoint-bytes");
    expect(graph.calls.some((c) => c.url === `${GRAPH}/drives/drive-9/items/f1/content`)).toBe(true);
  });
});

describe("SharePoint Rechte-Mapping (aclFromPermissions)", () => {
  it("Nutzer lowercase, Gruppen über aclGroupMap, nicht gemappte unverändert", async () => {
    const graph = fakeGraph((url) => {
      if (url.includes("/oauth2/v2.0/token")) return tokenReply();
      if (url.includes("/root/delta")) {
        return { status: 200, json: { value: [driveItem({ id: "f1" })], "@odata.deltaLink": `${GRAPH}/x/delta?d=1` } };
      }
      if (url === `${GRAPH}/drives/drive-9/items/f1/permissions`) {
        return {
          status: 200,
          json: {
            value: [
              { grantedToV2: { user: { email: "Alice@Contoso.example" } } },
              { grantedToV2: { user: { userPrincipalName: "Bob@Contoso.example" } } },
              { grantedToV2: { group: { id: "grp-1" } } },
              { grantedToV2: { group: { id: "grp-2" } } },
            ],
          },
        };
      }
      return { status: 404 };
    });
    const adapter = createSharepointSource(
      {
        ...baseOptions,
        aclFromPermissions: true,
        aclGroupMap: { "grp-1": "team-a" },
      },
      { fetchImpl: graph.fetchImpl },
    );
    const result = await collectListing(adapter, noSignal);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.items[0]?.acl).toEqual({
      allowedUsers: ["alice@contoso.example", "bob@contoso.example"],
      allowedGroups: ["team-a", "grp-2"],
    });
  });

  it("nur per Link geteilt → Tombstone access-revoked, Warnung ohne Namen", async () => {
    const warnings: Record<string, unknown>[] = [];
    const graph = fakeGraph((url) => {
      if (url.includes("/oauth2/v2.0/token")) return tokenReply();
      if (url.includes("/root/delta")) {
        return { status: 200, json: { value: [driveItem({ id: "f1" })], "@odata.deltaLink": `${GRAPH}/x/delta?d=1` } };
      }
      if (url.includes("/permissions")) {
        return {
          status: 200,
          json: { value: [{ link: { scope: "anonymous", type: "view" } }] },
        };
      }
      return { status: 404 };
    });
    const adapter = createSharepointSource(
      { ...baseOptions, aclFromPermissions: true },
      { fetchImpl: graph.fetchImpl, logger: { warn: (f) => warnings.push(f) } },
    );
    const result = await collectListing(adapter, noSignal);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.items.map((i) => [i.quellId, i.removal, i.acl])).toEqual([["f1", "access-revoked", undefined]]);
    const skipped = warnings.filter((w) => w["event"] === "sharepoint.item_skipped_no_acl");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ itemId: "f1", reason: "link_only" });
  });

  it("ohne Rechte oder nur nicht abbildbare Identitäten → no_mappable_permissions", async () => {
    const warnings: Record<string, unknown>[] = [];
    const graph = fakeGraph((url) => {
      if (url.includes("/oauth2/v2.0/token")) return tokenReply();
      if (url.includes("/root/delta")) {
        return {
          status: 200,
          json: {
            value: [driveItem({ id: "f1" }), driveItem({ id: "f2" })],
            "@odata.deltaLink": `${GRAPH}/x/delta?d=1`,
          },
        };
      }
      if (url.includes("/items/f1/permissions")) return { status: 200, json: { value: [] } };
      if (url.includes("/items/f2/permissions")) {
        return { status: 200, json: { value: [{ grantedToV2: { siteUser: { loginName: "x" } } }] } };
      }
      return { status: 404 };
    });
    const adapter = createSharepointSource(
      { ...baseOptions, aclFromPermissions: true },
      { fetchImpl: graph.fetchImpl, logger: { warn: (f) => warnings.push(f) } },
    );
    const result = await collectListing(adapter, noSignal);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.items.map((i) => [i.quellId, i.removal])).toEqual([
      ["f1", "access-revoked"],
      ["f2", "access-revoked"],
    ]);
    expect(warnings.map((w) => w["reason"])).toEqual([
      "no_mappable_permissions",
      "no_mappable_permissions",
    ]);
    expect(JSON.stringify(warnings)).not.toContain("loginName");
  });

  it("gemischte Rechte: Link wird ignoriert, abbildbare Nutzer und Gruppen bleiben", async () => {
    const graph = fakeGraph((url) => {
      if (url.includes("/oauth2/v2.0/token")) return tokenReply();
      if (url.includes("/root/delta")) {
        return { status: 200, json: { value: [driveItem({ id: "f1" })], "@odata.deltaLink": `${GRAPH}/x/delta?d=1` } };
      }
      if (url.includes("/permissions")) {
        return {
          status: 200,
          json: {
            value: [
              { link: { scope: "anonymous", type: "view" } },
              { grantedToV2: { user: { email: "Alice@Contoso.example" } } },
            ],
          },
        };
      }
      return { status: 404 };
    });
    const adapter = createSharepointSource(
      { ...baseOptions, aclFromPermissions: true },
      { fetchImpl: graph.fetchImpl },
    );
    const result = await collectListing(adapter, noSignal);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.items[0]?.acl).toEqual({
      allowedUsers: ["alice@contoso.example"],
      allowedGroups: [],
    });
  });

  it("ein zuvor ingestiertes Item, das nur noch per Link geteilt ist, wird gelöscht", async () => {
    const graphWith = (permissions: unknown[]): ReturnType<typeof fakeGraph> =>
      fakeGraph((url) => {
        if (url.includes("/oauth2/v2.0/token")) return tokenReply();
        if (url.includes("/root/delta")) {
          return { status: 200, json: { value: [driveItem({ id: "f1" })], "@odata.deltaLink": `${GRAPH}/x/delta?d=1` } };
        }
        if (url.endsWith("/items/f1/permissions")) return { status: 200, json: { value: permissions } };
        if (url.endsWith("/items/f1/content")) return { status: 200, bytes: enc("sharepoint-bytes") };
        return { status: 404 };
      });
    const config = { mirrorDelete: true, deleteThresholdPercent: 100 };
    const first = await makeHarness({
      items: [],
      config,
      makeAdapter: () =>
        createSharepointSource(
          { ...baseOptions, aclFromPermissions: true },
          { fetchImpl: graphWith([{ grantedToV2: { group: { id: "finance" } } }]).fetchImpl },
        ),
    });
    try {
      await first.run();
      expect(first.fake.ingests[0]?.allowedGroups).toEqual(["finance"]);
      expect(Object.keys(first.store.state.items)).toEqual(["f1"]);
      const second = await makeHarness({
        items: [],
        dir: first.dir,
        config,
        makeAdapter: () =>
          createSharepointSource(
            { ...baseOptions, aclFromPermissions: true },
            { fetchImpl: graphWith([{ link: { scope: "anonymous", type: "view" } }]).fetchImpl },
          ),
      });
      try {
        await second.run();
        expect(second.fake.ingests).toHaveLength(0);
        expect(second.fake.requests.some((r) => r.method === "DELETE")).toBe(true);
        expect(Object.keys(second.store.state.items)).toEqual([]);
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  });

  it("aclFromPermissions=false → keine Permissions-Abfrage", async () => {
    const graph = fakeGraph((url) => {
      if (url.includes("/oauth2/v2.0/token")) return tokenReply();
      if (url.includes("/root/delta")) {
        return { status: 200, json: { value: [driveItem({ id: "f1" })], "@odata.deltaLink": `${GRAPH}/x/delta?d=1` } };
      }
      return { status: 404 };
    });
    const adapter = createSharepointSource(baseOptions, { fetchImpl: graph.fetchImpl });
    const result = await collectListing(adapter, noSignal);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.items[0]?.acl).toBeUndefined();
    expect(graph.calls.some((c) => c.url.includes("/permissions"))).toBe(false);
  });
});

describe("SharePoint 429/503 Backoff", () => {
  it("429 mit Retry-After: wartet die Sekunden und wiederholt", async () => {
    const sleeps: number[] = [];
    let deltaAttempts = 0;
    const graph = fakeGraph((url) => {
      if (url.includes("/oauth2/v2.0/token")) return tokenReply();
      if (url.includes("/root/delta")) {
        deltaAttempts += 1;
        if (deltaAttempts === 1) {
          return { status: 429, headers: { "retry-after": "3" } };
        }
        return { status: 200, json: { value: [], "@odata.deltaLink": `${GRAPH}/x/delta?d=1` } };
      }
      return { status: 404 };
    });
    const adapter = createSharepointSource(baseOptions, {
      fetchImpl: graph.fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const result = await collectListing(adapter, noSignal);
    expect(result.kind).toBe("complete");
    expect(deltaAttempts).toBe(2);
    expect(sleeps).toEqual([3000]);
  });

  it("503 ohne Retry-After: exponentieller Backoff, maximal 5 Versuche", async () => {
    const sleeps: number[] = [];
    let deltaAttempts = 0;
    const graph = fakeGraph((url) => {
      if (url.includes("/oauth2/v2.0/token")) return tokenReply();
      if (url.includes("/root/delta")) {
        deltaAttempts += 1;
        return { status: 503 };
      }
      return { status: 404 };
    });
    const adapter = createSharepointSource(baseOptions, {
      fetchImpl: graph.fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const result = await collectListing(adapter, noSignal);
    expect(result.kind).toBe("incomplete");
    // Erster Versuch + vier Wiederholungen.
    expect(deltaAttempts).toBe(5);
    expect(sleeps).toEqual([500, 1000, 2000, 4000]);
  });
});

describe("SharePoint Graph-Throttling", () => {
  it("höchstens 4 parallele Graph-Anfragen", async () => {
    let active = 0;
    let maxActive = 0;
    const graph = fakeGraph((url) => {
      if (url.includes("/oauth2/v2.0/token")) return tokenReply();
      if (url.includes("/content")) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return new Promise<FakeResponse>((resolve) => {
          setTimeout(() => {
            active -= 1;
            resolve({ status: 200, bytes: enc("x") });
          }, 5);
        });
      }
      return { status: 404 };
    });
    const adapter = createSharepointSource(baseOptions, { fetchImpl: graph.fetchImpl });
    const item = (id: string): SourceItem => ({
      quellId: id,
      name: `${id}.bin`,
      size: 1,
      modified: new Date("2026-10-01T10:00:00Z"),
      marker: "m",
    });
    const opens = Array.from({ length: 6 }, (_, i) =>
      adapter.open(item(`f${i}`), noSignal).then(readAll),
    );
    const contents = await Promise.all(opens);
    expect(contents.every((c) => c === "x")).toBe(true);
    expect(maxActive).toBeLessThanOrEqual(4);
  });
});

describe("SharePoint Config-Schema", () => {
  const base = { id: "sp", tenantId: TENANT, clientId: "app-client" };

  it("geheim: genau eines von clientSecretFile / certificateFile", () => {
    const okSecret = sourceConfigSchema.safeParse({
      ...base,
      type: "sharepoint",
      clientSecretFile: "/run/secrets/sp-secret",
      driveId: "d1",
    });
    expect(okSecret.success).toBe(true);
    const okCert = sourceConfigSchema.safeParse({
      ...base,
      type: "sharepoint",
      certificateFile: "/run/secrets/sp-cert.pem",
      siteUrl: "https://contoso.example/sites/team",
      library: "Docs",
    });
    expect(okCert.success).toBe(true);
    if (okCert.success && okCert.data.type === "sharepoint") {
      expect(okCert.data.aclFromPermissions).toBe(false);
    }

    const both = sourceConfigSchema.safeParse({
      ...base,
      type: "sharepoint",
      clientSecretFile: "/a",
      certificateFile: "/b",
      driveId: "d1",
    });
    expect(both.success).toBe(false);
    const neither = sourceConfigSchema.safeParse({ ...base, type: "sharepoint", driveId: "d1" });
    expect(neither.success).toBe(false);
  });

  it("Ziel: driveId ODER siteUrl + library", () => {
    const both = sourceConfigSchema.safeParse({
      ...base,
      type: "sharepoint",
      clientSecretFile: "/a",
      driveId: "d1",
      siteUrl: "https://contoso.example/sites/team",
      library: "Docs",
    });
    expect(both.success).toBe(false);
    const siteOnly = sourceConfigSchema.safeParse({
      ...base,
      type: "sharepoint",
      clientSecretFile: "/a",
      siteUrl: "https://contoso.example/sites/team",
    });
    expect(siteOnly.success).toBe(false);
    const none = sourceConfigSchema.safeParse({
      ...base,
      type: "sharepoint",
      clientSecretFile: "/a",
    });
    expect(none.success).toBe(false);
  });
});
