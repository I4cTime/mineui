# MineUI v2 — Aesthetic Directions

Phase 1 deliverable from the theme coordinator. Four directions for the owner to choose from.
No implementation has been done; every value below is a proposal. Contrast ratios were computed
(WCAG relative luminance) for every pairing stated.

---

## 0. Audit of the current look

**Sources read:** `app/globals.css`, `tailwind.config.ts`, `app/layout.tsx`, `app/page.tsx`,
`app/status/page.tsx`, `app/settings/page.tsx`, `app/components/CreateServerFlow.tsx`.

**Characterization.** Dark-only, green-on-near-black (`#0b0f0b` bg, `#67f78f` mint accent) with
four preset themes (`emerald`, `ember`, `aether`, `void`) that are pure palette swaps — same
shapes, same type, same motion. Radius is a uniform `0.75rem`. Typography is Geist Sans + Geist
Mono with **Press Start 2P** used for every card header and the H1 — all-caps, wide tracking,
everywhere. Density is roomy (p-5 cards, gap-6 grids, max-w-6xl). A radial accent glow is painted
behind the whole dashboard, and several elements pulse on infinite loops.

**What's generic/dated:**

1. **Press Start 2P is overused.** As the label font on every card it reads as a toy/retro-arcade
   skin, not a desktop tool. It also has poor legibility at 12px and no lowercase.
2. **The four themes are one theme.** Accent-swap presets add maintenance surface (4 blocks of
   duplicated variables) without adding character.
3. **Semantic state tokens are missing.** `phaseChipColor()` maps running/starting/crashed to
   HeroUI `success`/`warning`/`danger`, but `globals.css` never defines `--success`, `--warning`,
   `--danger` — the app's single most important signal (server state) renders in un-themed HeroUI
   beta defaults that don't belong to any of the four palettes.
4. **Motion is inline literals.** `transition={{ duration: 0.35 }}` etc. scattered through pages;
   no preset module; three separate infinite pulse loops on one screen.
5. **`tailwind.config.ts` is vestigial** (a v3-style `content` array; Tailwind v4 configures via
   CSS). The real theme block (`@theme inline`) only maps 2 colors + 3 fonts — everything else is
   raw `var(--x)` inline styles and `text-[var(--muted)]` arbitrary values.
6. Fonts load via `next/font/google`, which self-hosts at build time — offline-safe, fine to keep
   as a mechanism.

Verdict: a competent HeroUI-variable wiring job wearing a generic "dark dashboard with a neon
accent + pixel font" costume. The bones (CSS-variable theming, HeroUI slots) are good; the
identity is the weak part.

---

## Reading guide for the four directions

- All values are dark-first (the app is dark-only today). Each direction states whether a light
  variant is supported/recommended.
- **Server state is the app's primary signal.** Mapping in every direction:
  `running → success`, `starting/stopping → warning`, `crashed → danger`, `stopped/not-created →
  muted/default`. The four state colors must stay distinguishable from each other and from accent.
- "CR" = contrast ratio vs the stated background. Targets: 4.5:1 body text, 3:1 UI/large.
- HeroUI v3 beta mapping: tokens feed the same variable names the app already uses
  (`--background`, `--surface`, `--overlay`, `--muted`, `--accent`, `--accent-foreground`,
  `--default`, `--field-*`, `--separator`, `--border`, `--focus`, `--radius`) **plus** the
  currently-missing `--success/--warning/--danger` (+ `-foreground`) trio.
- Shared risk for all four: HeroUI v3 is beta.5 — variable names/slots may rename before stable.
  Pin the version; keep all raw values in `:root` custom properties and map them, so a rename is a
  one-file fix.

---

## Direction 1 — "Quantum Fluidity" (I4C brand extension)

**Feels like:** MineUI is the desktop sibling of i4c.studio — deep-space black, cyan signal,
violet glow, sleek and slightly cinematic.

**Favors:** both modes equally; strongest if MineUI should read as a member of the I4C product
family (alongside Q-Ring, ProtonShift).

These values are lifted verbatim from `~/Develop/sites/i4c.studio/app/globals.css` and
`lib/palette.ts` — do not invent variants; the portfolio is the source of truth.

