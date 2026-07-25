# MineUI v2 — Theme Token Contract (binding)

Phase-2 deliverable from the theme coordinator. This is the contract downstream
specialists implement against. Source spec: `docs/aesthetic-directions.md`.
Implementation lives in `app/globals.css` + `app/themes/*.css` (one file per theme).

**Decision of record:** all four Phase-1 directions ship as selectable themes;
**Deepslate & Emerald is the default** and the `:root` fallback.

---

## 1. Theme registry (for the picker UI)

| id (`data-theme`) | Display name | One-liner |
|---|---|---|
| `deepslate` | Deepslate & Emerald | Deepslate stone, emerald signal — the tool Mojang would ship. *(default)* |
| `phosphor` | Phosphor Amber | Near-black ops console with an amber phosphor glow. |
| `quantum` | Quantum Fluidity | Deep-space black, cyan signal, violet glow — the I4C look. |
| `softglass` | Soft Glass | Calm, rounded, native-grade — one warm apricot accent. |

- Switching mechanism is unchanged: set `data-theme="<id>"` on `<html>` + persist
  to localStorage. `deepslate` needs no attribute (it is `:root`), but setting it
  explicitly is fine.
- **Legacy ids** (`emerald`, `ember`, `aether`, `void`) have no blocks anymore and
  resolve to `:root` = deepslate. Nothing breaks between waves; the picker keeps
  "working" until it's updated.

## 2. Hard rules (all specialists)

1. Components never hardcode hex/oklch/rgb literals. Tokens only.
2. Never set HeroUI's `color-mix()`-derived vars — `--*-hover`, `--*-soft`,
   `--*-soft-hover`, `--background-secondary/tertiary`, `--border-secondary/tertiary`,
   `--separator-secondary/tertiary`, `--field-hover/border-hover/border-focus`,
   `--field-radius`. They derive from the base tokens automatically.
   (One sanctioned exception exists: quantum sets `--danger-soft-foreground`, a
   settable non-derived var — see §4 quantum notes.)
3. `--radius` is the one shape knob per theme. All HeroUI radius steps and
   `--field-radius` (= radius × 1.5) derive from it. Do not set per-component radii.
4. **Monocraft is numerals-only** (player count, TPS, ping, download %) via the
   `.font-pixel-num` class, and only deepslate actually renders it (other themes
   map the class to their mono). Monocraft on headings, labels, buttons, or body
   text anywhere is a contract violation.
5. Theme-specific decor tokens (`--quantum-violet`, `--quantum-violet-text`,
   `--shadow-quantum`) exist **only** inside `[data-theme="quantum"]`. Never
   reference them without a quantum guard; the provided `.shadow-quantum` utility
   is already safe (falls back to `none`).
6. New motion literals (`transition={{ duration: … }}`) are forbidden — consume
   the `--motion-*` vars (§6).

## 3. Token vocabulary

Every theme block defines this full set (HeroUI v3.2.2 semantic set + our
extensions). Extensions beyond stock HeroUI: `--subtle`, `--font-sans/mono/
display/numeric`, `--motion-*`, and quantum's decor tokens.

`--background --foreground`
`--surface(+-foreground) --surface-secondary(+-fg) --surface-tertiary(+-fg)`
`--overlay(+-fg) --muted --subtle --default(+-fg)`
`--accent(+-fg) --success(+-fg) --warning(+-fg) --danger(+-fg)`
`--field-background --field-foreground --field-placeholder --field-border --field-border-width`
`--segment(+-fg) --border --separator --focus --link --backdrop --scrollbar`
`--radius --surface-shadow --overlay-shadow --field-shadow`
`--font-sans --font-mono --font-display --font-numeric`
`--motion-fast --motion-base --motion-slow --motion-ease`

Server-state mapping (unchanged, every theme): `running → success`,
`starting/stopping → warning`, `crashed → danger`, `stopped/not-created →
muted/default` (gray, never red — stopped is normal).

## 4. Token tables per theme

### deepslate (default) — `app/themes/deepslate.css`

