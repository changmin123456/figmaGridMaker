# Logrid Publishing Plan

## Recommended Release Path

Publish the current plugin as a free QA/beta build first. Keep payments disabled until the generation output is validated across real logo files.

Use this sequence:

1. Run local QA in Figma with `manifest.json`.
2. Create a Figma playground file with 6-10 test logos and before/after examples.
3. Prepare Community listing assets.
4. Submit as a free plugin or private beta build.
5. Add Figma Payments after the generation quality and review surface are stable.

## Current Build Type

- Build type: QA / free beta
- Usage limit: unlimited
- Payment UI: disabled
- Network access: none
- Data stored in files: generated group metadata through plugin data
- Original selected logo: hidden after generation but not destructively edited
- Generated guide layers: locked by default

## Manifest Notes

Current `manifest.json` is configured for QA:

- `documentAccess: "dynamic-page"` keeps the plugin aligned with current Figma loading behavior.
- `networkAccess.allowedDomains: ["none"]` declares that the plugin does not make external network requests.
- No payments permission is included in the QA build.

Use `manifest.payments.json` only for the monetized build or local checkout testing. It adds `permissions: ["payments"]`, which is required before accessing `figma.payments`.

Before publishing from Figma Desktop, create or claim the plugin through Figma's plugin management flow and replace the development `id` if Figma assigns a production ID.

## Community Listing Draft

Name:

```text
Logrid
```

Tagline:

```text
Generate editable logo construction grids, anchors, handles, and clearspace-style guide frames.
```

Short description:

```text
Logrid turns a selected logo frame into a structured brand construction board. It creates editable Figma layers for grid lines, circular construction guides, logo previews, anchors, Bezier handles, and angle guides, with clean hierarchy and locked guide layers by default.
```

Long description:

```text
Logrid helps identity designers turn logo geometry into presentable construction studies directly inside Figma.

Select a background frame that contains a logo, then generate a structured construction board. The plugin keeps output editable and organized, separating canvas background, grid, logo preview, construction circles, anchors, handles, and angle guides into named groups.

Current beta features:
- Generate from a selected background frame
- Editable square or dot grid
- Logo outline/fill preview controls
- Circular construction guides
- Anchor point markers
- Bezier handle markers
- Angle guide markers
- Light and dark canvas presets
- Harmonized random generation
- Locked generated guide layers by default

This beta build is free while output quality is being tested.
```

Suggested category:

```text
Design tools
```

Support contact:

```text
Use the creator email attached to the publishing Figma account.
```

## Listing Assets

Required:

- Icon: 128 x 128 px
- Thumbnail: 1920 x 1080 px

Logo source:

- `assets/logrid-logo.svg`

Recommended carousel:

- Slide 1: generated construction grid over a simple logo
- Slide 2: layer hierarchy close-up
- Slide 3: random styles, dark/light variants
- Slide 4: anchors and Bezier handles
- Slide 5: dot grid and circular guide output

## Playground File

Create one Figma playground file with:

- A simple geometric wordmark
- A circular mark
- A symbol with Bezier curves
- A frame that demonstrates expected selection behavior
- One generated example for lines
- One generated example for dots
- One generated example with anchors/handles/angles

## QA Checklist

Run these before submitting:

- Generate from a selected frame containing a logo.
- Generate again with the generated group selected.
- Generate with no selected frame but prior generated output available.
- Toggle lines/dots after generation.
- Toggle grid, circles, angles, anchors, and handles after generation.
- Change every color picker after generation.
- Change every opacity input after generation.
- Change grid size, weight, anchor size, and handle size after generation.
- Test random after generation at least 20 times.
- Test undo with Cmd+Z / Ctrl+Z.
- Test redo with Cmd+Shift+Z / Ctrl+Y.
- Verify the viewport does not jump during live edits.
- Verify no scrollbar appears in the plugin panel unless content height requires scroll.
- Verify generated groups are named and locked as expected.
- Verify original source logo is restorable through undo.

## Security Disclosure Draft

Use these answers as the starting point for Figma's security disclosure:

- External network requests: No.
- External domains: None.
- User data sent to third parties: No.
- File content processed outside Figma: No.
- Data stored locally: Plugin usage state may be stored locally in future builds; current QA build does not rely on external storage.
- Data stored in the Figma file: Generated nodes store plugin metadata such as source node IDs, generation mode, created timestamp, and canvas preset.
- Authentication required: No for QA build.
- Payment required: No for QA build.

## Paid Build Plan

Do not build a custom token website first unless Figma Payments cannot satisfy the business model.

Recommended paid path:

1. Apply for or confirm paid plugin creator eligibility.
2. Switch from `manifest.json` to `manifest.payments.json`.
3. Set `QA_UNLIMITED_USAGE` to `false` in `src/main.ts`.
4. Give unpaid users 1 successful generation.
5. Use `figma.payments.status` for in-plugin gating.
6. Later, add backend verification with `getPluginPaymentTokenAsync()` if server-side license enforcement is needed.

## Release Gate

Do not submit the public build until:

- QA checklist passes on at least 20 logo samples.
- Thumbnail and icon are ready.
- Playground file is ready.
- Listing text has been reviewed.
- The development plugin ID has been replaced or accepted by Figma's publish flow.
