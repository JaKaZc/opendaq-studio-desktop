# Branding

openDAQ Studio follows the **openDAQ Design Manual v1.0**. This page records
what that means in code, so the rules survive the next person to touch the
CSS.

## Colours

### Primary

Used in the logo, second-level headlines, highlighted text and the standard
background gradient.

| Name | HEX | PANTONE | RAL | Token |
|---|---|---|---|---|
| HBK Dark Blue | `#00335A` | 540 C | 5001 | `--color-hbk-blue` |
| DEWESoft Orange | `#F15D31` | 1655 C | 2004 | `--color-dewesoft-orange` |

### Secondary

For font colours, markings and symbols.

| Name | HEX | PANTONE | Token |
|---|---|---|---|
| openDAQ Graphite | `#424242` | 440 C | `--color-opendaq-graphite` |
| Cyan tint | `#D4F5FA` | 642 C | `--color-opendaq-cyan` |
| Peach tint | `#FADED3` | 705 C | `--color-opendaq-peach` |
| Mint tint | `#D3FAE6` | 621 C | `--color-opendaq-mint` |

### How they are applied

Components never reference a brand colour directly. Everything goes through
a *semantic* token such as `--color-surface`, `--color-text-muted` or
`--color-plot-grid`, which both themes redefine. A component is therefore
written once and is correct in light and dark without conditional classes.

Body copy uses openDAQ Graphite, as the manual specifies. The dark theme is
navy-tinted rather than neutral grey so the brand still reads at night. Its
accent shifts to a lighter orange (`#FF7048`) to hold contrast on dark
surfaces. The manual does not legislate a dark UI, so this is a documented
extension of it rather than a departure.

All tokens live in one place: `frontend/src/index.css`.

## The gradient

The manual's core graphic element:

- from **HBK Dark Blue** on the left to **DEWESoft Orange** on the right,
- at **45°**,
- distributed **60% blue / 40% orange**, which is what makes the angle read
  as balanced.

It is available as `--gradient-brand` and the `.brand-gradient` utility. It
is used sparingly, as a hairline under the top bar, so it stays brand rather
than decoration.

## The logo

Two versions and the rule that governs them:

| Version | Artwork | May be used on |
|---|---|---|
| **Primary** | Coloured: HBK Dark Blue + DEWESoft Orange | **White backgrounds only** |
| **Secondary** | Plain white | Coloured backgrounds and images |

`components/layout/Brand.tsx` implements this. The light theme paints panels
white and gets the primary version. The dark theme is a coloured surface and
gets the secondary. The switch is pure CSS (`dark:hidden` / `hidden
dark:block`), so the correct version is present on the first paint with no
JavaScript involved.

The `dark` variant is defined to match **both** an explicit
`data-theme="dark"` and the system preference. If it only matched the
attribute, the theme "system" with a dark OS would show the coloured logo on
a dark surface, which the manual forbids.

### Where the artwork comes from

The logo is the manual's own artwork, not a redrawing of it. Its ten outlines
(`open`, the orange `D`, `AQ`, the star badge and the trademark sign) were
taken out of the PDF's vector content and written into `Brand.tsx` as paths.
The letterforms, the overlap of the `D` with the `n` and the star aperture
are therefore exactly as published. Only the fills are named rather than
copied. The PDF stores them in a CMYK-derived RGB (`#173557`, `#eb5d34`).
The manual's own colour pages give `#00335a` and `#F15D31`. The stated
values win.

The full logo is used wherever there is room for it: the top bar, the
start-up screen and the About dialog. It is never set again in a typeface and
never recoloured. The product name sits beside it as a separate label behind
a hairline rule, so the logo itself is untouched.

### The application icon

A square icon cannot be the full logo, because at 16 px a wordmark is a
smudge. The icon is instead the manual's two separable elements and nothing
invented: the 45-degree brand gradient (the manual's "core graphic element",
page 11) on a rounded tile, with the logo's star badge in white on top. It
stays legible down to 16 px and it is unmistakably the same brand as the
wordmark beside it.

### Everything is generated from the same two files

```bash
python3 scripts/build_icons.py
```

| Source | |
|---|---|
| `assets/brand/opendaq-logo.svg` | The full logo, ten outlines from the manual |
| `assets/brand/opendaq-badge.svg` | The star badge on its own |

