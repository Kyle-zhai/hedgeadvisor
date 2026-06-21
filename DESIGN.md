# Design

A light, Notion-adjacent product system: true-white surfaces, hairline borders, a restrained near-monochrome palette with one subtle blue accent, fixed (non-fluid) type, and quiet state-conveying motion. Design serves the task; nothing decorative.

## Theme
Light. Clean white content surfaces with faint warm-gray secondary panels, near-black ink for high contrast, hairline borders instead of heavy cards. Reads as calm and premium, not as a tinted "cream" template (main surfaces are pure white, ink is near-black).

## Color (tokens in app/globals.css)
Restrained strategy: tinted neutrals + one accent ≤10% of surface.

- `--bg` #ffffff — page background
- `--bg-subtle` #f7f7f5 — secondary panels, input rests, table header
- `--surface` #ffffff — cards/sections
- `--surface-hover` #f3f3f1
- `--ink` #25282c — primary text (~13:1 on white)
- `--ink-2` #585f66 — secondary text (~5.6:1)
- `--ink-3` #6b7280 — muted/placeholder (~4.7:1, AA for placeholders)
- `--border` #ebebe8 — hairline
- `--border-strong` #dcdcd8 — inputs, dividers that need weight
- `--accent` #2b66d9 / `--accent-strong` #1f55c0 — primary action, selection, focus (subtle blue)
- `--accent-ink` #1a52cc — accent text on white (AA)
- Semantic: `--go` #067a46 / `--go-bg` #e7f4ec; `--nogo` #c02617 / `--nogo-bg` #fdeceb; `--warn` #9a6700 / `--warn-bg` #fbf3df. Always paired with a label/sign, never color-only.

## Typography
One family (system humanist sans). Fixed rem scale, ratio ~1.2.

- Stack: `ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`; mono for figures via `ui-monospace` where useful.
- Scale: 12 / 13 / 14 (body) / 16 / 20 / 26 / 32. Weights 400 / 500 / 600 / 700.
- Wordmark: 600–700, letter-spacing -0.01em. Headings use `text-wrap: balance`; prose `text-wrap: pretty`, capped 65–75ch. No all-caps body; uppercase only for ≤2-word micro-labels.

## Components
- **Card/section**: white surface, 1px `--border`, radius 10px, generous padding; no nested cards; no side-stripe accents.
- **Input**: 1px `--border-strong`, radius 8px, `--bg` fill, focus = 2px `--accent` ring (box-shadow) + border color.
- **Combobox (MarketSearch)**: input + popover listbox. Popover uses `position: absolute` in a non-clipping wrapper, `--shadow-pop`, radius 10px, z-index `--z-dropdown`. Options: hover/active rows (`--surface-hover`), primary label + muted sub line. States: loading, empty ("no real markets"), results.
- **Badge (verdict)**: GO/PARTIAL → tinted bg; NO-GO → `--nogo-bg`. Text label, not color alone.
- **Stat tile**: label (`--ink-3`, 12px) + value; before→after uses muted→ink.
- **Scenario table**: zebra-free, hairline row separators, `--bg-subtle` header, right-aligned figures, P&L green/red with explicit + / − sign.
- **Buttons**: primary = solid `--accent`, white text, radius 8px; secondary/ghost = `--border-strong` outline on white. Both have hover/active/focus/disabled.

## Layout
- Centered column, max-width ~ 760px for forms, ~ 880px for result sections; 24–32px page padding, 16–20px gaps.
- Flex for 1D rows; `repeat(auto-fit, minmax(150px, 1fr))` for stat grids. Responsive: form rows wrap, stat grid collapses, table stays scrollable on mobile.
- z-index scale: dropdown 50, sticky 100, modal 1000, toast 1100.

## Motion
150–200ms ease-out (`cubic-bezier(0.22,1,0.36,1)`). Dropdown: 120ms fade + 4px rise. Result cards: subtle 160ms fade-in-up, staggered lightly. Copy/feedback: instant state swap. Full `@media (prefers-reduced-motion: reduce)` fallbacks (opacity-only or none).
