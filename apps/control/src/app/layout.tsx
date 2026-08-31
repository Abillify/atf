// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { Metadata, Viewport } from "next";
import "./globals.css";
import { QueryProvider } from "../lib/query/QueryProvider";
import { AuthProvider } from "../lib/auth/AuthProvider";
import { ThemeProvider } from "../lib/theme/ThemeProvider";
import { DensityProvider } from "../lib/theme/DensityProvider";
import { ToastProvider } from "../lib/ui";

export const metadata: Metadata = {
  title: "Aiperator Dashboard",
  description: "AI Agent Orchestration Platform Monitoring",
};

/**
 * Explicit viewport so responsive breakpoints evaluate against the real device
 * width. Required here because the root layout renders a manual <head> (for the
 * no-flash theme script), which otherwise suppresses Next's auto-injected
 * viewport meta — without this, mobile browsers lay out at ~980px and every
 * `sm:`/`md:`/`lg:` query resolves as desktop.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

/**
 * Blocking pre-hydration script: applies the persisted (or OS-preferred) color
 * scheme to <html> BEFORE first paint, so the page never flashes light on load
 * before ThemeProvider's effect runs. Kept in sync with ThemeProvider
 * (STORAGE_KEY = "aiperator_theme"). Runs synchronously in <head>.
 */
const themeInitScript = `(function(){try{var t=localStorage.getItem('aiperator_theme');var dark=t==='dark'||(t!=='light'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(dark){document.documentElement.classList.add('dark');}var d=localStorage.getItem('aiperator_density');document.documentElement.dataset.density=(d==='compact')?'compact':'comfortable';}catch(e){}})();`;

/**
 * Root layout — Server Component that injects global providers.
 *
 * Provider stack (innermost = AuthProvider):
 *   ThemeProvider   →  dark/light class on <html>
 *   DensityProvider →  data-density (comfortable/compact) on <html>
 *   QueryProvider   →  TanStack QueryClient for the whole app
 *   AuthProvider   →  session token, role, silent renewal
 *   ToastProvider  →  app-wide transient notifications (useToast)
 *
 * Req. 9.1 – auth context available at every route.
 * Req. 10.1 – theme context available at every route.
 * Req. 10.2 – QueryClient available at every route.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <ThemeProvider>
          <DensityProvider>
            <QueryProvider>
              <AuthProvider>
                <ToastProvider>{children}</ToastProvider>
              </AuthProvider>
            </QueryProvider>
          </DensityProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