| Token | Value | CR | Notes |
|---|---|---|---|
| `--background` | `#0F1214` | — | deepslate near-black |
| `--foreground` | `#E9EDEA` | 15.9:1 bg / 14.7 surface / 13.2 overlay | |
| `--surface` / sec / tert | `#171B1E` / `#1B2023` / `#1F2429` | — | |
| `--overlay` | `#1F2429` | — | |
| `--muted` | `#9BA8A0` | 7.6:1 bg, 7.0 surface | |
| `--subtle` | `#5F6B65` | 3.4:1 | labels/disabled only, never body |
| `--default` | `#212729` | — | fg = foreground |
| `--accent` | `#3DDC84` / fg `#08110C` | 10.5:1 bg; fg-on-fill 10.7:1 | emerald |
| `--success` | `#3DDC84` / fg `#08110C` | 10.5:1; 10.7:1 | success IS accent (deliberate) |
| `--warning` | `#F7B733` / fg `#191104` | 10.5:1; 10.5:1 | glowstone gold |
| `--danger` | `#FF5D5D` / fg `#1C0808` | 6.3:1; 6.4:1 | redstone; text-safe |
| field | bg `#14181B`, border `#2A3138`, width 1px, placeholder = muted | — | darker "MC slot" inset |
| `--segment` | `#232A2F` | — | |
| `--border` / `--separator` | `#2A3138` / `#242B31` | — | |
| `--focus` / `--link` | accent | — | |
| `--backdrop` / `--scrollbar` | `rgba(0,0,0,.6)` / `#39424A` | — | |
| `--radius` | `0.25rem` (4px) | — | field-radius derives to 6px |
| `--surface-shadow` | `inset 0 1px 0 rgb(255 255 255/.04)` | — | the MC slot bevel |
| `--overlay-shadow` | bevel + `0 12px 32px rgb(0 0 0/.45)` | — | ⚠ deviation from Phase-1 "shadows never": floating menus need lift; surfaces stay flat |
| `--field-shadow` | `inset 0 1px 2px rgb(0 0 0/.35)` | — | slot inset |
| fonts | sans **Inter Variable** · mono **JetBrains Mono Variable** · display = sans · numeric **Monocraft** | | |
| motion | 120 / 180 / 260 ms · `cubic-bezier(.2,0,0,1)` | | chunky, instant; progress bars may additionally use `steps(20)` (motion-specialist) |

### phosphor — `app/themes/phosphor.css`

| Token | Value | CR | Notes |
|---|---|---|---|
| `--background` | `#0B0C0E` | — | neutral, no cast |
| `--foreground` | `#DEE3E7` | 15.1:1 / 14.4 surface / 13.6 overlay | dimmed white — terminal, not paper |
| `--surface` / sec / tert | `#111316` / `#14171A` / `#17191D` | — | |
| `--overlay` | `#17191D` | — | |
| `--muted` | `#8B949E` | 6.4:1 bg, 6.1 surface | |
| `--subtle` | `#5B636D` | 3.2:1 | ⚠ changed from spec `#545C66` (2.9:1 — failed 3:1) |
| `--default` | `#1B1F24` | — | |
| `--accent` | `#FFB224` / fg `#1C1300` | 10.9:1; 10.2:1 | the ONE vivid color |
| `--success` | `#3FB950` / fg `#041008` | 7.7:1; 7.6:1 | quiet green |
| `--warning` | `#D29922` / fg `#171002` | 7.8:1; 7.5:1 | duller than accent by design (luminance separates them) |
| `--danger` | `#F85149` / fg `#1B0604` | 5.8:1; 5.8:1 | |
| field | bg `#0E1013`, border `#22262B`, width 1px | — | |
| `--segment` | `#1D2126` | — | |
| `--border` / `--separator` | `#22262B` / `#1D2126` | — | hairlines are the aesthetic |
| `--focus` / `--link` | accent | — | |
| `--backdrop` / `--scrollbar` | `rgba(0,0,0,.65)` / `#333A42` | — | |
| `--radius` | `0.375rem` (6px) | — | uniform everywhere |
| shadows | all `0 0 0 0 transparent` | — | zero shadows; borders + bg steps only |
| fonts | sans **IBM Plex Sans Variable** · mono **IBM Plex Mono** (400/500/600) · display = **mono** · numeric = mono | | mono is promoted: stats, chips, timestamps, section labels |
| motion | 100 / 140 / 180 ms · `cubic-bezier(0,0,.2,1)` | | opacity/clip only; nothing scales, springs, or loops |

