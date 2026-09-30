// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Provider data for the cloud source OAuth flows (requirements 6.9, 6.20).
 *
 * Only read-only scopes with offline access are ever requested; the endpoints
 * are fixed constants so a configuration can never redirect a signed
 * assertion or a code exchange to a third party (15.1, 15.2).
 */

export type ProviderId = "gdrive" | "dropbox";

export interface ProviderInfo {
  id: ProviderId;
  /** Authorization endpoint (browser). */
  authorizeEndpoint: string;
  /** Token endpoint (code exchange and refresh). */
  tokenEndpoint: string;
  /** The exact scope string sent to the provider — read-only, nothing else. */
  scope: string;
  /**
   * Offline-access parameter: Dropbox `token_access_type=offline`,
   * Google `access_type=offline` plus `prompt=consent` (a refresh token is
   * only issued on an explicit consent screen).
   */
  offlineParams: Readonly<Record<string, string>>;
  /** Google issues a (non-confidential) secret even for desktop clients. */
  requiresClientSecret: boolean;
  /** Device-authorization endpoint (optional GDrive device flow, 6.15). */
  deviceEndpoint?: string;
}

export const GDRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const DROPBOX_SCOPE = "files.metadata.read files.content.read";

/** Fixed Google token endpoint — a key's `token_uri` is never honoured. */
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export const PROVIDERS: Readonly<Record<ProviderId, ProviderInfo>> = {
  gdrive: {
    id: "gdrive",
    authorizeEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
    scope: GDRIVE_SCOPE,
    offlineParams: { access_type: "offline", prompt: "consent" },
    requiresClientSecret: true,
    deviceEndpoint: "https://oauth2.googleapis.com/device/code",
  },
  dropbox: {
    id: "dropbox",
    authorizeEndpoint: "https://www.dropbox.com/oauth2/authorize",
    tokenEndpoint: "https://api.dropboxapi.com/oauth2/token",
    scope: DROPBOX_SCOPE,
    offlineParams: { token_access_type: "offline" },
    requiresClientSecret: false,
  },
};
