// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Router, type Request, type Response } from "express";
import type { AuthConfig, ServerConfig } from "../config/schema.ts";

export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

/**
 * Build the RFC 9728 "OAuth 2.0 Protected Resource Metadata" document for
 * this server, or `undefined` when it cannot be advertised (no `oauth`
 * issuer configured, or no `server.publicUrl` to anchor the URLs to).
 *
 * MCP clients (e.g. an IDE) fetch this document — discovered either via the
 * well-known path or via the `resource_metadata` link on a 401 — to find
 * which authorization server(s) to run an OAuth/OIDC flow against before
 * retrying with a bearer token.
 */
export function buildProtectedResourceMetadata(
  serverConfig: ServerConfig,
  authConfig: AuthConfig,
): Record<string, unknown> | undefined {
  if (authConfig.mode !== "oauth" && authConfig.mode !== "both") return undefined;
  const oauth = authConfig.oauth;
  if (!oauth || !serverConfig.publicUrl) return undefined;

  const base = serverConfig.publicUrl.replace(/\/$/, "");
  const authorizationServers = [oauth.issuer, ...oauth.additionalIssuers.map((i) => i.issuer)].filter(
    (iss): iss is string => Boolean(iss),
  );

  return {
    resource: oauth.resource ?? base,
    authorization_servers: authorizationServers,
    bearer_methods_supported: ["header"],
    ...(oauth.scopeClaim && oauth.requiredScopes.length > 0
      ? { scopes_supported: oauth.requiredScopes }
      : {}),
  };
}

/** Absolute URL of the protected-resource metadata document, or `undefined` if not advertisable. */
export function resourceMetadataUrl(serverConfig: ServerConfig): string | undefined {
  if (!serverConfig.publicUrl) return undefined;
  return `${serverConfig.publicUrl.replace(/\/$/, "")}${PROTECTED_RESOURCE_PATH}`;
}

/**
 * Build a `WWW-Authenticate` header value for a 401 response on an
 * OAuth-protected MCP endpoint, per RFC 9728 §5.1 / the MCP Authorization
 * spec. Returns `undefined` when metadata cannot be advertised (falls back
 * to a plain `Bearer` challenge is left to the caller in that case).
 */
export function bearerChallenge(
  serverConfig: ServerConfig,
  authConfig: AuthConfig,
  errorDescription?: string,
): string | undefined {
  if (authConfig.mode !== "oauth" && authConfig.mode !== "both") return undefined;
  const metadataUrl = resourceMetadataUrl(serverConfig);
  if (!metadataUrl) return undefined;

  const params = [`resource_metadata="${metadataUrl}"`];
  if (errorDescription) {
    params.push(`error="invalid_token"`, `error_description="${errorDescription.replace(/"/g, "'")}"`);
  }
  return `Bearer ${params.join(", ")}`;
}

export interface WellKnownDeps {
  serverConfig: ServerConfig;
  authConfig: AuthConfig;
}

/**
 * Express router exposing `/.well-known/oauth-protected-resource` (RFC
 * 9728). Mounted unconditionally; returns 404 when OAuth isn't configured
 * or `server.publicUrl` is unset, since there is nothing meaningful to
 * advertise in that case.
 */
export function createWellKnownRouter(deps: WellKnownDeps): Router {
  const { serverConfig, authConfig } = deps;
  const router = Router();

  router.get(PROTECTED_RESOURCE_PATH, (_req: Request, res: Response) => {
    const metadata = buildProtectedResourceMetadata(serverConfig, authConfig);
    if (!metadata) {
      res.status(404).json({ error: "OAuth protected-resource metadata is not configured" });
      return;
    }
    res.type("application/json").json(metadata);
  });

  return router;
}