### Tokens (dark; the only scheme — brand is dark-only by design, no light variant)

| Token | Value (OKLCH) | Hex | CR vs bg | Notes |
|---|---|---|---|---|
| `--background` | `oklch(0.06 0.01 270)` | `#000102` | — | "eclipse" |
| `--surface` | `oklch(0.16 0.015 270)` | `#0B0D14` | — | cards |
| `--overlay` (elevated) | `oklch(0.20 0.015 270)` | `#13161D` | — | menus/modals; fg on it 16.6:1 |
| `--foreground` | `oklch(0.97 0.005 260)` | `#F3F5F9` | 19.1:1 | "snow" |
| `--muted` | `oklch(0.62 0.015 270)` | `#828690` | 5.7:1 | secondary text |
| `--subtle` | `oklch(0.48 0.015 270)` | `#5C6069` | ~3.2:1 | tertiary/disabled, never body text |
| `--accent` | `oklch(0.79 0.15 220)` | `#00D1FF` | 11.5:1 | quantum cyan |
| `--accent-foreground` | `oklch(0.06 0.01 270)` | `#000102` | 11.5:1 on accent | |
| `--quantum-violet` | `oklch(0.55 0.28 290)` | `#7B2DFF` | 3.65:1 | glows/gradients/fills ONLY |
| `--quantum-violet-text` | `oklch(0.70 0.20 290)` | `#A082FF` | 7.1:1 | text-safe violet |
| `--success` (running) | `oklch(0.72 0.17 155)` | `#22C373` | 9.1:1 | |
| `--warning` (starting/stopping) | `oklch(0.78 0.14 75)` | `#EBA941` | 10.2:1 | |
| `--danger` (crashed) | `oklch(0.55 0.19 15)` | `#C72C4C` | 3.9:1 | UI-signal only; danger *text* uses `--foreground` on danger fills (per i4c: `--danger-foreground: var(--snow)`) |
| `--border` / `--separator` | `oklch(0.24 0.015 270)` | `#1E2129` | — | hairline |
| `--focus` / ring | `var(--accent)` | | | 2px outline, same as i4c |
| shadow | `--shadow-quantum: 0 0 20px oklch(0.79 0.15 220 / 12%), 0 0 40px oklch(0.55 0.28 290 / 8%)` | | | replaces elevation shadows on hero cards |

