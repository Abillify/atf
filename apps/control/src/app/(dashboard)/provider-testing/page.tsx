// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /provider-testing — consolidated into /providers (Req. 9.9).
 *
 * The interactive provider/model test bench now lives in the "Test bench" tab
 * of /providers. This stub keeps the old URL working (bookmarks, deep links)
 * and lands on the tab directly.
 */

import { redirect } from "next/navigation";

export default function ProviderTestingRedirect(): never {
  redirect("/providers?tab=testing");
}
