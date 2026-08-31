"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Dashboard layout (UI-STYLE-GUIDE.md §7):
 *   - Header: burger (mobile) + brand + breadcrumb (md+) + ⌘K trigger +
 *     role/theme/sign-out.
 *   - Grouped navigation: a collapsible + pinnable icon sidebar on ≥lg screens
 *     (state persisted), collapsing to a focus-trapped, animated overlay drawer
 *     below lg (burger).
 *   - ⌘K command palette over all destinations.
 *   - AuthGuard: redirects to /auth when auth is ready and unauthenticated.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Menu,
  X,
  Search,
  Sun,
  Moon,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Rows3,
  StretchVertical,
} from "lucide-react";
import { useAuth } from "../../lib/auth/useAuth";
import { logout as oidcLogout } from "../../lib/oidc";
import { useTheme } from "../../lib/theme/ThemeProvider";
import { useDensity } from "../../lib/theme/DensityProvider";
import {
  Button,
  Badge,
  CommandPalette,
  usePresence,
  useModalBehavior,
  type CommandItem,
} from "../../lib/ui";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { NAV_GROUPS, NAV_ITEMS, isActivePath } from "../../lib/nav";

const SIDEBAR_KEY = "aiperator_sidebar_collapsed";

/** Header control to toggle between light and dark color schemes. */
function ThemeToggle() {
  const { colorScheme, toggle } = useTheme();
  const isDark = colorScheme === "dark";
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {isDark ? (
        <Sun className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Moon className="h-4 w-4" aria-hidden="true" />
      )}
    </Button>
  );
}

/** Header control to toggle UI density (comfortable ⇄ compact). */
function DensityToggle() {
  const { density, toggle } = useDensity();
  const isCompact = density === "compact";
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={toggle}
      aria-label={
        isCompact ? "Switch to comfortable density" : "Switch to compact density"
      }
      title={
        isCompact ? "Switch to comfortable density" : "Switch to compact density"
      }
    >
      {isCompact ? (
        <StretchVertical className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Rows3 className="h-4 w-4" aria-hidden="true" />
      )}
    </Button>
  );
}