⚠ Phase-1's compact density (p-3, size="sm", 13px base) is **dropped** — global
density is fixed across themes by leader constraint.

### quantum — `app/themes/quantum.css`

Palette is lifted from i4c.studio (`app/globals.css` + `lib/palette.ts`); the
portfolio remains the source of truth — never invent variants here.

| Token | Value | CR | Notes |
|---|---|---|---|
| `--background` | `#000102` | — | eclipse |
| `--foreground` | `#F3F5F9` | 19.1:1 / 17.8 surface / 16.6 overlay | snow |
| `--surface` / sec / tert | `#0B0D14` / `#10131A` / `#13161D` | — | |
| `--overlay` | `#13161D` | — | |
| `--muted` | `#828690` | 5.7:1 bg, 5.3 surface | |
| `--subtle` | `#5C6069` | 3.3:1 | |
| `--default` | `#171A22` | — | |
| `--accent` | `#00D1FF` / fg `#000102` | 11.5:1; 11.5:1 | quantum cyan |
| `--success` | `#22C373` / fg `#01130A` | 9.1:1; 8.3:1 | |
| `--warning` | `#EBA941` / fg `#1A1204` | 10.2:1; 9.1:1 | |
| `--danger` | `#C72C4C` / fg `#F3F5F9` (snow) | 3.9:1; 4.9:1 | fills/signals only — never small text (see below) |
| `--danger-soft-foreground` | `#F0718A` | 7.4:1 bg, 6.9 surface | sanctioned override: soft-variant chips/text render this instead of the 3.6:1 raw danger |
| `--quantum-violet` | `#7B2DFF` | 3.7:1 | glows/gradients/fills ONLY, quantum-guarded |
| `--quantum-violet-text` | `#A082FF` | 7.1:1 | text-safe violet, quantum-guarded |
| field | bg `#0B0D14`, border `#1E2129`, width 1px | — | |
| `--segment` | `#1A1E27` | — | |
| `--border` / `--separator` | `#1E2129` / `#191C24` | — | |
| `--focus` / `--link` | accent | — | |
| `--backdrop` / `--scrollbar` | `rgba(0,1,2,.7)` / `#2A2E38` | — | |
| `--radius` | `0.625rem` (10px) | — | ⚠ refined from Phase-1 12px per leader constraint; keeps the 4/6/10/14 ramp distinct |
| `--surface-shadow` | transparent | — | ordinary cards flat |
| `--overlay-shadow` | `0 0 24px oklch(.79 .15 220/10%), 0 16px 40px rgb(0 0 0/.5)` | — | glow-tinged lift |
| `--shadow-quantum` | cyan+violet glow (see file) | — | hero/accented cards only, via `.shadow-quantum` |
| fonts | sans **Inter Variable** · mono **JetBrains Mono Variable** · display **Space Grotesk Variable** · numeric = mono | | |
| motion | 200 / 300 / 500 ms · `cubic-bezier(.22,1,.36,1)` | | fluid, cinematic; single-shot blooms, no infinite pulses |

### softglass — `app/themes/softglass.css` (ships solid-surface)

