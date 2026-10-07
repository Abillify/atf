// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Global `DOCUMENT_ACL_DEFAULT` switch (Req 3.2).
 *
 * `allow` (the backward-compatible default) keeps documents with empty
 * `allowed_users`/`allowed_groups` readable by every principal of the
 * tenant. `deny` inverts this: such rows are only visible to service or
 * authorization-bypass principals, and every other principal needs an
 * explicit `allowed_users`/`allowed_groups` match.
 *
 * The value is process-wide configuration, resolved once at startup from
 * `config.documentAclDefault` (see `createPostgresClient`). It lives in its
 * own dependency-free module so the SQL builder and the ACL helpers can
 * consult it without an import cycle through `config.ts`.
 */
export type DocumentAclDefault = "allow" | "deny";

let documentAclDefault: DocumentAclDefault = "allow";

export function setDocumentAclDefault(value: DocumentAclDefault): void {
  documentAclDefault = value;
}

export function getDocumentAclDefault(): DocumentAclDefault {
  return documentAclDefault;
}

/** True when rows with an empty ACL must stay hidden from non-service callers. */
export function deniesEmptyAcl(): boolean {
  return documentAclDefault === "deny";
}