### Typography
- UI: **Space Grotesk** (display/headers) + **Inter** (body) — both OFL, bundle via `next/font`.
- Mono (logs/RCON): **JetBrains Mono** (OFL). Matches the portfolio exactly.
- Scale: roomy; generous tracking on section labels (replaces the pixel font's role).

### Shape & density
- Radius `0.75rem` base (matches i4c `--radius`), `1rem` on modals, `9999px` chips.
- Borders: hairline `--border` + quantum glow shadow on *accented* cards only; ordinary cards get
  border, no shadow. Spacing: keep current roomy density.

### Motion
**Fluid, glowy, drifting, cinematic.** Durations 0.4–0.6s, ease `[0.22, 1, 0.36, 1]` (port
`lib/motion.ts` presets from i4c.studio — do not re-invent).
**Signature moment:** server start — the state chip crossfades `warning → success` while a cyan
glow bloom expands once behind the status card (single-shot, not an infinite pulse).

### HeroUI v3 risk: **Low.**
Keeps default radius/density, so component overrides stay shallow. Only custom work: glow shadow
utilities and the violet gradient text class — pure additive CSS. Chart/canvas surfaces must read
from a `lib/palette.ts` clone, same discipline as the portfolio.

---

## Direction 2 — "Deepslate & Emerald" (Minecraft-native)

**Feels like:** the tool the game would ship if Mojang made professional server software —
deepslate stone, emerald signal, redstone alarm, one pixel-font wink.

**Favors:** both — Simple users get instant familiarity ("this is Minecraft's world"), Advanced
users get a serious dark tool. This is the only direction that makes MineUI *ownable* in its
category.

### Tokens (dark; light variant possible — "birch" — but not recommended for v2)

| Token | Hex | CR vs bg | Rationale |
|---|---|---|---|
| `--background` | `#0F1214` | — | deepslate, cool near-black |
| `--surface` | `#171B1E` | — | stone card; fg on it 13.9:1 |
| `--overlay` (elevated) | `#1F2429` | — | fg on it 13.2:1 |
| `--foreground` | `#E9EDEA` | 15.9:1 | bone white, faint green cast |
| `--muted` | `#9BA8A0` | 7.6:1 | lichen gray (7.0:1 even on surface) |
| `--subtle` | `#5F6B65` | ~3.4:1 | labels/disabled only |
| `--accent` | `#3DDC84` | 10.5:1 | emerald |
| `--accent-foreground` | `#08110C` | 10.7:1 on accent | |
| `--success` (running) | `#3DDC84` | 10.5:1 | success IS the accent — deliberate: "green means the server lives" |
| `--warning` (starting/stopping) | `#F7B733` | 10.5:1 | gold / glowstone |
| `--danger` (crashed) | `#FF5D5D` | 6.3:1 | redstone; text-safe |
| `--stopped` | `--muted` | 7.6:1 | gray chip, not red — stopped is normal, not an error |
| `--border` / `--separator` | `#2A3138` | — | 1px, crisp |
| `--focus` / ring | `#3DDC84` | | 2px, square-cornered outline |
| shadow | none | | flat; depth via bg-layer steps + a 1px lighter top-edge inset (`inset 0 1px 0 #ffffff0a`) — the "MC slot bevel," at 4% opacity so it reads as craft, not costume |

Since accent doubles as success, **starting** (gold) and **crashed** (red) pop harder — correct
priority for a server tool.

### Typography
- UI: **Inter** (OFL) — deliberately plain; the palette and shapes carry the theme.
- Mono (logs/RCON): **JetBrains Mono** (OFL).
- Pixel accent: **Monocraft** (OFL, IdreesInc — the Minecraft-styled programming font) for
  **numerals only**: player count, TPS, ping, download %. Never headings, never body, never
  labels. This single rule is what keeps the direction tasteful.
- Scale: medium density, tabular numerals everywhere stats appear.

### Shape & density
- Radius: **4px flat scale** (`--radius: 4px`), 6px on modals, 4px on chips — blocky but not
  literal squares. No pill shapes anywhere.
- Borders always, shadows never (see bevel note above).
- Density: one step tighter than current (p-4 cards, gap-4 grids).

### Motion
**Chunky, stepped, instant, deliberate.** 150–200ms, ease-out, no overshoot.
**Signature moment:** download progress fills in discrete chunks — `steps(20)` easing on the
progress bar, like blocks placing; server start "places" the status card with a 0.96→1 scale pop.

### Taste guardrails (explicit, for implementers)
No grass textures, no dirt borders, no item sprites, no creeper mascots, no Minecraft trademarked
assets. The game is evoked through palette, 4px corners, the bevel inset, stepped motion, and
Monocraft numerals — nothing else.

### HeroUI v3 risk: **Medium.**
`--radius: 4px` propagates, but HeroUI beta hardcodes `rounded-full` in spots (Chip, Avatar,
circular progress) — those need targeted class overrides. `steps()` easing isn't expressible
through component props; progress bars need a custom bar or CSS override. Verify the beta's
`--success/--warning/--danger` slot names against `@heroui/styles` before mapping.

---

## Direction 3 — "Phosphor Amber" (ops console / homelab terminal)

**Feels like:** k9s grew a GPU — near-black, hairline grid, amber phosphor accent, everything is
data.

**Favors:** Advanced-mode homelab users, strongly. Simple mode survives but feels like it borrowed
a sysadmin's tool.

### Tokens (dark only; a light variant would be off-brand — not supported)

| Token | Hex | CR vs bg | Rationale |
|---|---|---|---|
| `--background` | `#0B0C0E` | — | neutral near-black, no color cast |
| `--surface` | `#111316` | — | barely-raised panel |
| `--overlay` (elevated) | `#17191D` | — | fg on it 13.6:1 |
| `--foreground` | `#DEE3E7` | 15.1:1 | slightly dimmed white — terminal, not paper |
| `--muted` | `#8B949E` | 6.4:1 | infra gray (6.05:1 on surface) |
| `--subtle` | `#545C66` | ~3.0:1 | grid labels only |
| `--accent` | `#FFB224` | 10.9:1 | amber phosphor — the ONE vivid color |
| `--accent-foreground` | `#1C1300` | 10.2:1 on accent | |
| `--success` (running) | `#3FB950` | 7.7:1 | steady green — quiet, not neon |
| `--warning` (starting/stopping) | `#D29922` | 7.8:1 | dimmer amber, subordinate to accent |
| `--danger` (crashed) | `#F85149` | 5.8:1 | alert red, text-safe |
| `--border` / `--separator` | `#22262B` | — | hairlines everywhere; tables/grids are the aesthetic |
| `--focus` / ring | `#FFB224` | | 1px offset outline — thin, precise |
| shadow | none | | zero shadows; hierarchy = borders + bg steps |

Warning vs accent tension is resolved by luminance: accent `#FFB224` (10.9:1) is reserved for
interactive/brand; warning `#D29922` (7.8:1) is visibly duller and appears only in state chips.

### Typography
- UI: **IBM Plex Sans** (OFL) — infra credibility, compact metrics.
- Mono: **IBM Plex Mono** (OFL) — and mono is *promoted*: all stat values, table cells, chip
  labels, timestamps, and nav item labels render in mono. Logs/RCON obviously mono, 13px/1.5.
- Scale: compact — 13px base UI text, 12px table text, tight leading. Uppercase 10px mono
  section labels with `0.08em` tracking.

### Shape & density
- Radius: **6px flat** (`--radius: 6px`), 6px everywhere including modals — uniformity is the point.
- Borders always, 1px; shadows never. Panels butt against each other Grafana-style.
- Density: two steps tighter than current (p-3 cards, gap-3, 32px control heights, `size="sm"`
  HeroUI defaults). The dashboard should fit a 13" laptop with zero scrolling.

### Motion
**Instant, terse, precise, unsentimental.** 120–160ms, linear or ease-out only, opacity/clip only
— nothing scales, nothing springs, nothing loops.
**Signature moment:** the running state is a solid green dot plus a *block-cursor blink* (1.06s
step) next to the uptime counter; new log lines arrive with a single 120ms one-line slide.

### HeroUI v3 risk: **Medium-high.**
Density is the fight: HeroUI beta components carry fixed heights/padding; everything must mount
at `size="sm"` plus padding overrides, and mono-in-components (Chip, Table cells) needs
font-family overrides at the slot level. Budget an audit of which components respect `--radius`
vs hardcode rounding. Tables may be easier hand-rolled than via HeroUI Table.

---

## Direction 4 — "Soft Glass" (modern-soft desktop)

**Feels like:** a calm, native-grade utility that could ship on the macOS App Store — frosted
panels, round corners, one warm apricot accent.

**Favors:** Simple-mode casual users, strongly. Advanced mode stays pleasant but loses the
"serious infra" edge.

### Tokens (dark below; **light variant supported and recommended** — this is the only direction
where following the OS appearance is on-brand; ship `prefers-color-scheme` + manual override)

