# Supermixer Design Language

Supermixer copies the look and feel of the **current (2026) Supabase Studio** dashboard. The only deliberate change is the brand colour: **Piccadilly blue** replaces Supabase green.

This document was extracted from the Supabase source (`github.com/supabase/supabase`, `master`, November 2026, Apache-2.0):

| Source | What it holds |
|---|---|
| `packages/ui/build/css/source/semantic.css` | OKLCH semantic colour system |
| `packages/ui/build/css/source/compat.css` | Legacy token names |
| `packages/ui/build/css/themes/{dark,light}.css` | Per-theme inputs, brand/warning/destructive scales |
| `packages/config/css/{theme,utilities,variants,shadows,animations}.css` | Tailwind v4 mapping and utilities |
| `packages/config/typography.css`, `apps/studio/styles/{globals,fonts}.css` | Type scale and fonts |
| `packages/ui/src/components/**` | Button, Badge, Input, Dialog, Sidebar… |
| `apps/studio/components/{interfaces/Sidebar.tsx, layouts/**}` | App shell |

The implementation lives in `web/src/styles/tokens/*` and `web/src/components/ui/*`. Ported files name their source in a header comment. You can see every component live at `/design-system` in the running app.

---

## 1. Principles

1. **Flat, quiet chrome.**
   - 1px borders separate regions.
   - Shadows appear only on floating surfaces: popovers, menus, dialogs.
   - Colour is reserved for meaning: brand for primary actions and active states, amber for warnings, red for destructive actions.
2. **Dense, small type.** The main UI size is 13px. Body text uses weight 450.
3. **Dark first.** Dark is the default theme, and light is a full peer. Both are derived from the same inputs.
4. **One hue drives everything.** Neutrals carry a faint tint of the brand hue. Status colours lean slightly toward it but stay recognisably amber, red or violet.
5. **Same names as Studio.** Tailwind classes match Studio's (`bg-surface-100`, `text-foreground-light`, `border-strong`…), so Studio markup can be ported almost verbatim.

---

## 2. Brand colour

| | |
|---|---|
| Name | Piccadilly blue (London Underground Piccadilly line, TfL digital colour standard; Pantone 072) |
| Default | `#0019A8` |
| Configured by | `appearance.brand_color` in `.env.toml`. Takes effect on restart, with no rebuild. |

### How it flows through the system

The Go backend (`backend/internal/theme`) converts `appearance.brand_color` to OKLCH. It then serves `/theme.css`, which defines `--sm-*` variables. The token files read those variables and fall back to Studio's own values if `/theme.css` is missing.

| Generated variable | Studio token it feeds | Derivation |
|---|---|---|
| `--sm-brand-hue` | `--hue` | OKLCH hue of the brand. A grey brand (C < 0.02) falls back to Studio's 157.5. |
| `--sm-brand` | `--primary-solid` | The **exact** brand colour, used for solid primary buttons in both themes. |
| `--sm-brand-foreground` | `--primary-solid-foreground` | Studio's light ink `oklch(0.95 …)`, or near-black when that fails 4.5:1 on the brand. |
| `--sm-dark-primary` | `--primary` (dark) | Studio anchor `oklch(0.76 0.15 h)`. Lightened until it reaches ≥ 4.5:1 on the dark card surface. |
| `--sm-light-primary` | `--primary` (light) | Studio anchor `oklch(0.525 0.12 h)`. Darkened until ≥ 4.5:1 on the light canvas. |
| `--sm-{dark,light}-primary-bright` | `--primary-bright` | `max(L, 0.7)`, `max(C, 0.15)`, as in Studio. Used for focus rings, switches and selected borders. |
| `--sm-{dark,light}-brand-{default,600…200}` | `--brand-*` | Each step of Supabase's green scale, keeping its OKLCH lightness and chroma but at the brand hue. |

All conversions map chroma into the sRGB gamut while holding lightness and hue, so the brand never drifts toward purple or teal.

### Resulting palette for `#0019A8`

