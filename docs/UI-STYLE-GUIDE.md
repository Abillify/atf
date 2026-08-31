# aiperator Dashboard — UI Style Guide

Status: **authoritative**. Every page and component in `apps/control/` MUST comply.
This guide defines the design language, the component contract, the responsive
rules, and the accessibility baseline for the operator dashboard.

> TL;DR — Build only from `@/lib/ui` primitives. Use semantic color tokens only
> (never raw `gray-*`/`white`). Every screen is usable on a 360 px phone. The
> nav is grouped into four sections and collapses to a burger drawer below the
> `lg` breakpoint.

---

## 1. Principles

1. **One design language.** All surfaces, text, and borders use the semantic
   design tokens (§3). No bespoke `bg-white`, `dark:bg-gray-800`, `text-gray-*`.
2. **Primitives first.** Buttons, badges, tables, tabs, cards, dialogs,
   skeletons, toasts come from `apps/control/src/lib/ui`. Don't hand-roll them.
3. **Mobile is not optional.** Every page is fully operable on a phone
   (≥ 360 px). Layouts reflow, never require horizontal page scrolling (only
   individual wide artifacts — tables, graphs — scroll inside their own box).
4. **Accessible by default.** Semantic HTML, visible focus rings, labelled
   controls, keyboard operability, adequate contrast.
5. **Calm, dense, professional.** Data-first. Restrained color — color carries
   meaning (status), not decoration. Generous whitespace on large screens,
   tighter on small.
6. **Predictable states.** Every async view has explicit loading, empty, and
   error states.

---

## 2. Foundations

- **Framework:** Next.js (App Router) + React + TypeScript.
- **Styling:** Tailwind CSS v4, `darkMode: "class"`. Tokens are CSS variables in
  `src/app/globals.css`, exposed as Tailwind colors in `tailwind.config.ts`.
- **State/data:** TanStack Query for server state; local UI state in hooks.
- **Theme:** light/dark via the `.dark` class on `<html>`, applied pre-paint by
  a blocking script in the root layout (no flash), toggled in the header.

---

## 3. Design tokens

Use these Tailwind color utilities **exclusively**. Never hardcode a gray/white
shade. Each token is defined for light and dark in `globals.css`.

| Token (Tailwind)            | Role                                             |
| --------------------------- | ------------------------------------------------ |
| `bg-background`             | App/page background                              |
| `text-foreground`          | Primary text                                     |
| `bg-card` / `text-card-foreground` | Card / panel surface + its text          |
| `bg-popover` / `text-popover-foreground` | Overlays (dialogs, menus, toasts)  |
| `bg-muted` / `text-muted-foreground` | Subtle surface / secondary text        |
| `bg-secondary` / `text-secondary-foreground` | Secondary control surface      |
| `bg-accent` / `text-accent-foreground` | Primary action, active nav, links      |
| `bg-destructive` / `text-destructive-foreground` | Danger action / error state  |
| `border-border`             | All borders and dividers (`divide-border`)       |
| `ring-ring`                 | Focus ring                                       |

Semantic **status** colors (the only place raw palette shades are allowed, and
only through the `Badge` variants or small status dots):

- success → `success` badge / `emerald`
- warning → `warning` badge / `amber`
- error/danger → `destructive` badge / `red`
- neutral/info → `secondary`/`outline` badge

**Radius:** `--radius = 0.5rem`. Use `rounded-md` (controls), `rounded-lg`
(cards/panels), `rounded-full` (badges/dots).

**Elevation:** flat by default; `shadow-sm` for cards/header, `shadow-lg`/`xl`
for overlays only. Prefer borders over shadows for structure.

---

## 4. Typography

System font stack (Tailwind default). Scale:

| Use                     | Classes                                  |
| ----------------------- | ---------------------------------------- |
| Page title (h1)         | `text-xl font-semibold` (mobile) → `sm:text-2xl` |
| Section / card title    | `text-base font-semibold`                |
| Body                    | `text-sm`                                |
| Secondary / meta        | `text-xs text-muted-foreground`          |
| Micro-label / KPI label | `text-[11px] font-medium uppercase tracking-wide text-muted-foreground` |
| Numbers / IDs / code    | add `tabular-nums` / `font-mono`         |

Rules: one `h1` per page. Don't skip heading levels. Never convey meaning by
color alone — pair with text or an icon.

---

## 5. Spacing & layout grid

