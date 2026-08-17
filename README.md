# Logrid

Figma plugin MVP for generating editable logo construction grids, circular guides, anchor markers, Bezier handles, angle guides, and canvas grid systems.

## Scripts

```bash
npm install
npm run check
npm run build
```

Load `manifest.json` in Figma as a development plugin after building.

For local Figma Payments checkout testing, load `manifest.payments.json` and set `QA_UNLIMITED_USAGE` to `false` in `src/main.ts`.

## Current Scope

- Compact 320px Figma side-panel UI
- Dark and light canvas presets
- Lines and dots grid styles
- Logo outline/fill preview controls
- Circular construction guides
- Anchor, handle, and angle overlays
- Harmonized random generation after first generate
- Clean generated layer hierarchy
- Locked generated guide groups by default
- QA mode with unlimited local generations
- Payment gate disabled for QA

## Publishing

See [PUBLISHING.md](./PUBLISHING.md) for the Figma Community listing draft, QA checklist, security disclosure notes, and paid-build plan.