| Output | Use |
|---|---|
| `frontend/src/components/layout/Brand.tsx` | The full logo inline, both versions, so CSS can switch them |
| `frontend/public/opendaq-logo.svg` | The same artwork standalone, for embedding |
| `frontend/public/favicon.svg` | The page icon as vector |
| `frontend/public/opendaq-icon.png` | 512 px raster, for contexts that ignore SVG |
| `desktop/build/icon.{icns,ico,png}` | Application icon for macOS, Windows and Linux |
| `desktop/build/background.png`, `@2x` | The DMG window |
| `desktop/build/*Sidebar.bmp`, `installerHeader.bmp` | The Windows installer pages |

`scripts/brandkit.py` rasterises the SVGs with Pillow alone rather than
pulling in a full SVG engine. The brand files use only `M`, `L`, `C` and `Z`,
which take a few lines to flatten. Holes are simple counters, so the
even-odd rule gives the same result as the non-zero rule the files declare.

The outputs are committed, so a normal build needs none of this. Only
changing the artwork does.

## Typography

| Role | Font | Manual's colour |
|---|---|---|
| Primary typeface | **Roboto** (Light, Regular, Medium, Bold) | |
| Secondary typeface | **Montserrat Light**, for taglines set with the logo | |
| Headline 01 | Roboto Light, 30/34 pt | openDAQ Graphite |
| Headline 02 | Roboto Light, 20/22 pt | HBK Dark Blue |
| Headline 03 | Roboto Bold, 12/14 pt | openDAQ Graphite |
| Copy | Roboto Regular, 10/12 pt | openDAQ Graphite |
| Text highlight | Roboto Regular | DEWESoft Orange (`.text-highlight`) |

Both faces are **bundled** (`@fontsource/roboto`, `@fontsource/montserrat`)
rather than fetched from Google Fonts. Measurement PCs are frequently
offline and an application that loses its typography when the network is
down is not acceptable in a control room.

One deliberate deviation: the manual sets headlines in Roboto Light, which at
UI sizes (12 to 15 px rather than 20 to 30 pt) is too thin to stay legible on
a dark surface. Headings use Medium and only the largest heading uses Light.

Measurement values are set in a monospace stack with tabular numerals, so
columns do not shift as values change. That is a legibility requirement of
the data and not a brand choice.

## Writing "openDAQ"

Lower-case *open* and upper-case *DAQ*, **always**, including at the start
of a sentence. The manual is explicit about this. It applies to UI strings,
docs and commit messages alike.

## Using a different mark

If you fork this for another product, replace:

1. `LOGO_PATHS` and the two size constants in `frontend/src/components/layout/Brand.tsx`
2. `frontend/public/favicon.svg`, `opendaq-icon.png` and `opendaq-logo.svg`
3. `desktop/build/icon.{icns,ico,png}`
4. the brand tokens at the top of `frontend/src/index.css`
5. `productName` and `appId` in `desktop/electron-builder.yml`, `kAppName` in
   `engine/src/engine.h` and the data folder's name in
   `engine/src/platform.cpp`

Nothing else references the logo or the primaries directly.

## The header and the tracks

There is no navigation rail. The logo sits in the header on the white the
primary version is licensed for, with the six modes beside it. The
active mode is marked in the accent colour. DEWESoft Orange is the action colour
(Add), the manual's "text highlight" applied to what starts something. A
recorder that is recording is red, because Record is red on every recorder a
test engineer has used. Tracks are neutral grey and navy when selected.

## Motion

Motion explains a change. It is never something to wait for.

| Token | Value | Used for |
|---|---|---|
| `--ease-out` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | everything that arrives |
| `--duration-fast` | 120 ms | hover, row highlight |
| `--duration-base` | 200 ms | switching mode |
| `--duration-slow` | 420 ms | a page assembling (`.animate-enter`, staggered by `--enter-delay`) |

`.live-dot` marks something live. The dot is steady and a ring breathes out
of it, so the state reads in any single frame. `.flow-edge` moves samples
along a topology connection at a constant speed, so it reads as flow rather
than urgency. Large numbers count to their value (`AnimatedNumber`) and are
set in **Roboto Light**, the manual's Headline 01 weight, with proportional
figures.

The global `prefers-reduced-motion` rule in `index.css` stops all of it.

### Token names

A colour token in `@theme` generates Tailwind utilities from its name, so a
new token must not share a name with a hand-written class. `--color-highlight`
once turned the manual's orange `.text-highlight` white. The panel's top-edge
light is `--color-edge-light` for that reason.
