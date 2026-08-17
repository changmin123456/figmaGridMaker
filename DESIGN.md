---
version: alpha
name: Logrid
description: Light-mode shadcn-inspired design system for a Figma plugin that generates logo grids and guidelines.
colors:
  primary: "#2383E2"
  primary-hover: "#1671CF"
  primary-foreground: "#FFFFFF"
  background: "#FFFFFF"
  foreground: "#18181B"
  muted: "#F4F4F5"
  muted-foreground: "#71717A"
  border: "#E4E4E7"
  panel: "#FAFAFA"
  panel-foreground: "#27272A"
  accent: "#F0F7FF"
  accent-foreground: "#0B5CAD"
  destructive: "#DC2626"
  destructive-foreground: "#FFFFFF"
typography:
  title:
    fontFamily: Inter, ui-sans-serif, system-ui, sans-serif
    fontSize: 18px
    fontWeight: 650
    lineHeight: 24px
    letterSpacing: 0
  body:
    fontFamily: Inter, ui-sans-serif, system-ui, sans-serif
    fontSize: 13px
    fontWeight: 450
    lineHeight: 18px
    letterSpacing: 0
  label:
    fontFamily: Inter, ui-sans-serif, system-ui, sans-serif
    fontSize: 12px
    fontWeight: 600
    lineHeight: 16px
    letterSpacing: 0
rounded:
  sm: 4px
  md: 6px
  lg: 8px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    height: 40px
  button-secondary:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: 36px
  panel:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
  tab-active:
    backgroundColor: "{colors.foreground}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
---

## Overview

Logrid should feel like a serious Figma-native production tool. The UI is compact, light, and control-dense, with a shadcn-style foundation: neutral surfaces, crisp borders, restrained radius, and blue primary actions.

The plugin should not feel like a landing page. Every visible element should either configure generation, describe state, or trigger a concrete action.

## Colors

The palette is light-mode first. White is the main surface, zinc-like neutrals are used for text and borders, and blue is reserved for selected controls, primary actions, and Pro state.

Generated Figma canvas objects use product blue only for active guide overlays. Potential errors use red. Neutral generated guides use black or gray with low opacity.

## Typography

Use Inter where available, falling back to system UI fonts. Headings stay small because the plugin panel is a dense tool surface. Letter spacing stays at 0.

## Layout

The default plugin width should work around 360-420px. Controls use 12px or 16px outer padding, 8px gaps, and predictable fixed heights so the panel does not jump during state changes.

Main layout:

- Header
- Payment or usage status row when needed
- Mode tabs
- Mode option tiles
- Accordion sections
- Sticky action area

## Elevation & Depth

Avoid decorative shadows. Use borders and subtle background changes for hierarchy. Floating modals may use a soft shadow, but core plugin panels should remain flat.

## Shapes

Use 4-8px radius. Cards, tiles, buttons, inputs, and tabs should not exceed 8px radius.

## Components

Tabs use a bordered segmented control. Buttons use icons when an action has a recognizable symbol. Sliders, switches, selects, and numeric inputs should match shadcn ergonomics but remain compact for plugin use.

## Do's and Don'ts

- Do keep generated-layer controls visible and understandable.
- Do make locked guideline behavior clear in Preferences.
- Do keep all canvas output editable and named.
- Do not add dark mode in MVP.
- Do not use decorative gradients or marketing sections inside the plugin.
- Do not modify the user's original selected logo.
