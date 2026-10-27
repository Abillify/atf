// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * The ACL written onto ingested documents.
 *
 * This is the highest-consequence logic in the service and the least visible. A
 * wrong ACL leaks nothing from this process; it writes the wrong visibility onto
 * rows in a shared index, where it persists and stays invisible until someone
 * retrieves a document they should not see.
 *
 * The rule: `X-Allowed-Users` and `X-Allowed-Groups` may only *narrow* what the
 * caller already is. Passing them through would let any credential that may
 * convert a file also publish it to an arbitrary audience — a privilege
 * escalation dressed up as a convenience.
 */

import { describe, expect, it } from "vitest";
import { resolveAcl } from "../src/handlers/ingest.js";
import { ExtractError } from "../src/errors.js";
import type { RequestPrincipal } from "../src/request-principal.js";

const user: RequestPrincipal = {
  userId: "alice",
  userGroups: ["engineering", "wms"],
  source: "jwt",
};

const service: RequestPrincipal = {
  userId: undefined,
  userGroups: undefined,
  source: "service",
};

describe("resolveAcl", () => {
  it("defaults to the caller's own identity", () => {
    expect(resolveAcl(user, { users: [], groups: [] })).toEqual({
      allowedUsers: ["alice"],
      allowedGroups: ["engineering", "wms"],
      mode: "none",
    });
  });

  it("narrows to the requested subset", () => {
    expect(resolveAcl(user, { users: [], groups: ["wms"] })).toEqual({
      allowedUsers: ["alice"],
      allowedGroups: ["wms"],
      mode: "intersected",
    });
  });

  it("drops a group the caller is not in, rather than granting it", () => {
    // The escalation this exists to prevent.
    expect(resolveAcl(user, { users: [], groups: ["finance"] })).toEqual({
      allowedUsers: ["alice"],
      allowedGroups: [],
      mode: "intersected",
    });
  });

  it("drops another user, rather than publishing on their behalf", () => {
    expect(resolveAcl(user, { users: ["bob"], groups: [] })).toEqual({
      allowedUsers: [],
      allowedGroups: ["engineering", "wms"],
      mode: "intersected",
    });
  });

  it("keeps the caller when they ask for themselves explicitly", () => {
    expect(resolveAcl(user, { users: ["alice"], groups: [] })).toEqual({
      allowedUsers: ["alice"],
      allowedGroups: ["engineering", "wms"],
      mode: "intersected",
    });
  });

  it("passes an intersection through when only part is permitted", () => {
    // A bulk uploader naming a group the caller happens not to be in should keep
    // working for the groups they do have.
    expect(resolveAcl(user, { users: [], groups: ["wms", "finance"] })).toEqual({
      allowedUsers: ["alice"],
      allowedGroups: ["wms"],
      mode: "intersected",
    });
  });

  describe("service context", () => {
    it("produces an empty ACL, which Search reads as unrestricted", () => {
      // Documented service-to-service behaviour; ACL_REQUIRE_IDENTITY is the
      // switch that turns it into a 403.
      expect(resolveAcl(service, { users: [], groups: [] })).toEqual({
        allowedUsers: [],
        allowedGroups: [],
        mode: "none",
      });
    });

    it("cannot be talked into an ACL by headers alone", () => {
      // Otherwise a service token could write a document visible only to a user it
      // has no relationship with — which reads as legitimate and is not.
      expect(resolveAcl(service, { users: ["alice"], groups: ["finance"] })).toEqual({
        allowedUsers: [],
        allowedGroups: [],
        mode: "service-empty",
      });
    });
  });

  it("handles a group-only principal", () => {
    const groupOnly: RequestPrincipal = {
      userId: undefined,
      userGroups: ["wms"],
      source: "jwt",
    };
    expect(resolveAcl(groupOnly, { users: [], groups: [] })).toEqual({
      allowedUsers: [],
      allowedGroups: ["wms"],
      mode: "none",
    });
  });

  describe("extract.acl.assign", () => {
    const assigner: RequestPrincipal = {
      userId: undefined,
      userGroups: undefined,
      source: "service",
      scopes: ["extract.ingest", "extract.acl.assign"],
    };

    it("applies the requested list unchanged for a service token", () => {
      expect(resolveAcl(assigner, { users: ["Alice@Example.com"], groups: ["Finance"] })).toEqual({
        allowedUsers: ["alice@example.com"],
        allowedGroups: ["Finance"],
        mode: "assigned",
      });
    });

    it("applies the requested list even when the caller has an identity", () => {
      const withIdentity: RequestPrincipal = { ...user, scopes: ["extract.acl.assign"] };
      expect(resolveAcl(withIdentity, { users: ["bob"], groups: ["finance"] })).toEqual({
        allowedUsers: ["bob"],
        allowedGroups: ["finance"],
        mode: "assigned",
      });
    });

    it("is implied by extract.admin", () => {
      const admin: RequestPrincipal = { ...service, scopes: ["extract.admin"] };
      expect(resolveAcl(admin, { users: [], groups: ["finance"] })).toEqual({
        allowedUsers: [],
        allowedGroups: ["finance"],
        mode: "assigned",
      });
    });

    it("trims, drops blanks and removes duplicates", () => {
      expect(
        resolveAcl(assigner, { users: [" bob ", "", "BOB"], groups: ["a", " a ", ""] }),
      ).toEqual({ allowedUsers: ["bob"], allowedGroups: ["a"], mode: "assigned" });
    });

    it("does not change the result when nothing is requested", () => {
      expect(resolveAcl(assigner, { users: [], groups: [] })).toEqual({
        allowedUsers: [],
        allowedGroups: [],
        mode: "none",
      });
    });

    it("still intersects for a token without the scope", () => {
      const plain: RequestPrincipal = { ...service, scopes: ["extract.ingest"] };
      expect(resolveAcl(plain, { users: ["alice"], groups: ["finance"] })).toEqual({
        allowedUsers: [],
        allowedGroups: [],
        mode: "service-empty",
      });
    });

    it.each([
      ["too many entries", { users: [], groups: Array.from({ length: 201 }, (_, i) => `g${i}`) }],
      ["an entry that is too long", { users: ["u".repeat(257)], groups: [] }],
      ["a control character", { users: [], groups: ["fin\u0000ance"] }],
    ])("rejects %s with INVALID_ACL", (_label, requested) => {
      let thrown: unknown;
      try {
        resolveAcl(assigner, requested);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ExtractError);
      expect((thrown as ExtractError).code).toBe("INVALID_ACL");
      expect((thrown as ExtractError).message).toBe(
        "X-Allowed-Users/X-Allowed-Groups: at most 200 entries of at most 256 characters, no control characters",
      );
    });
  });
});
