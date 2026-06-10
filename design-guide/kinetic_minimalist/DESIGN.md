---
name: Kinetic Minimalist
colors:
  surface: '#fbf9f9'
  surface-dim: '#dbdad9'
  surface-bright: '#fbf9f9'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f5f3f3'
  surface-container: '#efeded'
  surface-container-high: '#e9e8e7'
  surface-container-highest: '#e3e2e2'
  on-surface: '#1b1c1c'
  on-surface-variant: '#4c4546'
  inverse-surface: '#303031'
  inverse-on-surface: '#f2f0f0'
  outline: '#7e7576'
  outline-variant: '#cfc4c5'
  surface-tint: '#5e5e5e'
  primary: '#000000'
  on-primary: '#ffffff'
  primary-container: '#1b1b1b'
  on-primary-container: '#848484'
  inverse-primary: '#c6c6c6'
  secondary: '#5d5f5f'
  on-secondary: '#ffffff'
  secondary-container: '#dcdddd'
  on-secondary-container: '#5f6161'
  tertiary: '#000000'
  on-tertiary: '#ffffff'
  tertiary-container: '#161e00'
  on-tertiary-container: '#718e00'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#e2e2e2'
  primary-fixed-dim: '#c6c6c6'
  on-primary-fixed: '#1b1b1b'
  on-primary-fixed-variant: '#474747'
  secondary-fixed: '#e2e2e2'
  secondary-fixed-dim: '#c6c6c7'
  on-secondary-fixed: '#1a1c1c'
  on-secondary-fixed-variant: '#454747'
  tertiary-fixed: '#c3f400'
  tertiary-fixed-dim: '#abd600'
  on-tertiary-fixed: '#161e00'
  on-tertiary-fixed-variant: '#3c4d00'
  background: '#fbf9f9'
  on-background: '#1b1c1c'
  surface-variant: '#e3e2e2'
typography:
  headline-sm:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: 0.05em
  body-lg:
    fontFamily: Geist
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Geist
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  label-md:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
  label-sm:
    fontFamily: JetBrains Mono
    fontSize: 10px
    fontWeight: '500'
    lineHeight: 14px
spacing:
  sidebar-width: 240px
  gutter-base: 2rem
  section-gap: 4rem
  element-gap: 1rem
---

## Brand & Style
The design system embodies a "Precision Minimalist" aesthetic, prioritizing raw functionalism over decorative elements. It is designed for high-density information environments where clarity is paramount. By removing traditional containers like cards and borders, the UI relies on structural alignment and optical weight to guide the user's eye. 

The brand personality is authoritative, uncompromising, and technical. The target audience includes developers, data analysts, and power users who value speed and lack of visual noise. The emotional response should be one of "calm focus"—where the interface disappears to leave only the data and the primary actions.

## Colors
The palette is strictly monochromatic to ensure maximum contrast and zero distraction. 
- **Core Surface:** Pure white (#FFFFFF) serves as the primary canvas.
- **Primary Ink:** Black (#000000) is used for all primary text and structural iconography.
- **Secondary Surface:** A light grey (#F5F5F5) is used sparingly for background shifts in the sidebar or large-scale layout divisions.
- **Critical Status:** Acid Green (#CCFF00) is a high-visibility signal reserved exclusively for active states, critical alerts, or success indicators that require immediate cognitive recognition.

Avoid gradients or semi-transparent overlays. Use solid fills to maintain the "brutalist" clarity of the system.

## Typography
Hierarchy is established through weight and typographic style rather than size. 
- **Page Titles:** Use the `headline-sm` style. They should be small, all-caps, and bolded to act as a clear but understated anchor for the page.
- **Data Labels:** Use the monospaced `label-md` to signify technical attributes or metadata.
- **Body Text:** Standardize on `body-md` for all readable content.

Since line separators are absent, use increased paragraph spacing and intentional indents to group related content blocks.

## Layout & Spacing
The layout follows a rigid 12-column grid but operates without visible borders.
- **Sidebar:** A fixed 240px sidebar exists on the left. It uses a slight background tint (#F5F5F5) to distinguish itself from the main workspace. 
- **Content Area:** Content should be centered or left-aligned within the grid with generous `section-gap` margins to define the change in context.
- **The "No-Line" Rule:** Tables and lists must not use horizontal or vertical rules. Instead, use alternating row tints or simply consistent vertical alignment to maintain the grid's integrity.
- **Mobile:** On smaller screens, the sidebar collapses into a full-screen drawer, and `section-gap` reduces to 2rem.

## Elevation & Depth
This design system rejects shadows and physical metaphors. Depth is achieved through "Tonal Shifts."
- **Layering:** Elements do not "float"; they are carved out of the surface.
- **Active States:** High-contrast color blocks (Black or Acid Green) indicate interaction focus.
- **Negative Space:** Use white space as a structural element. The distance between items should be the primary indicator of their relationship—closer items are related, wider gaps indicate a new conceptual block.

## Shapes
Shapes are strictly sharp (0px radius). This reinforces the architectural and technical nature of the system. Rectilinear forms ensure that when elements are placed next to each other, they form clean, uninterrupted lines of sight that compensate for the lack of actual border lines.

## Components
- **Buttons:** Solid black rectangles with white monospaced text. For "Critical" actions, use Acid Green background with black text.
- **Sidebar Navigation:** Items are text-only. The active state is indicated by a solid Black block spanning the width of the sidebar, with text inverted to White (or Acid Green if it's the primary system status).
- **Inputs:** No bottom lines or boxes. Inputs are defined by a light grey (#F5F5F5) background fill. Focus state is indicated by a 2px Black left-edge accent.
- **The Zero-Checkbox Rule:** Replace all checkboxes and radio buttons with "Toggle Chips" or "List Selection." An item is selected if it is filled with a solid Black background.
- **Lists & Tables:** No lines. Use a `1rem` vertical gap between rows. Column alignment must be pixel-perfect to ensure readability across the horizontal axis.
- **Status Indicators:** Small, solid Acid Green circles or squares used sparingly to indicate "Live" or "Active" data points.