- **Spacing scale:** multiples of 4 (`gap-1/2/3/4/6`, `p-*`, `space-y-*`).
- **Page container:** every page's root wrapper uses responsive padding and a
  max width for readability on ultra-wide screens:
  ```tsx
  <div className="mx-auto w-full max-w-screen-2xl p-4 sm:p-6">…</div>
  ```
  (Full-bleed canvas pages — Live Graph, Studio — are exempt and manage their
  own height/scroll.)
- **Vertical rhythm:** stack sections with `space-y-6` (`space-y-4` on mobile).
- **Card grids:** always responsive, mobile-first — start at one column:
  ```tsx
  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">…</div>
  ```
  Never ship a bare `grid-cols-2/3/4` without smaller-screen fallbacks.
- **Side-by-side panels** stack on mobile: `flex flex-col lg:flex-row`.

---

## 6. Responsive rules

Tailwind breakpoints: `sm 640`, `md 768`, `lg 1024`, `xl 1280`, `2xl 1536`.

Mandatory:

1. **No fixed pixel widths on layout containers at mobile.** A `w-64` sidebar
   must be `hidden lg:block` (moved into the burger drawer on mobile) or become
   full-width (`w-full lg:w-64`).
2. **Multi-column → single column** below `lg` (content) / `sm` (KPI strips).
3. **Wide artifacts scroll inside their box, not the page.** Tables use the
   `Table` primitive (built-in `overflow-x-auto`). Graphs/diagrams sit in an
   `overflow-auto` container.
4. **Touch targets ≥ 40 px.** Use `Button size="md"` (h-9) or larger for primary
   mobile actions; `sm` (h-8) is acceptable for dense desktop toolbars.
5. **Tab bars / toolbars** that can overflow use `flex-nowrap overflow-x-auto`
   with `shrink-0` items.
6. Test every page at **360, 768, 1280 px**.

---

## 7. Navigation (grouped + responsive burger)

The dashboard nav is grouped into **four** sections. Item labels are unchanged;
group headers organize them:

| Group (header)              | Destinations                                                        |
| --------------------------- | ------------------------------------------------------------------- |
| **Recherche & Optimierung** | Studio, RAG, Memory, Eval, Optimizer, Canary, Autopilot             |
| **Monitoring**              | Live Graph, Traces, History, Approvals, Security                    |
| **Konfiguration**           | Flows, Flow Diff, Providers, Guardrails, PII Vault, Compliance, MCP |
| **Budgetierung**            | Cost & Tokens, Limits, Tenants                                      |

The grouping, labels, and icons live in ONE source of truth —
`src/lib/nav.ts` (`NAV_GROUPS` / `NAV_ITEMS`) — consumed by the sidebar, drawer,
command palette, and breadcrumbs so they never drift. Each item carries a
`lucide-react` icon.

Behavior:

- **≥ `lg`:** a persistent, **collapsible + pinnable** left **sidebar**
  (`w-60` expanded ⇄ `w-16` icon-only), vertically scrollable, with the four
  group headers (`text-[11px] uppercase tracking-wider text-muted-foreground`)
  and icon + label links below each. Collapse state is persisted
  (`localStorage: aiperator_sidebar_collapsed`); collapsed links show the label
  via `title`/`aria-label`. Width animates (`transition-[width]`,
  reduced-motion aware).
- **< `lg`:** the sidebar is hidden; a **burger button** in the header opens it
  as an animated overlay **drawer** (`w-72 max-w-[85vw]`, slide-in + backdrop
  fade) with a dimmed backdrop.
- **Active link:** `bg-accent text-accent-foreground`; inactive:
  `text-muted-foreground hover:bg-muted hover:text-foreground`. Set
  `aria-current="page"`.
- **Drawer a11y (implemented):** `role="dialog" aria-modal="true"`, a real
  `Tab` **focus trap** + background **scroll-lock** (`useModalBehavior`), closes
  on backdrop click, `Escape`, and route change; focus moves into the drawer on
  open and returns to the burger on close. Burger has `aria-label`,
  `aria-expanded`, `aria-controls`.
- **Breadcrumbs:** a compact "Group ▸ Page" trail (from `src/lib/nav.ts`) in the
  header on `md`+ (`Breadcrumbs` component).
- **⌘K command palette:** global `⌘K`/`Ctrl-K` (and a header search trigger)
  opens a fuzzy launcher over every destination (§8).

Header (always visible): burger (mobile only) + brand + breadcrumb (md+) on the
left; ⌘K trigger, role badge, theme toggle, sign-out on the right. On the
narrowest screens the role badge hides (`< sm`), sign-out collapses to an icon,
and the ⌘K trigger becomes an icon button — the header never overflows at
360 px. NOTE: visibility toggles that must hide a `Button`/`Badge` go on a
wrapper element, because those primitives hardcode `inline-flex`, which a plain
`hidden` utility cannot override.

