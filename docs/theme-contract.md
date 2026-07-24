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