| Token | Hex (dark) | CR vs bg | Rationale |
|---|---|---|---|
| `--background` | `#151519` | — | warm graphite; under Tauri vibrancy becomes `rgba(21,21,25,0.72)` |
| `--surface` | `#1D1D22` | — | frosted card: `rgba(255,255,255,0.045)` over blur, solid fallback `#1D1D22` |
| `--overlay` (elevated) | `#26262C` | — | fg on it 12.9:1 |
| `--foreground` | `#EDEDF0` | 15.6:1 | soft white |
| `--muted` | `#A3A3AD` | 7.3:1 | (6.7:1 on surface) |
| `--subtle` | `#71717C` | ~3.9:1 | captions/placeholders |
| `--accent` | `#F5A97F` | 9.4:1 | warm apricot |
| `--accent-foreground` | `#2A1410` | 9.0:1 on accent | |
| `--success` (running) | `#62D796` | 10.1:1 | soft mint |
| `--warning` (starting/stopping) | `#E8C268` | 10.7:1 | honey |
| `--danger` (crashed) | `#ED6A6D` | 6.0:1 | soft coral-red, text-safe |
| `--border` / `--separator` | `rgba(255,255,255,0.08)` | — | translucent hairline |
| `--focus` / ring | `#F5A97F` | | 3px soft ring at 40% opacity |
| shadow | layered soft: `0 1px 2px rgb(0 0 0/0.25), 0 8px 24px rgb(0 0 0/0.35)` | | shadows carry elevation; borders are whisper-thin |