| Token | Value | CR | Notes |
|---|---|---|---|
| `--background` | `#151519` | — | warm graphite |
| `--foreground` | `#EDEDF0` | 15.6:1 / 14.4 surface / 12.9 overlay | |
| `--surface` / sec / tert | `#1D1D22` / `#222228` / `#26262C` | — | solid (frost deferred) |
| `--overlay` | `#26262C` | — | always solid, even post-vibrancy |
| `--muted` | `#A3A3AD` | 7.3:1 bg, 6.7 surface | |
| `--subtle` | `#71717C` | 3.8:1 | |
| `--default` | `#28282F` | — | |
| `--accent` | `#F5A97F` / fg `#2A1410` | 9.4:1; 9.0:1 | warm apricot |
| `--success` | `#62D796` / fg `#06170D` | 10.1:1; 10.3:1 | soft mint |
| `--warning` | `#E8C268` / fg `#1B1403` | 10.7:1; 10.8:1 | honey |
| `--danger` | `#ED6A6D` / fg `#1E0708` | 6.0:1; 6.3:1 | soft coral |
| field | bg `#232329`, border `rgba(255,255,255,.08)`, width 1px | — | soft raised |
| `--segment` | `#2C2C33` | — | |
| `--border` / `--separator` | `rgba(255,255,255,.08)` / `rgba(255,255,255,.06)` | — | translucent hairlines |
| `--focus` / `--link` | accent | — | |
| `--backdrop` / `--scrollbar` | `rgba(0,0,0,.5)` / `#3D3D46` | — | |
| `--radius` | `0.875rem` (14px) | — | ⚠ refined from Phase-1 12px per leader constraint; field-radius derives to 21px |
| `--surface-shadow` | `0 1px 2px rgb(0 0 0/.25), 0 8px 24px rgb(0 0 0/.35)` | — | shadows carry elevation |
| `--overlay-shadow` | `0 2px 8px rgb(0 0 0/.3), 0 24px 60px rgb(0 0 0/.5)` | — | |
| `--field-shadow` | `0 1px 2px rgb(0 0 0/.2)` | — | |
| fonts | sans **Figtree Variable** · mono **Commit Mono** (400/500) · display = sans · numeric = mono | | sentence-case labels preferred (component wave) |
| motion | 180 / 280 / 420 ms · `cubic-bezier(.34,1.3,.64,1)` | | spring-approximating overshoot; true springs (stiffness ~220, damping ~26) welcome in Motion presets |

## 5. Fonts

All fonts are offline-bundled (static export, zero runtime fetches): fontsource
packages imported in `app/layout.tsx`; Monocraft vendored at
`app/fonts/Monocraft-basic-latin.woff2` (OFL license alongside; subset to Basic
Latin, 5.5 KB) with its `@font-face` in `app/globals.css`.
Total woff2 shipped: **~724 KB** across all four themes.

Classes / utilities:

| Class | Resolves to | Use for |
|---|---|---|
| `font-sans` (Tailwind) / body default | `var(--font-sans)` | everything by default |
| `font-mono` | `var(--font-mono)` | logs, RCON, code, paths |
| `font-display` | `var(--font-display)` | headings, card headers, section labels |
| `.font-pixel` *(legacy alias)* | `var(--font-display)` | **do not add new uses** — existing card headers only; migrate to `font-display`, then delete the class |
| `.font-pixel-num` | `var(--font-numeric)` + tabular lining numerals | stat **values** only: player count, TPS, ping, download % |

Press Start 2P and the Geist family are **gone** (packages/imports removed). The
old `.font-pixel` class no longer renders a pixel font anywhere — it is display-font
driven per theme. **HARD RULE:** Monocraft appears exclusively through
`.font-pixel-num`, and only deepslate maps it; it must never be applied to
headings, labels, buttons, or body text in any theme.

## 6. Motion var semantics (for the motion-specialist)

Per-theme values in §4. Semantics:

- `--motion-fast` — micro-feedback: hover/press states, focus rings, chip color swaps.
- `--motion-base` — standard transitions: card mount, list item enter, tab switch, toast in/out.
- `--motion-slow` — large moves: modal/sheet enter, page-level transitions, one-shot signature moments.
- `--motion-ease` — the default easing for all of the above in that theme.

Consume via CSS `transition: x var(--motion-base) var(--motion-ease)` or read
`getComputedStyle` / build Motion presets keyed off `data-theme`. Signature
moments per theme (implement in the motion wave, not here): deepslate `steps(20)`
progress + 0.96→1 place-pop; phosphor block-cursor blink (1.06s step) + one-line
log slide; quantum single-shot cyan bloom on start; softglass spring bottom-sheet.
No infinite pulse loops in any theme.

## 7. Deferred follow-ups (do not implement this wave)

1. **Soft Glass vibrancy**: Tauri window vibrancy (macOS materials / Windows Mica;
   nothing reliable on Linux) + frosted surfaces (`rgba(255,255,255,0.045)` over
   `backdrop-filter: blur(20px) saturate(1.4)`). Current solid hexes are the
   mandated fallbacks and stay as such. Layering rule when it lands: only one
   frosted level; overlays go solid `--overlay`.
2. **Soft Glass light variant**: bg `#F4F2EF`, fg `#26262B`, accent darkened to
   `#C56A3D`; full token QA pass required. Also decide the project-wide light-mode
   strategy then (today: dark-only, `color-scheme: dark` per theme).

## 8. Downstream instructions