/** Vertical grouped navigation, shared by the desktop sidebar and mobile drawer. */
function SidebarNav({
  pathname,
  collapsed = false,
  onNavigate,
  firstLinkRef,
}: {
  pathname: string;
  collapsed?: boolean;
  onNavigate?: () => void;
  firstLinkRef?: React.Ref<HTMLAnchorElement>;
}) {
  let linkIndex = 0;
  return (
    <nav aria-label="Dashboard sections" className="flex flex-col gap-3 p-2">
      {NAV_GROUPS.map(({ group, items }) => (
        <div key={group} role="group" aria-label={group}>
          {collapsed ? (
            <div className="mx-auto my-1 h-px w-6 bg-border" aria-hidden="true" />
          ) : (
            <p className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group}
            </p>
          )}
          <div className="flex flex-col gap-0.5">
            {items.map(({ href, label, icon: Icon }) => {
              const active = isActivePath(pathname, href);
              const isFirst = linkIndex === 0;
              linkIndex += 1;
              return (
                <Link
                  key={href}
                  href={href}
                  ref={isFirst ? firstLinkRef : undefined}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  title={collapsed ? label : undefined}
                  aria-label={collapsed ? label : undefined}
                  className={[
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    collapsed ? "justify-center" : "",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  ].join(" ")}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {!collapsed && <span className="truncate">{label}</span>}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

const PALETTE_ITEMS: CommandItem[] = NAV_ITEMS.map((i) => ({
  id: i.href,
  label: i.label,
  hint: i.hint,
  group: i.group,
  icon: i.icon,
}));

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isAuthenticated, ready, role, clearToken } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const burgerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const drawerFirstLinkRef = useRef<HTMLAnchorElement>(null);

  // Restore persisted sidebar collapse (client only; avoids hydration mismatch).
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(SIDEBAR_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  // AuthGuard.
  useEffect(() => {
    if (ready && !isAuthenticated) {
      router.push(`/auth?returnTo=${encodeURIComponent(pathname)}`);
    }
  }, [ready, isAuthenticated, pathname, router]);

  // Close the mobile drawer on navigation.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Global ⌘K / Ctrl-K toggles the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    burgerRef.current?.focus();
  }, []);

  const { mounted: drawerMounted, visible: drawerVisible } =
    usePresence(drawerOpen);
  useModalBehavior({
    open: drawerOpen,
    onClose: closeDrawer,
    containerRef: drawerRef,
    initialFocusRef: drawerFirstLinkRef,
  });

  const handleSignOut = (): void => {
    clearToken();
    void oidcLogout();
  };

  if (!ready) {
    return (
      <div
        className="flex h-screen items-center justify-center bg-background"
        aria-busy="true"
        aria-label="Loading"
      >
        <span className="sr-only">Loading…</span>
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-accent border-t-transparent motion-reduce:animate-none" />
      </div>
    );
  }

  if (!isAuthenticated) return null;

  return (
    <div className="flex h-screen flex-col bg-background">
      {/* ------------------------------------------------------------------ */}
      {/* Header                                                              */}
      {/* ------------------------------------------------------------------ */}
      <header className="flex items-center justify-between gap-2 border-b border-border bg-card px-4 py-3 shadow-sm sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Button
            ref={burgerRef}
            variant="ghost"
            size="sm"
            className="shrink-0 lg:hidden"
            aria-label="Open navigation menu"
            aria-expanded={drawerOpen}
            // Only reference the drawer while it is actually mounted — a dangling
            // aria-controls IDREF (drawer closed) is an invalid ARIA value.
            {...(drawerMounted ? { "aria-controls": "dashboard-drawer" } : {})}
            onClick={() => setDrawerOpen(true)}
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </Button>
          <Link
            href="/graph"
            className="truncate text-lg font-semibold text-foreground transition-colors hover:text-accent"
          >
            Aiperator
          </Link>
          <Breadcrumbs
            pathname={pathname}
            className="ml-2 hidden min-w-0 border-l border-border pl-3 md:block"
          />
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          {/* ⌘K trigger — full control on md+, icon-only on mobile.
              Visibility lives on the wrapper span: the Button primitive hardcodes
              `inline-flex`, which overrides a plain `hidden` utility. */}
          <span className="hidden md:inline-flex">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
              className="gap-2 text-muted-foreground"
            >
              <Search className="h-4 w-4" aria-hidden="true" />
              <span>Search…</span>
              <kbd className="rounded border border-border px-1 text-[10px] font-medium">
                ⌘K
              </kbd>
            </Button>
          </span>
          <span className="inline-flex md:hidden">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
            >
              <Search className="h-5 w-5" aria-hidden="true" />
            </Button>
          </span>

          {role && (
            <span className="hidden sm:inline-flex">
              <Badge variant="secondary">{role}</Badge>
            </span>
          )}
          <span className="hidden sm:inline-flex">
            <DensityToggle />
          </span>
          <ThemeToggle />
          <Button
            variant="outline"
            size="sm"
            onClick={handleSignOut}
            aria-label="Sign out"
          >
            <LogOut className="h-4 w-4 sm:hidden" aria-hidden="true" />
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </div>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Body: collapsible sidebar (lg+) / drawer (mobile) + main            */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex flex-1 overflow-hidden">
        {/* Persistent, collapsible sidebar — desktop only */}
        <aside
          className={[
            "hidden shrink-0 flex-col border-r border-border bg-card lg:flex",
            "transition-[width] duration-200 motion-reduce:transition-none",
            collapsed ? "w-16" : "w-60",
          ].join(" ")}
        >
          <div className="flex-1 overflow-y-auto">
            <SidebarNav pathname={pathname} collapsed={collapsed} />
          </div>
          <div className="border-t border-border p-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleCollapsed}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className={collapsed ? "w-full justify-center" : "w-full justify-start gap-2"}
            >
              {collapsed ? (
                <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
              ) : (
                <>
                  <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
                  <span>Collapse</span>
                </>
              )}
            </Button>
          </div>
        </aside>

        {/* Mobile drawer + backdrop (animated, focus-trapped) */}
        {drawerMounted && (
          <div className="lg:hidden">
            <div
              className={[
                "fixed inset-0 z-40 bg-black/50",
                "transition-opacity duration-200 motion-reduce:transition-none",
                drawerVisible ? "opacity-100" : "opacity-0",
              ].join(" ")}
              aria-hidden="true"
              onClick={closeDrawer}
            />
            <div
              id="dashboard-drawer"
              ref={drawerRef}
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
              className={[
                "fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-r border-border bg-card shadow-xl",
                "transition-transform duration-200 motion-reduce:transition-none",
                drawerVisible ? "translate-x-0" : "-translate-x-full",
              ].join(" ")}
            >
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <span className="text-sm font-semibold text-foreground">
                  Menu
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Close navigation menu"
                  onClick={closeDrawer}
                >
                  <X className="h-5 w-5" aria-hidden="true" />
                </Button>
              </div>
              <SidebarNav
                pathname={pathname}
                onNavigate={closeDrawer}
                firstLinkRef={drawerFirstLinkRef}
              />
            </div>
          </div>
        )}

        {/* Main content. tabIndex=0 keeps this scrollable region keyboard-
            accessible even on read-only pages with no focusable children
            (WCAG 2.1.1 — scrollable-region-focusable) and doubles as a
            skip-to-content target. */}
        <main
          tabIndex={0}
          className="flex-1 overflow-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {children}
        </main>
      </div>

      {/* Command palette (⌘K) */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={PALETTE_ITEMS}
        onSelect={(item) => router.push(item.id)}
      />
    </div>
  );
}