---

## 8. Component catalog (`@/lib/ui`)

Import from `@/lib/ui` (or the correct relative path). Do not re-implement.

### Button
`variant`: `primary` (main/confirm/save/publish) · `secondary` (neutral
alternative) · `destructive` (delete/deny/erase) · `outline` (neutral, on
surfaces) · `ghost` (subtle/icon/toolbar). `size`: `sm` (dense desktop) ·
`md` (default, mobile primary) · `lg`. Props: `loading` (spinner + disabled),
`icon`. Renders a real `<button>` with focus ring; add `type="button"` inside
forms unless it is the submit.

### Badge
`variant`: `default` · `secondary` · `outline` · `success` · `warning` ·
`destructive`. For status/labels only. Green=success, amber=warning,
red=destructive, neutral=secondary/outline.

### Card / CardHeader / CardTitle / CardContent
The standard content container (`rounded-lg border border-border bg-card
shadow-sm`, padded unless `noPadding`). Use for KPI tiles, grouped content.

### Panel
Section container with an optional `heading` and its own scroll area — use for
sidebars/framed regions.

### Table / TableHead / TableBody / TableRow / TableHeaderCell / TableCell
All tabular data. Includes `overflow-x-auto`, header styling, row hover, and a
`caption`. Keep only semantic extras on cells (`text-right`, `tabular-nums`,
`whitespace-nowrap`).

### Tabs / TabsList / TabsTrigger / TabsContent
In-page view switching. Controlled (`value`/`onValueChange`) or uncontrolled
(`defaultValue`). Roving-tabindex + arrow-key/`Enter`/`Space` support built in.

### Dialog
Modal with a real `Tab` **focus trap**, background **scroll-lock**, focus
restoration, `Escape`-to-close, backdrop-click close, an enter/exit animation
(reduced-motion aware), and ARIA (`role="dialog" aria-modal`). Props: `open`,
`onClose`, `title`, optional `description`.

### CommandPalette (⌘K)
Fuzzy-search launcher over a set of destinations/actions. ARIA combobox +
listbox with `aria-activedescendant`; `↑`/`↓`/`Home`/`End`/`Enter` keyboard nav;
focus trap + scroll-lock + animation. Generic `CommandItem[]` (`id`, `label`,
`hint?`, `group?`, `icon?`); the dashboard feeds it `NAV_ITEMS`. Mounted once in
the dashboard layout and toggled by global `⌘K`.

### useModalBehavior / usePresence (hooks)
`useModalBehavior({ open, onClose, containerRef, initialFocusRef? })` — the
shared overlay behavior (focus trap + scroll-lock + `Escape` + focus restore).
`usePresence(open, ms)` — keeps a node mounted through its exit transition for
enter/exit animation. Pair transitions with `motion-reduce:transition-none`.

### Skeleton / SkeletonBlock
Loading placeholders (already `animate-pulse bg-muted rounded-md`). Use in every
`loading.tsx` and inline loading region. `SkeletonBlock lines={n}` for text.

### Toast (ToastProvider / useToast)
Transient feedback for mutations (save/delete/errors). `variant`: `default` ·
`success` · `warning` · `destructive`. Prefer a toast over an inline banner for
one-off action results.

---

## 9. Patterns

**Page shell**

```tsx
export default function ExamplePage() {
  return (
    <div className="mx-auto w-full max-w-screen-2xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold sm:text-2xl">Title</h1>
        <div className="flex flex-wrap gap-2">{/* actions via <Button/> */}</div>
      </header>
      {/* content: <Card/>, <Table/>, responsive grids */}
    </div>
  );
}
```

**Loading (`loading.tsx`)** — Skeletons mirroring the real layout, wrapped with
`aria-busy` + `aria-label`.

**Empty state** — centered muted message inside the container; offer the primary
action when relevant.

**Error** — `role="alert"` with `text-destructive`; a retry `Button` when
recoverable. Route-level `error.tsx` for uncaught render errors.

**Forms** — every control has an accessible name (wrapping `<label>`,
`htmlFor`, or `aria-label`). Inputs/selects/textareas use
`border-border bg-background` and a **consistent token focus ring**
(`focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`) —
never a color-only `focus:border-*` change or a bespoke `blue-*`/`purple-*`
shade, and never a bare `focus:outline-none` without a replacement ring. Actions
are right-aligned; destructive actions separated.

---

## 10. Accessibility checklist (per screen)

