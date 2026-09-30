// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Credential key namespaces (requirements 1.10, 3.5, 3.9).
 *
 * The two namespaces are strictly separated so that `logout()` (which removes
 * only {@link EXTRACT_AUTH_KEYS}) can never touch a per-source credential,
 * and a source re-authorization can never overwrite an SSO token. Listing is
 * deliberately not required: keychain APIs do not offer it reliably, so
 * `logout()` deletes the fixed list instead.
 */

/** Prefix of all Extract-SSO / static-credential keys. */
export const AUTH_EXTRACT_PREFIX = "auth:extract:";

export const EXTRACT_REFRESH_TOKEN_KEY = "auth:extract:refresh-token";
export const EXTRACT_API_TOKEN_KEY = "auth:extract:api-token";
export const EXTRACT_CLIENT_SECRET_KEY = "auth:extract:client-secret";

/**
 * The complete, fixed set of keys `logout()` deletes — and the only keys it
 * ever deletes (3.5, 3.9).
 */
export const EXTRACT_AUTH_KEYS: readonly string[] = [
  EXTRACT_REFRESH_TOKEN_KEY,
  EXTRACT_API_TOKEN_KEY,
  EXTRACT_CLIENT_SECRET_KEY,
];

/** Refresh token for a cloud source (GDrive/Dropbox), written by source-login and provider rotation. */
export const sourceOauthRefreshKey = (sourceId: string): string =>
  `source:${sourceId}:oauth-refresh`;

/** Google service-account key JSON (desktop only; Docker reads `_FILE`). */
export const sourceGdriveSaKey = (sourceId: string): string =>
  `source:${sourceId}:gdrive-sa`;

/** S3 access key id. */
export const sourceS3AccessKeyKey = (sourceId: string): string =>
  `source:${sourceId}:s3-access-key`;

/** S3 secret access key. */
export const sourceS3SecretKeyKey = (sourceId: string): string =>
  `source:${sourceId}:s3-secret-key`;

/** True for keys in the `auth:extract:*` namespace. */
export const isExtractAuthKey = (key: string): boolean =>
  key.startsWith(AUTH_EXTRACT_PREFIX);
