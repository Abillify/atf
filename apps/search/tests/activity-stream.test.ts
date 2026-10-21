// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tenant isolation of the activity stream (`/activity/stream`).
 *
 * Pins the three required visibility cases — a tenant-scoped subscriber sees
 * its own events, does not see another tenant's events, and an operator or
 * service subscriber sees everything — for both the live subscription and the
 * `Last-Event-ID` replay path, plus the `filterKeys` minimisation of search
 * activity details.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import {
  emitActivity,
  type ActivityEvent,
} from "../src/activity-emitter.js";
import {
  activityVisibleTo,
  activityViewerFromPrincipal,
  createActivityStreamHandler,
  newActivityId,
} from "../src/handlers/activity-stream.js";
import { buildSearchDetail } from "../src/handlers/search.js";
import { setPrincipal, type RequestPrincipal } from "../src/request-principal.js";
import type { SearchResult } from "../src/postgres-client.js";

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: newActivityId(),
    type: "search",
    status: "ok",
    summary: "test event",
    timestamp: new Date().toISOString(),
    duration_ms: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// activityVisibleTo — pure visibility rule
// ---------------------------------------------------------------------------

describe("activityVisibleTo", () => {
  it("shows an event to a subscriber of the same tenant", () => {
    const ev = event({ tenantId: "acme" });
    expect(activityVisibleTo(ev, { tenantId: "acme" })).toBe(true);
  });

  it("hides an event from a subscriber of another tenant", () => {
    const ev = event({ tenantId: "acme" });
    expect(activityVisibleTo(ev, { tenantId: "other" })).toBe(false);
  });

  it("shows every event to an operator or service viewer", () => {
    const viewer = { tenantId: "acme", operator: true };
    expect(activityVisibleTo(event({ tenantId: "acme" }), viewer)).toBe(true);
    expect(activityVisibleTo(event({ tenantId: "other" }), viewer)).toBe(true);
    expect(activityVisibleTo(event(), viewer)).toBe(true);
    expect(
      activityVisibleTo(event({ tenantId: "other" }), { service: true }),
    ).toBe(true);
  });

  it("withholds tenant-less events from a tenant-scoped viewer (fail-closed)", () => {
    expect(activityVisibleTo(event(), { tenantId: "acme" })).toBe(false);
  });
});