**heroui-specialist**
- Header/navbar revamp: implement against §9 (binding header contract; the
  `--header-*` / `--nav-*` vars are already in every `app/themes/*.css`).
- Update the Navbar/settings picker to the §1 registry (ids, display names,
  one-liners). Old ids in localStorage must be migrated or simply left to fall
  back (they already resolve to deepslate).
- Toasts: `.ui-toast` now maps to `--overlay` / `--overlay-shadow` / `--radius` /
  `--font-sans`. If you replace it with sonner theme props, keep exactly those
  token mappings.
- State chips: use HeroUI `success/warning/danger` semantic colors — they now
  resolve per-theme. Soft-variant danger in quantum is already handled by the
  `--danger-soft-foreground` override; don't work around it.
- Watch items: components that hardcode `rounded-full` (Chip/Avatar/circular
  progress) under deepslate's 4px radius; phosphor wants mono `font-family` on
  Chip/Table cell slots (`var(--font-display)`).

**motion-specialist**
- Consume `--motion-fast/base/slow/ease` (§6). Build `app/lib/motion.ts` presets
  reading these; migrate all inline `transition={{ … }}` literals.

**tailwind-specialist**
- Semantic var names are unchanged (`--background --surface --overlay --muted
  --accent --border --separator --field-*` …) — your `text-[var(--x)]` →
  semantic-utility migration lands cleanly.
- The `@theme inline` bridge in `globals.css` guarantees these utilities:
  `background foreground surface overlay muted subtle accent accent-foreground
  success(-foreground) warning(-foreground) danger(-foreground) border separator`
  as `bg-* / text-* / border-*`, plus `font-sans font-mono font-display`.
  HeroUI's own theme utilities (`surface-secondary`, soft variants, …) also work.
- New tokens available to use: `--subtle` (`text-subtle`) for tertiary text
  currently faked with opacity.

**Compatibility aliases still in place (cleanup after page migration):**
- `.font-pixel` class + `--font-pixel` Tailwind font alias → `var(--font-display)`
  (used by ~25 call sites across pages/components).
- Legacy theme ids falling back to `:root`.
- No other legacy vars survive: the old preset blocks and `--font-geist-*` refs
  were removed; all vars referenced by current pages (`--muted --accent
  --background --border --surface --foreground --field-background
  --field-border`) remain defined in every theme.

---

## 9. Header / navbar contract (binding — header revamp wave)

Amends this contract for the `app/components/Navbar.tsx` revamp. Owner
constraints: **desktop app — no hamburger, no drawer, no mobile menu, ever**
(the existing mobile drawer + hamburger toggle are DELETED); the window is
resizable, so the header degrades gracefully at narrow widths using
desktop patterns only. Each theme expresses a genuinely different header
*character* — structure/surface/behavior, not a tint swap — but through **one
shared component skeleton + the §9.4 vars**, never four component forks.

### 9.1 Shared skeleton

One `<header>` shell (plain element, not HeroUI `Surface` — `Surface` imposes
`--surface`, and `--header-bg` deliberately differs per theme), containing
three zones in a flex row, full window width (drop the current `max-w-6xl`
centering — this is an app chrome bar, not a web page), `padding-inline: 1rem`:

| Zone | Contents | Flex behavior |
|---|---|---|
| brand | `Logo` (28px) + wordmark (`font-display`, `text-accent`) linking `/` | fixed, `shrink-0` |
| nav | 8 nav items + (at narrow tiers) the "More" overflow `Menu` | center, `min-w-0`, the only zone that adapts |
| controls | sound mute · mode `ToggleButtonGroup` (icon-only, as today) · theme `Select` · Ko-fi `Popover` | fixed, `shrink-0` |

Shell CSS (all values from vars — no theme conditionals in TSX):

```css
position: sticky;
top: var(--header-inset);
margin-inline: var(--header-inset);
margin-bottom: var(--header-inset);
height: var(--header-height);
background: var(--header-bg);
backdrop-filter: blur(var(--header-blur));
border: var(--header-border-width) solid var(--header-border);
border-radius: var(--header-radius);
box-shadow: var(--header-shadow);
z-index: 40;
```