- [ ] Semantic landmarks: one `<h1>`, `<nav>`, `<main>`.
- [ ] All interactive elements are real `button`/`a`/inputs with labels.
- [ ] Visible focus ring (`focus-visible:ring-ring`) — never remove outlines.
- [ ] Keyboard: everything reachable and operable; drawer/dialog trap + `Escape`.
- [ ] Status not by color alone (add text/icon).
- [ ] Images/icons: `alt` or `aria-hidden`.
- [ ] Contrast ≥ 4.5:1 (body) / 3:1 (large) — guaranteed by the tokens.

---

## 11. Motion

Subtle and fast. `transition-colors` on hover/active; `transition`/
`transition-transform`/`transition-opacity` for overlays (drawer slide, dialog
& palette fade+zoom, sidebar width); `animate-pulse` for skeletons;
`animate-spin` for spinners. Durations ≤ 200 ms.

**Reduced motion is honoured:** every transition/animation carries a
`motion-reduce:transition-none` / `motion-reduce:animate-none` variant (the
`Skeleton` and the loading spinner included), so users with
`prefers-reduced-motion: reduce` get instant, non-animated state changes.

**Route transitions:** `(dashboard)/template.tsx` wraps each page in
`.animate-route-in` (a short fade/slide, reduced-motion aware), giving every
navigation a subtle entrance without per-page code.

### Density (comfortable / compact)

A user-toggleable **density** (`DensityProvider`, header toggle, persisted; set
`data-density` on `<html>`, applied pre-paint) flips CSS tokens so data-dense
surfaces tighten for power users without per-component edits:

| Token           | comfortable | compact  | consumed by             |
| --------------- | ----------- | -------- | ----------------------- |
| `--ui-card-p`   | `1rem`      | `0.625rem` | `Card` padding        |
| `--ui-cell-py`  | `0.5rem`    | `0.25rem`  | `Table` cell padding  |
| `--ui-cell-h`   | `2.5rem`    | `2rem`     | `Table` header height |

Build new dense surfaces to read these vars (`p-[var(--ui-card-p)]`, …) rather
than hardcoding padding, so they respond to the toggle for free.

---

## 12. Do / Don't

**Do**
- Compose from `@/lib/ui`; use semantic tokens; make grids mobile-first; label
  everything; test at 360/768/1280.

**Don't**
- Hand-roll buttons/tables/badges; use `bg-white`/`gray-*`/hex colors; ship a
  fixed multi-column grid with no mobile fallback; put a fixed-width sidebar in
  the mobile flow; convey state by color only; remove focus outlines.

---

## 13. Compliance & enforcement

- A file may reference raw `gray-*`/`bg-white` **only** for an intentional
  accent that has no token equivalent (rare — e.g. a status dot); prefer a
  `Badge`/token.
- New pages start from the **Page shell** (§9).
- CI gates: `bun run --filter @atf/control typecheck`, `bun run --filter @atf/control test`, and `bun run --filter @atf/control build` must pass. Verify the
  four responsive checkpoints before merging UI changes.

---

## 14. Implemented shell features

The full SOTA interaction + tooling layer is implemented and enforced:

- Real `Tab` **focus trap** + background **scroll-lock** + focus restore in
  `Dialog`, the mobile drawer, and the command palette (`useModalBehavior`).
- **Enter/exit animations** (drawer slide, dialog/palette fade+zoom, sidebar
  width) and **route transitions** (`template.tsx`), all `prefers-reduced-motion`
  aware.
- **⌘K command palette**, header **breadcrumbs**, a **collapsible/pinnable**
  desktop icon sidebar (persisted), and a **density** toggle
  (comfortable/compact, persisted) — all driven by one nav/token source.
- **Automated a11y in CI:** axe-core with **zero WCAG A/AA violations** on the
  shell (`e2e/a11y-responsive.spec.ts`) **and a full-page sweep across all 22
  routes** with zero critical/serious violations (`e2e/a11y-sweep.spec.ts`; the
  third-party React Flow canvas is the only documented exclusion).
- **Visual-regression** snapshots of the shell (sidebar, command palette, mobile
  drawer) via Playwright (`e2e/visual.spec.ts`,
  baselines in `e2e/visual.spec.ts-snapshots/`).
- **Unit tests** (vitest) for the palette, breadcrumbs, modal behavior, and
  density.

**CI gates:** `tsc --noEmit`, `vitest`, `next build`, and the Playwright suites
(`test:e2e`) must pass.

Truly optional future ideas (not gaps): cross-platform visual baselines
(Docker/Chromatic), and per-component axe assertions in unit tests.
