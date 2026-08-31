// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { AppConfig } from "../config/schema.js";
import { createJwtVerifier, createOperatorVerifier } from "../middleware/jwt-verifier.js";
import { createOperatorAuthorizer } from "../middleware/operator-rbac.js";
import type { Logger } from "../observability/logger.js";

/** Builds inference and operator authentication while preserving independent monitoring/metrics flags. */
export function buildOperatorAuthentication(config: AppConfig, logger: Logger) {
  const jwtVerifier = createJwtVerifier(config, logger);
  const operatorVerifier = createOperatorVerifier(config, jwtVerifier, logger);
  const buildOperatorAuth = (authRequired: boolean) =>
    createOperatorAuthorizer({
      authRequired,
      authorizationEnabled: config.authzEnabled ?? true,
      allowUnverifiedJwt: config.allowUnverifiedJwt ?? false,
      allowQueryToken: config.appEnv !== "production",
      ...(config.authnMode !== "oidc" && config.operatorTokens !== undefined
        ? { tokens: config.operatorTokens }
        : {}),
      ...(config.operatorRoleClaim !== undefined ? { roleClaim: config.operatorRoleClaim } : {}),
      ...(config.operatorGroupsClaim !== undefined ? { groupsClaim: config.operatorGroupsClaim } : {}),
      ...(config.operatorRoleMap !== undefined ? { roleMap: config.operatorRoleMap } : {}),
      ...(config.operatorDefaultRole !== undefined ? { defaultRole: config.operatorDefaultRole } : {}),
      jwtVerifier: operatorVerifier,
    });
  const operatorAuth = buildOperatorAuth(config.monitoringAuthRequired);
  if (operatorAuth.rbacEnabled) {
    logger.info("Operator RBAC enabled", {
      staticTokens: config.operatorTokens?.length ?? 0,
      roleClaim: config.operatorRoleClaim ?? "role",
    });
  }
  const metricsAuthRequired = config.metricsAuthRequired ?? false;
  const metricsOperatorAuth = metricsAuthRequired === config.monitoringAuthRequired
    ? operatorAuth
    : buildOperatorAuth(metricsAuthRequired);
  return {
    jwtVerifier,
    operatorAuth,
    metricsOperatorAuth,
    metricsAuthRequiredFlag: metricsAuthRequired,
  };
}
