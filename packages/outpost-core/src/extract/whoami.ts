// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * `GET /v1/whoami` (E1). The outpost calls this before the first sync run to
 * validate its configuration (requirements 5.1, 5.2, 9.10) and surfaces the
 * instance limits (`maxUploadBytes`) to the planner.
 */

import { whoamiResponseSchema, type WhoamiResponse } from "@atf/extract-contract/v2";
import type { ExtractHttpClient } from "../http/client.js";
import { apiErrorCode, apiErrorMessage, ExtractApiError } from "./api-error.js";

/** Fetch and validate the whoami response. Throws on any non-200. */
export async function whoami(
  client: ExtractHttpClient,
  signal?: AbortSignal,
): Promise<WhoamiResponse> {
  const response = await client.request({ url: "/v1/whoami", signal });
  if (response.status !== 200) {
    throw new ExtractApiError(
      response.status,
      apiErrorCode(response.json),
      apiErrorMessage(response.json) ?? `whoami antwortete mit ${response.status}`,
    );
  }
  return whoamiResponseSchema.parse(response.json);
}