Plus two absolutely-positioned 1px full-width strips (top/bottom, inside the
radius): `background: var(--header-edge-top)` / `var(--header-edge-bottom)`.
They accept a solid color **or a gradient** (quantum uses a gradient — this is
why they are background strips, not borders). Transparent = invisible = free.

Nav item label: `font: var(--nav-label-weight) var(--nav-label-size)
var(--nav-label-font); letter-spacing: var(--nav-label-tracking);
text-transform: var(--nav-label-case)`. Inactive item text = `--muted`
(hover → `--foreground`). Active item: `background: var(--nav-active-bg);
color: var(--nav-active-fg); box-shadow: var(--nav-active-shadow);
border-radius: var(--nav-active-radius)` + an underline strip
(`height: var(--nav-indicator-height); background: var(--nav-indicator)`)
anchored to the bar's bottom edge — zero-height in every theme except
phosphor, so the one skeleton renders all four treatments.

`--navbar-height` in `globals.css` is now
`calc(var(--header-height) + 2 * var(--header-inset))` — `.page-main` keeps
working untouched in all four themes (softglass's detach gap counts above
and below the bar).

The old static radial-gradient "glow decal" behind the bar is **deleted**: it
was a quantum-flavored effect leaking into all four themes; quantum's glow now
lives in `--header-shadow`/`--header-edge-bottom` where it belongs.

### 9.2 Responsive tiers (window width, desktop-first)