| Token | Dark | Light |
|---|---|---|
| primary-solid (buttons) | `#0019a8` | `#0019a8` |
| primary-solid-foreground | `#edeef0` | `#edeef0` |
| primary (links, ink) | `#8ab0ff` | `#4667af` |
| primary-bright (rings) | `#8ab0ff` | `#6e9bfb` |
| brand-default | `#8bb0ff` | `#8bb0ff` |
| brand-600 | `#b0caff` | `#4666ab` |
| brand-500 | `#344f8b` | `#6896fa` |
| brand-400 | `#182746` | `#aec9ff` |
| brand-300 | `#13203b` | `#cedeff` |
| brand-200 | `#040711` | `#e5eeff` |

### Usage rules

| Use | Token |
|---|---|
| Primary button fill | `bg-primary-solid` |
| Links, active text, small indicators | `text-primary` |
| Focus rings, switches, selected borders | `primary-bright` |
| Success badges, "healthy" states | `brand-*` scale (Studio's convention) |

**Do not use `#0019A8` itself as text on dark backgrounds.** Its contrast on `#121212` is under 2:1; use `text-primary` instead.

---

## 3. Colour tokens

All neutrals are computed in OKLCH from a few per-theme inputs.

| Input | Dark | Light |
|---|---|---|
| `--surface` (canvas lightness) | 0.19 | 0.995 |
| `--chroma` (neutral tint) | 0.005 | 0 |
| `--surface-hue-offset` | 0 (brand hue) | 180 (complement) |
| `--foreground-lightness` | 0.95 | 0.10 |
| `--elevation-step` | 0.025 | 0.024 |
| `--contrast` | 0.5 | 0.53 |

### Semantic tokens and their Tailwind classes

| Token | Class(es) | Role |
|---|---|---|
| `--background` | `bg-background`, `bg-dash-sidebar`, `bg-studio` | App canvas, sidebar, page background |
| `--card` (+1 elevation) | `bg-surface-75`, `bg-surface-100`, `bg-card` | Panels and cards |
| `--popover` (+1.5) | `bg-popover`, `bg-dialog` | Dialogs, sheets |
| `--secondary` (+2) | `bg-surface-300`, `bg-overlay` | Menus, popovers, command palette |
| `--muted` (translucent) | `bg-surface-200`, `bg-muted` | Hover rows, subtle fills |
| `--accent` (translucent) | `bg-selection`, `bg-accent`, `bg-overlay-hover` | Selected and hovered items |
| `--field` | `bg-field` | Sunk text inputs |
| `--foreground` | `text-foreground` | Primary text |
| `--muted-foreground` | `text-foreground-light` | Secondary text, labels |
| `--tertiary-foreground` | `text-foreground-lighter`, `text-foreground-muted` | Hints, icons, placeholders |
| `--border` | `border`, `border-default`, `border-muted` | Region dividers |
| `--input` | `border-control`, `border-strong` | Control outlines |
| `--border-stronger` | `border-stronger` | Emphasised outlines |
| `--border-control-hover` | `border-control-hover` | Control hover outline |
| `--warning` | `bg-warning`, `text-warning-600`, `warning-200…600` | Warnings |
| `--destructive` | `bg-destructive`, `text-destructive`, `destructive-200…600` | Errors, delete |
| `--info` | `bg-info` | Informational (violet) |
| `--ring` | `ring-ring` | Focus ring (`primary-bright` at 55%) |

Status hues are amber (75°), red (25°) and violet (288°). Each shifts 15% of the way toward the brand hue and is clamped so it stays in its category. For Piccadilly blue the result is amber 91°, red 41° and violet 302°.

---

## 4. Typography

The fonts are the same as Studio's. All three are bundled locally (Fontsource, SIL OFL) and never fetched from a CDN.

| Role | Family | Tailwind |
|---|---|---|
| UI and body | **Inter** (variable, 100–900, with italic) | `font-sans` (default) |
| Headings h1–h6 | **Manrope** (variable, 200–800) | `font-heading` |
| Code, IDs, meta labels | **Source Code Pro** (variable) | `font-mono` |

- Body text weight is **450** (`--font-weight-normal`).
- Headings use `font-semibold`.
- Use `font-medium` (500) for emphasis.

| Class | Size | Use |
|---|---|---|
| `text-xs` | 12px | Captions, menu items, badges, tiny buttons |
| `text-sm` | **13px** | Default UI text: tables, forms, menus |
| `text-base` | 15px | Body copy, dialog titles |
| `text-lg` | 16px | Sheet titles |
| `text-xl` | 18px | Section headings (`heading-section`) |
| `text-2xl` | 22px | Page titles (`heading-title`, tracking-tight) |
| `text-grid` | 13px | Data grids |

**Helper utilities**

| Utility | Applied to / looks like |
|---|---|
| `heading-title` | h1 |
| `heading-section` | h2 |
| `heading-subSection` | h3 |
| `heading-default` | h4 and h5 (`text-sm font-medium`) |
| `heading-compact` | h6 |
| `heading-meta` | mono, uppercase, `text-xs`, tracking-wider. Used for group labels and table headers. |
| `text-link` | `foreground-light`, underlined with offset 4 |

---

## 5. Shape, space and elevation

**Radius.** Studio scales Tailwind's radii by 4/3:

| Class | Size | Use |
|---|---|---|
| `rounded-sm` | 5.3px | Small elements |
| `rounded-md` | **8px** | Controls, menus |
| `rounded-lg` | 10.7px | Dialogs |
| `rounded-panel` | 6px | Cards |
| `rounded-full` | — | Badges, the search pill |

Larger buttons get proportionally rounder corners: `radius-md × (1 + (h/26 − 1) × 0.35)`.

**Spacing** uses Tailwind defaults plus three named values:
- `spacing-card`: 16px (card padding)
- `spacing-content`: 21px
- page containers: `max-w-3xl`, `max-w-5xl` or `max-w-7xl`, each with `px-8`

**Shadows**
- **Controls** use `control-surface-shadows`: a 1px drop shadow plus inset edge highlights, stronger in dark mode. Default buttons and selects are "raised" (`raised-control-surface`).
- **Floating surfaces** use `floating-surface-shadow-sm` (tooltips) or `floating-surface-shadow-md` (menus, popovers, dialogs). These are layered black shadows plus a 1px ring, five times stronger in dark mode.
- **Everything else** is flat, with borders only.

**Motion**
- `ease-enter`: `cubic-bezier(0.16,1,0.3,1)`, used for overlays appearing.
- `ease-move`: `cubic-bezier(0.87,0,0.13,1)`.
- Buttons press to `scale(0.97)`. Transitions last 100–300ms.
- Overlays fade and zoom from 95%.

---

## 6. Components

| Component | Spec |
|---|---|
| **Button** | Base: `rounded-md border font-medium`, icon gap 8px, focus ring. **Variants:**<br>• `primary`: brand-solid fill, light text, raised shadow<br>• `default`: raised neutral plate<br>• `secondary`: inverted, foreground fill<br>• `outline`<br>• `dashed`<br>• `text`: transparent, accent on hover<br>• `link`: primary text<br>• `warning`<br>• `danger`<br>**Sizes:** tiny 26px (`text-xs`, `px-2.5`, the default), small 34px, medium 38px, large 42px, xlarge 50px. Icons are 14, 18, 20, 20 and 24px respectively and use `foreground-lighter`. Loading shows a spinner and disables the button. |
| **Badge** | Pill, `text-[9px]` uppercase, `tracking-[0.07em]`, `px-[5.5px] py-[3px]`. Variants: `default` (outline), `success` (brand), `warning`, `destructive`, `secondary`. |
| **Input / Textarea** | `bg-field`, `border-control`, hover `border-control-hover`. Default size small (34px, `text-sm`). Invalid: `destructive-200` fill, `destructive-400` border. |
| **Select** | Raised plate trigger with a chevron. Content on `bg-overlay` with `floating-surface-shadow-md`. Items are `text-sm` with a check indicator. |
| **Switch** | Pill. Checked uses `primary-bright`; unchecked uses `border`/`border-strong`. White gradient thumb. Sizes small, medium and large. |
| **Dialog** | Overlay `bg-black/40` with `backdrop-blur-xs`. Panel `bg-dash-sidebar`, `rounded-lg`, `floating-surface-shadow-md`. Widths tiny–xxlarge (`max-w-xs`…`6xl`). Header, sections and a bordered footer with right-aligned actions. Title `text-base`. Close "×" at 20% opacity. |
| **Sheet** | Slides from the right (default). `bg-popover` with a bordered header and footer. Overlay `bg-alternative/90`. |
| **DropdownMenu** | Content `w-64`, `bg-overlay`, `p-1`. Items `text-xs`, `py-1.5 px-2`, `rounded-item`, focus `bg-overlay-hover`. Labels in `foreground-lighter`. Separators `bg-border-overlay`. |
| **Popover / Command** | `bg-overlay`, floating shadow. The command input has a search icon and bottom border. Group headings `text-xs` in `foreground-muted`. |
| **Tooltip** | `text-xs`, `px-2 py-1.5`, `bg-alternative` (`bg-card` in dark), `floating-surface-shadow-sm`. |
| **Tabs** | Underline style: `text-sm` in `foreground-lighter`. The active tab gets `text-foreground` and a 1px foreground underline. |
| **Card** | `bg-surface-100`, 1px border, `rounded-panel`. Header and footer separated by borders, with 16px horizontal padding. |
| **Table** | Header cells use mono uppercase `text-xs` in `foreground-lighter`. Rows have a bottom border and hover `bg-surface-200`. |
| **Toast** | Sonner, bottom-right, on `bg-overlay` with a floating shadow. |
| **Skeleton** | Shimmer gradient from `muted` to `accent`. |

---

## 7. Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ ≋ Supermixer / ▦ Org ⇕ / Project ⇕                     [Search… ⌘K] ◯ │  header 48px, border-b
├────┬────────────────┬────────────────────────────────────────────────┤
│ ⌂  │ Database       │                                                │
│ ▦  ├────────────────┤   Page title (heading-title, pt-12)            │
│ >_ │ Group label    │                                                │
│────│  Item          │   Content in max-w-5xl / 7xl, px-8             │
│ ≡  │ ▌Active item   │                                                │
│ …  │  Item          │                                                │
│────│                │                                                │
│ ⚙  │                │                                                │
│ ▯  │                │                                                │
└────┴────────────────┴────────────────────────────────────────────────┘
 rail 48px            product menu 256px
 (208px expanded)
```

- **Header** (`LayoutHeader`): 48px tall with a bottom border, left padding 16px.
  - Left side: logo, then a 16px slanted-stroke divider (`text-border-stronger`), then the organization switcher, another divider, and the project switcher.
  - Each switcher is a link plus a text-button with a chevrons icon, opening a popover command list (search, items with a check on the current one, then "All …" and "New …").
  - Right side: a pill "Search…" trigger (26px, `bg-field`, `rounded-full`, ⌘K hint), then the account menu (theme radio, preferences, log out).
- **Icon rail** (`Sidebar`): 48px wide, `bg-dash-sidebar`, right border.
  - On hover it expands over the content to 208px. The footer menu offers *Expanded*, *Collapsed* or *Expand on hover* (the default), and the choice is remembered per browser.
  - Items are 32px tall, `rounded-md`, `px-1.5`, with 20px icons in `foreground-lighter`. Hover uses `sidebar-accent/50`. Active items use `bg-sidebar-accent`, `font-medium` and `text-foreground`.
  - When collapsed, tooltips appear instantly to the right.
  - Groups are separated by inset dividers: Overview + Table Editor + SQL Editor | Database, Authentication, Storage, Edge Functions, Realtime | Advisors, Observability, Logs, Integrations | Project Settings.
  - Organization rail: Projects, Team, Integrations, Usage, Organization Settings.
- **Product menu**: 256px wide with a right border.
  - A 48px title row (`text-sm`, `px-6`).
  - Groups padded `py-5` with 1px dividers between them. Group labels are `text-sm` in `foreground-lighter`.
  - Items are pills: `px-3 py-[3px] rounded-md text-sm text-foreground-light`. The active item gets `bg-sidebar-accent text-foreground font-semibold`.
- **Pages**: `PageHeader` (title plus optional description and actions), then content in `PAGE_SIZE_CLASSES` containers.
  - Settings pages stack `SettingsSection`s (h3 title + description + Card) with 40px gaps.
  - Project and org lists use 1–3 column card grids.

---

## 8. Icons

- **Set:** Material Icons, **Two-Tone** style. This is the legacy set; Material Symbols has no two-tone style.
- **Source:** the `@material-design-icons/svg` package's `two-tone/` folder (Apache-2.0). Each icon is imported as a React component through `vite-plugin-svgr` and bundled locally, with no icon font or CDN.
- **App icon:** `graphic_eq`, kept as `web/src/assets/icons/graphic_eq.svg`. The server also serves `/favicon.svg`, drawn in the brand colour (with a lighter ink for dark browser chrome).
- **Rendering:** `createIcon` (`web/src/components/icon.tsx`) sets `fill="currentColor"`. The secondary tone keeps its built-in `opacity=".3"`, so both tones follow the text colour.
- **Accessibility:** icons are decorative (`aria-hidden`) unless given a `label`.
- **Sizes:**
  - 20px in the rail and menus
  - 14px inside tiny buttons and breadcrumb leading icons
  - 16px in dropdown and command items
  - 24px or more for empty states
- **Colour:** default `text-foreground-lighter`, changing to `text-foreground` on hover or when active.

### Studio (Lucide) → Material mapping

| Use | Studio | Material |
|---|---|---|
| Project overview | Home | `home` |
| Table Editor | TableEditor | `table_chart` |
| SQL Editor | SqlEditor | `terminal` |
| Database | Database | `storage` |
| Authentication | Auth | `group` |
| Storage | Storage | `inventory_2` |
| Edge Functions | EdgeFunctions | `functions` |
| Realtime | Realtime | `sensors` |
| Advisors | Lightbulb | `lightbulb` |
| Observability | Reports | `insights` |
| Logs | List | `receipt_long` |
| Integrations | Blocks | `extension` |
| Settings | Settings | `settings` |
| Org projects | Boxes | `widgets` |
| Team | Users | `groups` |
| Usage | ChartArea | `data_usage` |
| Sidebar control | PanelLeftDashed | `view_sidebar` |
| Switcher trigger | ChevronsUpDown | `unfold_more` |
| Select chevron | ChevronDown | `expand_more` |
| Search | Search | `search` |
| Account | User | `account_circle` |
| Close | X | `close` |
| Check | Check | `check` |
| Theme | Moon / Sun / Monitor | `dark_mode` / `light_mode` / `desktop_windows` |

When adding an icon, add it to `web/src/components/icons.ts` and to this table.

---

## 9. Theming behaviour

- `appearance.default_theme` (`dark`, `light` or `system`, default `light`) is written into `index.html` by the server and applies to users who haven't chosen a theme.
- Each user's choice is made under Account › Appearance (or the user menu) and saved on their account (`users.theme`), so it follows them across browsers. The browser keeps a copy in `localStorage["supermixer.theme"]` for first paint; it is replaced from the account when the profile loads and cleared on sign-out.
- An inline script in `index.html` sets `data-theme` before first paint, so the page never flashes the wrong theme. `system` follows `prefers-color-scheme` live.
- Dark-mode variants use `@custom-variant dark` on `[data-theme*='dark']`, as in Studio.
- Theme tokens are resolved on `<html>`. A nested `data-theme` does **not** re-theme a subtree. Previews of the other theme, such as the theme picker, use fixed colours.

---

## 10. Accessibility checks

These are enforced by the Go tests in `backend/internal/theme`:
- Primary ink (`--primary`) reaches ≥ 4.5:1 on the canvas in both themes, for any `appearance.brand_color`.
- Text on solid brand buttons reaches ≥ 4.5:1, or uses the higher-contrast of light and dark ink.
- Focus is always visible: `focus-ring` (2px `ring`, 2px offset) on controls, and `focus-inset` (an outline) inside dense lists.
