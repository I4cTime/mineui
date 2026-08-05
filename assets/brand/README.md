# MineUI brand assets

Copied from the canonical source in the `i4c-sites` monorepo
(`apps/mineui`): the mark geometry lives in
`components/ui/BrandMark.tsx` and the rasters are produced by
`scripts/gen-brand-assets.mjs` there. Do not edit these files here —
regenerate at the source and re-copy.

- `mark.svg` — full "Ore Cube" voxel mark, Emerald gradient, neon-tube build
- `mark-small.svg` — simplified cut for ≤48 px (favicons, list icons)
- `mark-mono.svg` — single-color (#3ddc84) cut
- `social-card-1200x630.jpg` — Open Graph / link-preview card
- `repo-social-preview.png` — 1280×640, for GitHub → Settings → Social
  preview (manual upload; GitHub has no API for it)

The Tauri app icon set (`src-tauri/icons/`) is still the old art on
purpose — regenerating it changes the installed desktop icon and needs
its own pass.
