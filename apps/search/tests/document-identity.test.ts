// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import {
  documentInfoOf,
  isOlderVersion,
  minhashSimilarity,
  nearDuplicateDecision,
  normalizeMessageId,
  normalizeSubject,
  parseDocumentInfo,
} from "../src/document-identity.js";
import { groupResultsV2 } from "../src/rerank-context.js";
import { rowAclAllows, rowAclForRevision, type AccessScope } from "../src/access-scope.js";
import { groupResultsByDocument } from "../src/handlers/search.js";
import type { SearchResult } from "../src/postgres-client.js";

describe("minhashSimilarity", () => {
  it("is the share of equal slots", () => {
    expect(minhashSimilarity([1, 2, 3, 4], [1, 2, 3, 9])).toBe(0.75);
    expect(minhashSimilarity([], [1])).toBe(0);
  });
});

describe("nearDuplicateDecision", () => {
  const opts = { duplicateSimilarity: 0.97 };

  it("same content version → duplicate, different → new version", () => {
    const v21 = { label: "2.1", source: "page_label" as const };
    const v22 = { label: "2.2", source: "page_label" as const };
    expect(nearDuplicateDecision(0.92, v21, { ...v21 }, opts)).toBe("duplicate");
    expect(nearDuplicateDecision(0.99, v22, v21, opts)).toBe("new_version");
  });

  it("file timestamps never separate two exports of one document", () => {
    const a = { date: "2025-01-01", source: "source_modified" as const };
    const b = { date: "2025-06-01", source: "source_modified" as const };
    expect(nearDuplicateDecision(0.98, a, b, opts)).toBe("duplicate");
    expect(nearDuplicateDecision(0.93, a, b, opts)).toBe("new_version");
  });

  it("unknown versions fall back to the similarity threshold", () => {
    expect(nearDuplicateDecision(0.975, undefined, undefined, opts)).toBe("duplicate");
    expect(nearDuplicateDecision(0.95, undefined, undefined, opts)).toBe("new_version");
  });
});

describe("normalizeSubject", () => {
  it("strips reply/forward prefixes in several languages and list tags", () => {
    expect(normalizeSubject("AW: WG: Re: Angebot  Q3")).toEqual({ norm: "angebot q3", isReply: true });
    expect(normalizeSubject("[team] RE[2]: Status")).toEqual({ norm: "status", isReply: true });
    expect(normalizeSubject("Angebot")).toEqual({ norm: "angebot", isReply: false });
  });
});

describe("normalizeMessageId", () => {
  it("drops angle brackets and whitespace", () => {
    expect(normalizeMessageId(" <abc@x.de> ")).toBe("abc@x.de");
  });
});

describe("document info", () => {
  it("round-trips document.begin fields and ignores junk", () => {
    const info = documentInfoOf({
      title: "T",
      version: { label: "2", source: "explicit" },
      parentReference: "mail/1.eml",
    });
    expect(parseDocumentInfo(JSON.parse(JSON.stringify(info)))).toEqual(info);
    expect(parseDocumentInfo({ version: { source: "explicit" }, email: { messageId: 3 } })).toEqual({});
    expect(documentInfoOf({})).toBeUndefined();
  });

  it("isOlderVersion only for a strictly older, comparable version", () => {
    const v = (label: string) => ({ version: { label, source: "page_label" as const } });
    expect(isOlderVersion(v("1.0"), v("2.0"))).toBe(true);
    expect(isOlderVersion(v("2.0"), v("2.0"))).toBe(false);
    expect(isOlderVersion(v("3.0"), v("2.0"))).toBe(false);
    expect(isOlderVersion({}, v("2.0"))).toBe(false);
  });
});

function hit(reference: string, score: number, content: string, sortAt?: string): SearchResult {
  const now = new Date();
  return {
    id: `${reference}-${score}`,
    score,
    content,
    metadata: {},
    reference: `${reference}#unit:${score}`,
    base_ref: reference,
    created: now,
    modified: now,
    valid_from: null,
    effective_valid_from: now,
    ...(sortAt ? { document_group: { id: "thread:1", kind: "email_thread" as const, sort_at: sortAt } } : {}),
  };
}

describe("grouping by document group", () => {
  const results = [
    hit("mail/b.eml", 0.9, "Antwort B", "2025-01-02T00:00:00.000Z"),
    hit("mail/a.eml", 0.5, "Frage A", "2025-01-01T00:00:00.000Z"),
    hit("doc.pdf", 0.7, "Handbuch"),
  ];

  it("groupByDocument merges a thread into one result, chronologically", () => {
    const grouped = groupResultsByDocument(results);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]?.score).toBe(0.9);
    expect(grouped[0]?.content).toBe("Frage A\n\nAntwort B");
    expect(grouped[0]?.document_group?.id).toBe("thread:1");
  });

  it("group_by=document does the same on /v2/search", () => {
    const grouped = groupResultsV2(results, "document");
    expect(grouped).toHaveLength(2);
    expect(grouped[0]?.content).toBe("Frage A\n\nAntwort B");
    expect((grouped[0] as { group?: { key: string; count: number } }).group).toMatchObject({
      key: "thread:1",
      count: 2,
    });
  });
});

describe("row ACL of a revision", () => {
  const base = { principal: { userId: undefined, userGroups: [], scopes: [], source: "asserted" as const }, tenantId: "t", scopes: [] };
  const service: AccessScope = { ...base, userId: undefined, userGroups: [], service: true };
  const user: AccessScope = { ...base, userId: "anna", userGroups: ["team", "sales"], service: false };

  it("a service writes the ACL it resolved, else the collection ACL, else none", () => {
    expect(rowAclForRevision(service, undefined, { users: ["b", "a", "a"], groups: [] })).toEqual({
      allowedUsers: ["a", "b"],
      allowedGroups: [],
    });
    expect(rowAclForRevision(service, { allowedUsers: [], allowedGroups: ["g"] }, { users: [], groups: [] })).toEqual({
      allowedUsers: [],
      allowedGroups: ["g"],
    });
    expect(rowAclForRevision(service, undefined, { users: [], groups: [] })).toEqual({
      allowedUsers: [],
      allowedGroups: [],
    });
  });

  it("an end user can only narrow to its own identity", () => {
    expect(rowAclForRevision(user, undefined, { users: [], groups: [] })).toEqual({
      allowedUsers: ["anna"],
      allowedGroups: ["sales", "team"],
    });
    expect(rowAclForRevision(user, undefined, { users: ["mallory"], groups: ["team", "admins"] })).toEqual({
      allowedUsers: [],
      allowedGroups: ["team"],
    });
  });

  it("rowAclAllows mirrors the search predicate", () => {
    expect(rowAclAllows(user, { allowedUsers: [], allowedGroups: [] })).toBe(true);
    expect(rowAclAllows(user, { allowedUsers: ["bob"], allowedGroups: ["sales"] })).toBe(true);
    expect(rowAclAllows(user, { allowedUsers: ["bob"], allowedGroups: [] })).toBe(false);
    expect(rowAclAllows(service, { allowedUsers: ["bob"], allowedGroups: [] })).toBe(true);
  });
});
