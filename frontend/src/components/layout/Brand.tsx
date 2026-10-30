import { cn } from '../../lib/utils';

/**
 * The openDAQ logo, per the Design Manual v1.0.
 *
 * The artwork is the manual's own: the ten outlines were taken out of the PDF's
 * vector content, not redrawn, so the letterforms, the overlap of the orange "D"
 * with the "n", the star aperture in the badge and the trademark sign are exactly
 * as published.
 *
 * The manual defines two versions and when each may be used:
 *
 * - **Primary** — coloured, HBK Dark Blue with the "D" in DEWESoft Orange. It
 *   *may only be used on a white background*.
 * - **Secondary** — plain white, for coloured backgrounds and images.
 *
 * The light theme paints panels white, so it takes the primary version; the dark
 * theme is a coloured surface, so it takes the secondary. Both are in the markup
 * and CSS picks between them, so the right one is there on the first paint and no
 * JavaScript is involved.
 *
 * The logo is never redrawn or re-set in a typeface: the product name sits beside
 * it as a separate label, behind a rule, so the logo itself stays untouched.
 */
export function Brand({
  className,
  /** Logo only, without the product name. */
  compact = false,
  /** Force a version. By default it follows the theme. */
  variant,
}: {
  className?: string;
  compact?: boolean;
  variant?: 'colour' | 'white';
}) {
  return (
    <span className={cn('flex items-center gap-2.5 select-none', className)}>
      <OpenDaqLogo height={20} variant={variant} />

      {!compact ? (
        <>
          <span className="h-4 w-px bg-border" aria-hidden />
          <span className="text-[11px] font-light tracking-[0.14em] text-text-muted uppercase">
            Studio
          </span>
        </>
      ) : null}
    </span>
  );
}

/** Natural size of the artwork, which fixes its aspect ratio. */
const LOGO_WIDTH = 213.7;
const LOGO_HEIGHT = 55.05;

export function OpenDaqLogo({
  height = 20,
  variant,
  className,
}: {
  height?: number;
  variant?: 'colour' | 'white';
  className?: string;
}) {
  const showColour = variant === undefined || variant === 'colour';
  const showWhite = variant === undefined || variant === 'white';
  const width = Math.round((height * LOGO_WIDTH) / LOGO_HEIGHT);

  return (
    <svg
      viewBox={`0 0 ${LOGO_WIDTH} ${LOGO_HEIGHT}`}
      width={width}
      height={height}
      role="img"
      aria-label="openDAQ"
      className={cn('shrink-0', className)}
    >
      {/* Never "OpenDAQ" or "opendaq": the manual fixes the casing. */}
      <title>openDAQ</title>

      {showColour ? (
        <g className={variant ? undefined : 'dark:hidden'}>
          {LOGO_PATHS.map((part, index) => (
            <path key={index} d={part.d} fill={part.orange ? '#F15D31' : '#00335A'} />
          ))}
        </g>
      ) : null}

      {showWhite ? (
        // The secondary version is a single flat white, not the surrounding text
        // colour: the manual specifies white, and a soft grey would read as a
        // faded logo rather than the published one.
        <g className={variant ? undefined : 'hidden dark:block'} fill="#FFFFFF">
          {LOGO_PATHS.map((part, index) => (
            <path key={index} d={part.d} />
          ))}
        </g>
      ) : null}
    </svg>
  );
}

/**
 * The outlines, in drawing order, lifted from the design manual.
 *
 * Only the "D" is orange; everything else - "open", "AQ", the badge and the
 * trademark sign - is HBK Dark Blue in the primary version.
 */
