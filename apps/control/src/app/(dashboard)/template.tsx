// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React from "react";

/**
 * Route transition (UI-STYLE-GUIDE.md §11). A `template.tsx` re-mounts on every
 * navigation (unlike `layout.tsx`), so wrapping children here gives each page a
 * subtle entrance animation. Reduced-motion is honoured by `.animate-route-in`.
 */
export default function DashboardTemplate({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return <div className="animate-route-in h-full">{children}</div>;
}