describe("activityViewerFromPrincipal", () => {
  it("maps a session principal to a tenant viewer", () => {
    const principal: RequestPrincipal = {
      userId: "jane",
      userGroups: undefined,
      tenantId: "acme",
      scopes: [],
      source: "session",
    };
    expect(activityViewerFromPrincipal(principal)).toEqual({
      tenantId: "acme",
      operator: false,
      service: false,
      authorizationBypass: false,
    });
  });

  it("maps an operator-scoped principal to an operator viewer", () => {
    const principal: RequestPrincipal = {
      userId: "ops",
      userGroups: undefined,
      tenantId: "acme",
      scopes: ["operator"],
      source: "jwt",
    };
    expect(activityViewerFromPrincipal(principal).operator).toBe(true);
  });

  it("maps a service principal to a service viewer", () => {
    const principal: RequestPrincipal = {
      userId: undefined,
      userGroups: undefined,
      source: "service",
    };
    expect(activityViewerFromPrincipal(principal).service).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end through the SSE handler
// ---------------------------------------------------------------------------

interface StreamFixture {
  frames: string[];
  close: () => void;
}

/** Attach a subscriber with `principal` and collect the SSE frames written. */
function openStream(principal: RequestPrincipal, lastEventId?: string): StreamFixture {
  const req = {
    headers: lastEventId ? { "last-event-id": lastEventId } : {},
    on: (_event: string, cb: () => void) => {
      req["_close"] = cb;
    },
    _close: undefined as (() => void) | undefined,
  } as unknown as Request & { _close?: () => void };
  setPrincipal(req, principal);

  const frames: string[] = [];
  const res = {
    setHeader: () => {},
    flushHeaders: () => {},
    write: (chunk: string) => {
      frames.push(chunk);
      return true;
    },
  } as unknown as Response;

  createActivityStreamHandler()(req, res, () => {});
  return { frames, close: () => req._close?.() };
}

const tenantPrincipal: RequestPrincipal = {
  userId: "viewer",
  userGroups: undefined,
  tenantId: "acme",
  scopes: [],
  source: "session",
};

const operatorPrincipal: RequestPrincipal = {
  userId: "ops",
  userGroups: undefined,
  tenantId: "acme",
  scopes: ["operator"],
  source: "session",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("activity stream live delivery", () => {
  it("delivers own-tenant events to a tenant subscriber", () => {
    const sub = openStream(tenantPrincipal);
    try {
      emitActivity(event({ tenantId: "acme", summary: "mine" }));
      expect(sub.frames.some((f) => f.includes('"summary":"mine"'))).toBe(true);
    } finally {
      sub.close();
    }
  });

  it("does not deliver another tenant's events to a tenant subscriber", () => {
    const sub = openStream(tenantPrincipal);
    try {
      emitActivity(event({ tenantId: "globex", summary: "theirs" }));
      expect(sub.frames.some((f) => f.includes("theirs"))).toBe(false);
    } finally {
      sub.close();
    }
  });

  it("delivers every tenant's events to an operator subscriber", () => {
    const sub = openStream(operatorPrincipal);
    try {
      emitActivity(event({ tenantId: "acme", summary: "mine" }));
      emitActivity(event({ tenantId: "globex", summary: "theirs" }));
      emitActivity(event({ summary: "tenant-less" }));
      expect(sub.frames.some((f) => f.includes("mine"))).toBe(true);
      expect(sub.frames.some((f) => f.includes("theirs"))).toBe(true);
      expect(sub.frames.some((f) => f.includes("tenant-less"))).toBe(true);
    } finally {
      sub.close();
    }
  });
});

describe("activity stream replay (Last-Event-ID)", () => {
  it("replays only visible events for a tenant subscriber", () => {
    // Populate the shared replay buffer before subscribing.
    const own = event({ tenantId: "acme", summary: "replay-mine" });
    emitActivity(event({ tenantId: "globex", summary: "replay-theirs" }));
    emitActivity(own);
    emitActivity(event({ tenantId: "acme", summary: "replay-mine-2" }));

    const sub = openStream(tenantPrincipal, own.id);
    try {
      const replayed = sub.frames.join("");
      expect(replayed).toContain("replay-mine-2");
      expect(replayed).not.toContain("replay-theirs");
    } finally {
      sub.close();
    }
  });

  it("replays all events for an operator subscriber", () => {
    const marker = event({ tenantId: "globex", summary: "replay-op-theirs" });
    emitActivity(marker);
    emitActivity(event({ tenantId: "acme", summary: "replay-op-mine" }));

    const sub = openStream(operatorPrincipal, marker.id);
    try {
      expect(sub.frames.join("")).toContain("replay-op-mine");
    } finally {
      sub.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Search activity detail carries filter names only
// ---------------------------------------------------------------------------

describe("buildSearchDetail", () => {
  const hit: SearchResult = {
    id: "1",
    score: 0.9,
    content: "content",
    created: instant(),
  };

  function instant(): Date {
    return new Date("2026-03-01T00:00:00.000Z");
  }

  it("reports only the names of applied metadata filters", () => {
    const detail = buildSearchDetail({
      results: [hit],
      hybrid: false,
      reranked: false,
      collection: "documents",
      filter: { customer_id: "secret-42", region: "eu" } as never,
    });
    expect(detail["filterKeys"]).toEqual(["customer_id", "region"]);
    expect(detail["filter"]).toBeUndefined();
    expect(JSON.stringify(detail)).not.toContain("secret-42");
  });

  it("omits filterKeys when no filter was applied", () => {
    const detail = buildSearchDetail({
      results: [hit],
      hybrid: false,
      reranked: false,
      collection: "documents",
      filter: {},
    });
    expect(detail["filterKeys"]).toBeUndefined();
  });
});