const LOGO_PATHS: { d: string; orange?: boolean }[] = [
  // A
  { d: 'M136.6 29.11L129.97 13.1L123.34 29.11L136.6 29.11ZM139.65 36.46L120.23 36.46L116.52 45.43L106.6 45.43L125.25 3.6L134.81 3.6L153.51 45.43L143.35 45.43L139.65 36.46Z' },
  // Q
  { d: 'M162.14 31.44C163.28 33.47 164.84 35.06 166.83 36.19C168.82 37.33 171.05 37.9 173.52 37.9C175.99 37.9 178.22 37.33 180.22 36.19C182.21 35.06 183.77 33.47 184.91 31.44C186.04 29.41 186.61 27.1 186.61 24.51C186.61 21.92 186.04 19.61 184.91 17.58C183.77 15.55 182.21 13.96 180.22 12.83C178.22 11.69 175.99 11.13 173.52 11.13C171.05 11.13 168.82 11.69 166.83 12.83C164.84 13.96 163.28 15.55 162.14 17.58C161.01 19.61 160.44 21.92 160.44 24.51C160.44 27.1 161.01 29.41 162.14 31.44ZM198.5 49.91C197.15 51.58 195.5 52.85 193.57 53.73C191.64 54.61 189.52 55.05 187.21 55.05C184.1 55.05 181.29 54.38 178.78 53.04C176.27 51.71 173.4 49.35 170.18 45.96C166.39 45.49 163.02 44.27 160.05 42.32C157.08 40.37 154.77 37.85 153.12 34.76C151.46 31.67 150.64 28.26 150.64 24.51C150.64 20.41 151.62 16.71 153.6 13.43C155.57 10.14 158.3 7.56 161.78 5.69C165.27 3.82 169.18 2.88 173.52 2.88C177.86 2.88 181.77 3.82 185.24 5.69C188.7 7.56 191.43 10.14 193.42 13.43C195.41 16.71 196.41 20.41 196.41 24.51C196.41 29.37 195.05 33.63 192.32 37.3C189.59 40.96 185.97 43.51 181.47 44.95C182.47 45.98 183.43 46.73 184.37 47.19C185.3 47.65 186.31 47.88 187.39 47.88C189.98 47.88 192.25 46.84 194.2 44.77L198.5 49.91Z' },
  // D
  { d: 'M106.52 13.52C104.59 10.37 101.88 7.93 98.39 6.2C94.91 4.46 90.89 3.6 86.35 3.6L67.35 3.6L67.35 20.63L77.03 20.63L77.03 11.54L85.88 11.54C90.06 11.54 93.39 12.71 95.88 15.04C98.37 17.37 99.62 20.53 99.62 24.51C99.62 28.5 98.37 31.65 95.88 33.98C94.45 35.32 92.75 36.27 90.76 36.84L90.61 36.88L90.61 45.14L90.76 45.12C93.53 44.73 96.08 43.98 98.39 42.83C101.88 41.09 104.59 38.65 106.52 35.51C108.45 32.36 109.42 28.69 109.42 24.51C109.42 20.33 108.45 16.66 106.52 13.52Z', orange: true },
  // o
  { d: 'M13.97 42.26C15.1 41.61 15.97 40.7 16.61 39.51C17.24 38.32 17.55 36.97 17.55 35.45C17.55 33.94 17.24 32.59 16.61 31.4C15.97 30.21 15.1 29.29 13.97 28.65C12.85 28 11.58 27.68 10.16 27.68C8.74 27.68 7.48 28 6.35 28.65C5.23 29.29 4.34 30.21 3.7 31.4C3.05 32.59 2.73 33.94 2.73 35.45C2.73 36.97 3.05 38.32 3.7 39.51C4.34 40.7 5.23 41.61 6.35 42.26C7.48 42.9 8.74 43.23 10.16 43.23C11.58 43.23 12.85 42.9 13.97 42.26ZM4.97 44.31C3.42 43.43 2.21 42.23 1.33 40.69C0.44 39.14 0 37.4 0 35.45C0 33.51 0.44 31.76 1.33 30.22C2.21 28.68 3.42 27.48 4.97 26.62C6.51 25.76 8.24 25.33 10.16 25.33C12.08 25.33 13.81 25.76 15.35 26.62C16.9 27.48 18.1 28.68 18.98 30.22C19.85 31.76 20.28 33.51 20.28 35.45C20.28 37.4 19.85 39.14 18.98 40.69C18.1 42.23 16.9 43.43 15.35 44.31C13.81 45.18 12.08 45.61 10.16 45.61C8.24 45.61 6.51 45.18 4.97 44.31Z' },
  // p
  { d: 'M36.06 42.26C37.2 41.61 38.09 40.7 38.73 39.51C39.38 38.32 39.7 36.97 39.7 35.45C39.7 33.94 39.38 32.59 38.73 31.42C38.09 30.24 37.2 29.33 36.06 28.67C34.92 28.01 33.66 27.68 32.27 27.68C30.85 27.68 29.58 28.01 28.46 28.67C27.33 29.33 26.45 30.24 25.81 31.42C25.16 32.59 24.84 33.94 24.84 35.45C24.84 36.97 25.16 38.32 25.81 39.51C26.45 40.7 27.33 41.61 28.46 42.26C29.58 42.9 30.85 43.23 32.27 43.23C33.66 43.23 34.92 42.9 36.06 42.26ZM37.54 26.6C39.06 27.45 40.24 28.64 41.1 30.18C41.96 31.73 42.39 33.48 42.39 35.45C42.39 37.45 41.96 39.22 41.1 40.76C40.24 42.3 39.06 43.5 37.56 44.34C36.05 45.19 34.35 45.61 32.46 45.61C30.84 45.61 29.38 45.28 28.08 44.61C26.78 43.94 25.71 42.96 24.88 41.67L24.88 52.78L22.18 52.78L22.18 25.48L24.76 25.48L24.76 29.43C25.57 28.11 26.64 27.1 27.97 26.39C29.29 25.69 30.79 25.33 32.46 25.33C34.33 25.33 36.02 25.76 37.54 26.6Z' },
  // e
  { d: 'M49.64 29.48C48.34 30.71 47.6 32.31 47.42 34.28L61.56 34.28C61.39 32.31 60.65 30.71 59.35 29.48C58.04 28.26 56.42 27.64 54.47 27.64C52.55 27.64 50.94 28.26 49.64 29.48ZM64.1 36.29L47.42 36.29C47.57 38.36 48.37 40.04 49.81 41.31C51.25 42.59 53.07 43.23 55.27 43.23C56.51 43.23 57.64 43.01 58.68 42.56C59.72 42.12 60.62 41.47 61.37 40.61L62.89 42.35C62 43.42 60.9 44.23 59.57 44.78C58.25 45.34 56.79 45.62 55.19 45.62C53.15 45.62 51.33 45.18 49.75 44.31C48.17 43.44 46.94 42.23 46.06 40.69C45.17 39.15 44.73 37.4 44.73 35.45C44.73 33.51 45.15 31.76 46 30.22C46.85 28.68 48.01 27.48 49.49 26.62C50.97 25.76 52.63 25.33 54.47 25.33C56.32 25.33 57.97 25.76 59.44 26.62C60.91 27.48 62.06 28.67 62.89 30.2C63.72 31.73 64.14 33.48 64.14 35.45L64.1 36.29Z' },
  // n
  { d: 'M83.54 27.51C85.02 28.97 85.76 31.08 85.76 33.86L85.76 45.43L83.07 45.43L83.07 34.13C83.07 32.06 82.55 30.48 81.51 29.39C80.47 28.3 79 27.76 77.08 27.76C74.93 27.76 73.23 28.4 71.98 29.67C70.72 30.95 70.1 32.71 70.1 34.96L70.1 45.43L67.41 45.43L67.41 25.48L69.99 25.48L69.99 29.16C70.72 27.95 71.74 27.01 73.04 26.34C74.34 25.67 75.85 25.33 77.57 25.33C80.07 25.33 82.06 26.06 83.54 27.51Z' },
  // badge
  { d: 'M205.69 2.79L205.28 4.04C205.14 4.48 204.73 4.78 204.27 4.78L202.95 4.78C201.92 4.78 201.5 6.1 202.33 6.7L203.39 7.47C203.77 7.74 203.92 8.22 203.78 8.66L203.37 9.91C203.05 10.89 204.17 11.71 205.01 11.1L206.07 10.33C206.44 10.06 206.95 10.06 207.32 10.33L208.38 11.1C209.22 11.71 210.34 10.89 210.02 9.91L209.61 8.66C209.47 8.22 209.63 7.74 210 7.47L211.06 6.7C211.9 6.1 211.47 4.78 210.44 4.78L209.12 4.78C208.66 4.78 208.26 4.48 208.11 4.04L207.71 2.79C207.39 1.81 206 1.81 205.69 2.79ZM196.83 8.44C196.83 3.78 200.6 0 205.26 0C209.92 0 213.7 3.78 213.7 8.44C213.7 13.1 209.92 16.87 205.26 16.87C200.6 16.87 196.83 13.1 196.83 8.44Z' },
  // T
  { d: 'M204.24 19.74L202.21 19.74L202.21 25.33L201.09 25.33L201.09 19.74L199.08 19.74L199.08 18.83L204.24 18.83L204.24 19.74Z' },
  // M
  { d: 'M206.48 18.83L208.35 23.81L210.22 18.83L211.68 18.83L211.68 25.33L210.56 25.33L210.56 23.19L210.67 20.32L208.75 25.33L207.94 25.33L206.02 20.32L206.14 23.19L206.14 25.33L205.01 25.33L205.01 18.83L206.48 18.83Z' },
];
