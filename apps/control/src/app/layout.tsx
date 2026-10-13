// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import "./globals.css";
import { QueryProvider } from "../lib/query/QueryProvider";
import { AuthProvider } from "../lib/auth/AuthProvider";
import { ThemeProvider } from "../lib/theme/ThemeProvider";
import { DensityProvider } from "../lib/theme/DensityProvider";
import { ConfirmProvider, ToastProvider } from "../lib/ui";
import { CSP_NONCE_REQUEST_HEADER } from "../lib/csp-policy";
import { controlSessionMode } from "../lib/session-mode";
import { CONTROL_SESSION_MODE_GLOBAL } from "../lib/client-session-mode";
import { LocaleProvider } from "../lib/i18n";
import { LOCALE_COOKIE, parseLocale } from "../lib/i18n/locales";

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
 * BFF mode flag (Req 8.7): the server sets it BEFORE hydration so the
 * client detects synchronously that access tokens are held only on the
 * server and all backend calls go through the route-handler proxy
 * (`/api/backend/...`). Only emitted when `CONTROL_SESSION_MODE=bff` is
 * set; in the default mode (token) the HTML stays identical to before.
 */
function sessionModeFlagScript(): string {
  return `(function(){window[${JSON.stringify(CONTROL_SESSION_MODE_GLOBAL)}]='bff';})();`;
}

/**
 * Root layout — Server Component that injects global providers.
 *
 * Provider stack (innermost = AuthProvider):
 *   ThemeProvider   →  dark/light class on <html>
 *   DensityProvider →  data-density (comfortable/compact) on <html>
 *   QueryProvider   →  TanStack QueryClient for the whole app
 *   AuthProvider   →  session token, role, silent renewal
 *   ToastProvider  →  app-wide transient notifications (useToast)
 *   ConfirmProvider →  app-wide confirm/prompt dialogs replacing window.confirm
 *
 *   LocaleProvider  →  i18n catalogs (de/en), `lang`, Intl formatters
 *
 * Req. 9.5 – confirm/prompt dialogs available at every route.
 * Req. 9.1 – auth context available at every route.
 * Req. 9.7 – the active locale comes from the NEXT_LOCALE cookie (server-side,
 *   so first paint already renders in the right language and <html lang> is
 *   correct); LocaleProvider wraps every route.
 * Req. 10.1 – theme context available at every route.
 * Req. 10.2 – QueryClient available at every route.
 * Req. 8.1 – the theme script carries the per-request CSP nonce emitted by
 * src/proxy.ts (absent in legacy mode, where inline scripts stay allowed).
 * Req. 8.7 – in BFF mode an additional nonce'd script publishes the session
 * mode so the client routes all backend traffic through the proxy.
 */
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const nonce = (await headers()).get(CSP_NONCE_REQUEST_HEADER) ?? undefined;
  const bff = controlSessionMode() === "bff";
  // Req 9.7: resolve the locale before first paint — the cookie is written by
  // LocaleProvider on switch, so a reload keeps the chosen language.
  const locale = parseLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script
          nonce={nonce}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: server-provided, nonce-protected theme/density bootstrap (Req 9.7); the content is a fixed literal, covered by the CSP nonce
          dangerouslySetInnerHTML={{ __html: themeInitScript }}
        />
        {bff ? (
          <script
            nonce={nonce}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-provided, nonce-protected session-mode flag (Req 8.7); the content is a fixed literal, covered by the CSP nonce
            dangerouslySetInnerHTML={{ __html: sessionModeFlagScript() }}
          />
        ) : null}
      </head>
      <body>
        <LocaleProvider initialLocale={locale}>
          <ThemeProvider>
            <DensityProvider>
              <QueryProvider>
                <AuthProvider>
                  <ToastProvider>
                    <ConfirmProvider>{children}</ConfirmProvider>
                  </ToastProvider>
                </AuthProvider>
              </QueryProvider>
            </DensityProvider>
          </ThemeProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