Structural breakpoints are Tailwind screens defined in `globals.css`
(`@theme`, static — media queries can't read per-theme vars):
`header-full` = 1200px, `header-mid` = 900px, `header-min` = 700px.
CSS-only visibility (responsive variants), **no ResizeObserver / JS
measurement**. Minimum supported window width: 640px.

| Tier | Range | nav | controls |
|---|---|---|---|
| T1 | ≥ 1200px | 8 items, icon + label | sound · mode · theme Select (`w-48`) · Ko-fi |
| T2 | 900–1199px | 8 items, **icon-only** (Tooltip required, §9.6) | same minus Ko-fi |
| T3 | 700–899px | first 4 items (Dashboard, Status, Mods, Players) icon-only + **"More" overflow `Menu`** (Ellipsis trigger) holding RCON, Config, Backups, Settings as icon+label items | wordmark hidden (logo only) · sound · mode · theme Select `w-32` (truncating value, existing pattern) |
| T4 | 640–699px | "More" `Menu` holds **all 8** items | logo only · sound · mode · theme Select `w-32` |

Rules:
- The "More" overflow is a HeroUI `Menu` opened from an icon `Button` — a
  desktop toolbar-overflow pattern, **not** a drawer. It renders inline in the
  nav zone, popover placed `bottom start`.
- When the current route lives inside the overflow, the More **trigger** takes
  the full active treatment (`--nav-active-*`) and `aria-current` moves to the
  menu item inside.
- Ko-fi's ad-hoc `min-[1340px]` gate is replaced by T1 (`header-full:`); the
  1340px number came from the old `max-w-6xl` + full-label math that no longer
  exists.
- Priority order is the existing `navItems` array order; do not re-rank.

### 9.3 Per-theme header expression

| | deepslate — opaque slot-bar | phosphor — dense statusline | quantum — floating glow rail | softglass — detached glass bar |
|---|---|---|---|---|
| height | 56px | **48px** (densest) | **60px** (tallest) | 56px + 12px detach gap |
| surface | opaque `--surface`, no blur | opaque `= --background` (bar dissolves into the console) | `color-mix(surface 80%, transparent)` + 14px blur | `color-mix(surface 86%, transparent)` + 20px blur, 16px radius, 1px `rgba(255,255,255,.08)` border all around |
| edges | top bevel (inset shadow) + hard `#070a0b` bottom cut | `#22262b` hairlines top **and** bottom | cyan→violet gradient hairline bottom | none (real border carries the edge) |
| shadow | bevel only | none (theme rule) | cyan underglow `0 10px 32px -12px oklch(0.79 0.15 220/22%)` | soft lift, 2-layer |
| nav labels | sans 13px/500/0.01em | **mono 12px/500/0.08em UPPERCASE** | Space Grotesk 13px/500/0.02em | Figtree 13px/500, sentence case |
| active treatment | **pressed slot**: `#101519` well, inset shadow, emerald text, 4px slab | **2px amber underline** flush with bottom hairline, amber uppercase label, no fill | **glow capsule**: `#0a2833` pill (999px), cyan text, soft cyan halo | **raised capsule**: `--segment` pill (999px), foreground text, gentle shadow |

Softglass note: its header `backdrop-filter` blurs the app's **own scrolled
content** passing under the sticky bar — it does not depend on and does not
pre-empt the deferred §7 Tauri window-vibrancy work (which is about the
desktop showing through).

### 9.4 Header var contract

Every theme file defines the full set (already landed in `app/themes/*.css`;
values above). Components consume, never invent:

`--header-height --header-inset --header-bg --header-blur`
`--header-border --header-border-width --header-radius --header-shadow`
`--header-edge-top --header-edge-bottom`
`--nav-label-font --nav-label-size --nav-label-weight --nav-label-tracking --nav-label-case`
`--nav-active-bg --nav-active-fg --nav-active-shadow --nav-active-radius`
`--nav-indicator --nav-indicator-height`

These follow rule §2.1 (no literals in components) and are **not** bridged
into `@theme inline` — they style exactly one component; consume via
`var(--…)` in the header's own styles.

### 9.5 HeroUI mapping (decision: custom shell + primitives)

**Do not use the Pro Navbar/AppLayout blocks.** They are website-nav
skeletons: they bake in their own responsive collapse (hamburger/drawer —
exactly what the owner banned), their own surface styling, and a
marketing-page structure. The four-character surface treatment (edge strips,
detached glass, glow rail) needs a bespoke shell, and every control already
exists as a primitive. Build: plain `<header>` shell (§9.1) + HeroUI
`Button` (nav items + icon buttons), `ToggleButtonGroup` (mode), `Select`
(theme), `Menu` (More overflow), `Tooltip` (icon-only tiers), `Popover`
(Ko-fi), `Separator` (optional, between nav and controls zones in phosphor
only if implemented via `--separator` — do not hardcode).

### 9.6 Motion & a11y

Motion (within §6 semantics — no new literals):
- Active-treatment hand-off between items: shared-layout (`layoutId`) move at
  `--motion-fast` + `--motion-ease` for deepslate, `--motion-base` +
  `--motion-ease` for quantum and softglass (softglass may use the sanctioned
  spring preset instead). **Phosphor: no sliding** — its rule is "opacity/clip
  only"; the underline crossfades in at `--motion-fast`, no layout animation.
  Key the Motion preset off `data-theme` (sanctioned by §6).
- More-menu enter: HeroUI Menu default, aligned to `--motion-fast`/`--motion-ease`.
- No ambient loops in the header (§6 stands; the glow decal is deleted, not
  reanimated).

A11y:
- Icon-only nav items (T2–T4) and all icon-only controls get HeroUI `Tooltip`
  (~400ms delay) **and** keep a text `aria-label`; `aria-current="page"` stays
  on the active item wherever it renders (bar or More menu).
- Focus ring: `--focus` (= accent) at 2px offset 2 on all header
  interactives, including the active item (ring must remain visible over
  `--nav-active-bg`). Verified ≥ 3:1 vs every theme's `--header-bg`: emerald
  9.7:1, amber 10.9:1, cyan 10.7:1, apricot 8.7:1.
- Keyboard: items are buttons/links in DOM order (brand → nav → More →
  controls); the More `Menu` is React-Aria complete out of the box. No focus
  traps — the header is a plain landmark (`<header>` + `<nav>` around the
  item group).

Contrast (computed, WCAG 2.1):

| Pairing | deepslate | phosphor | quantum | softglass |
|---|---|---|---|---|
| inactive label `--muted` on `--header-bg`* | 7.0:1 | 6.4:1 | 5.3:1 | 6.7:1 |
| `--foreground` on `--header-bg`* | 14.7:1 | 15.1:1 | 17.8:1 | 14.4:1 |
| active `--nav-active-fg` on `--nav-active-bg` | 10.3:1 | 10.9:1 (on bar) | 8.5:1 | 11.9:1 |
| wordmark `--accent` on `--header-bg`* | 9.7:1 | 10.9:1 | 10.7:1 | 8.7:1 |

\* translucent header bgs measured against their solid `--surface` base — the
worst case is content identical to the surface color; blur + darker page bg
only ever raises these. All pass 4.5:1 text / 3:1 UI.