Light variant sketch (to be fully specified if chosen): bg `#F4F2EF`, surface `rgba(255,255,255,0.7)`,
fg `#26262B`, same accent hue family darkened to `#C56A3D` for 4.5:1 on light surfaces.

### Typography
- UI: **Figtree** (OFL) — rounded, friendly, native-feeling. (Fallback choice: keep Geist.)
- Mono (logs/RCON): **Commit Mono** (OFL) — neutral, low-contrast mono that doesn't shout inside
  a soft UI. (Fallback: Geist Mono.)
- Scale: roomy — 14px base, relaxed leading, sentence-case labels (kill the all-caps tracking).

### Shape & density
- Radius: **12px base** (`--radius: 0.75rem` stays), 16px cards, 20px modals, pill chips/buttons.
- Shadows over borders; translucency via `backdrop-filter: blur(20px) saturate(1.4)` on surfaces.
- Density: current roominess, slightly more padding on cards (p-6).

### Motion
**Gentle, springy, weighted, quiet.** Springs (stiffness ~220, damping ~26) for anything that
moves; 250–350ms crossfades for state.
**Signature moment:** the EULA/create-server flow presents as a bottom sheet that spring-slides up
over the frosted background; server state chip morphs color with a 300ms crossfade — no pulse
loops anywhere.

### HeroUI v3 risk: **Highest of the four.**
HeroUI assumes opaque `--surface`; translucent surfaces mean backdrop-filter on Card/Modal/Popover
slots, and stacked translucent layers (menu over frosted card over vibrancy) can go muddy — needs
an explicit layering rule (only one frosted level; overlays go solid `--overlay`). Tauri window
vibrancy is per-OS (macOS materials, Windows Mica/Acrylic, **nothing reliable on Linux**) — the
solid-hex fallbacks above are mandatory, and Linux simply gets the solid theme. Light variant
doubles the token QA surface.

---

## Ranking (design-authority recommendation)

1. **Deepslate & Emerald** — the only direction that gives MineUI an identity *of its own
   category*: instantly legible to Minecraft people, still a credible modern tool, favors both
   user modes, and it's the shortest migration from the current green-on-dark + pixel-font base
   (the current theme is a rough draft of exactly this). Recommended.
2. **Phosphor Amber** — best fit for the core Advanced/homelab persona and the log/RCON surfaces
   that dominate real usage; loses points for making Simple mode feel borrowed.
3. **Quantum Fluidity** — strongest if the owner's priority is portfolio-brand coherence across
   I4C products; says nothing about Minecraft, and the glow language fights the utilitarian
   log-viewer core.
4. **Soft Glass** — the prettiest generic answer; least distinctive, highest HeroUI-beta and
   cross-platform (Linux vibrancy) risk for the least strategic payoff.

## Implementation notes for whichever direction wins (Phase 2 contract preview)

- Define the full token set in `app/globals.css` `:root` + `@theme inline` mappings; delete the
  four `[data-theme=…]` preset blocks (one identity, one theme).
- Add the missing `--success/--warning/--danger(-foreground)` HeroUI mappings — server-state chips
  must render from the chosen palette, not beta defaults.
- Create `app/lib/motion.ts` with `durations`/`easings`/presets for the chosen motion character;
  migrate all inline `transition={{ … }}` literals.
- Create `app/lib/palette.ts` (hex mirrors) if any canvas/chart/ProgressRing code needs literal
  colors — same two-file sync rule as i4c.studio.
- Delete vestigial `tailwind.config.ts`.
- Replace `text-[var(--muted)]`-style arbitrary values with named utilities from `@theme`.
