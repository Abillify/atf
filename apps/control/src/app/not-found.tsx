// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Global 404 page (Req 9.6, Task 13.5).
 *
 * Next.js renders this component for unknown routes. It lives in the root
 * `app` directory and therefore applies to all routes, including those
 * outside the dashboard segment (e.g. non-existent `/api/...` paths in the
 * browser). A separate `not-found.tsx` per dashboard route is not needed
 * because all dashboard routes inherit from this root entry.
 */

import Link from "next/link";
import { translate } from "../lib/i18n";

export default function NotFound() {
  return (
    <main
      className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center"
      data-testid="not-found"
    >
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 className="text-lg font-semibold text-foreground">{translate("not-found.pageNotFound")}</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        {translate("not-found.thePageYouAreLooking")}
      </p>
      <Link
        href="/"
        className="rounded-md border border-border px-4 py-2 text-sm text-foreground hover:bg-muted"
      >
        {translate("not-found.backToDashboard")}
      </Link>
    </main>
  );
}
