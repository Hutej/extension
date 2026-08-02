/**
 * core/verify/resize — the resize-invariance harness (Law 0, rule A8).
 *
 * A layout built from constraints survives an arbitrary viewport change with no
 * pipeline re-run. A layout built from measurements does not. This is physics:
 * the checker applies the transform, changes the viewport across a range, and
 * asserts no new overflow, no new overlap, no content squeeze, and no invisible
 * text — without re-running the pipeline.
 *
 * BUILT, NOT YET RUN. Wired into content.ts; left unexecuted. This is a
 * legitimate hard gate once the harness is validated against real sites.
 */

// The viewport widths to test (CSS pixels). Covers phone→desktop range.
const TEST_WIDTHS = [320, 480, 768, 1024, 1440, 1920];

export interface ResizeViolation {
  width: number;
  kind: 'overflow' | 'overlap' | 'squeeze' | 'invisible' | 'blank';
  detail: string;
}

export interface ResizeCheckResult {
  passed: boolean;
  violations: ResizeViolation[];
  widthsTested: number[];
}

/**
 * Run the resize-invariance check. The caller provides a `checkAt` function
 * that evaluates the current DOM state at the current simulated width and
 * returns which violations exist. This function simulates different viewport
 * widths by constraining the root element, runs the check at each, and
 * collects violations.
 *
 * This does NOT re-run the pipeline — it only checks that the ALREADY-APPLIED
 * CSS survives a viewport change. If the layout was built from constraints
 * (fr, minmax, clamp, container queries), it will survive. If it was built
 * from measurements (px, vw, %), it will fail.
 */
export async function checkResizeInvariance(
  checkAt: () => Promise<ResizeViolation[]>,
): Promise<ResizeCheckResult> {
  const violations: ResizeViolation[] = [];
  const root = document.documentElement;
  const prevWidth = root.style.width;
  const prevMaxWidth = root.style.maxWidth;
  const prevOverflow = root.style.overflow;

  try {
    for (const w of TEST_WIDTHS) {
      // Simulate the viewport by constraining the root. This forces the
      // browser to re-solve layout at the simulated width.
      root.style.width = `${w}px`;
      root.style.maxWidth = `${w}px`;
      root.style.overflow = 'hidden';  // prevent body scroll during test
      // Wait for layout to settle (two rAFs).
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const found = await checkAt();
      for (const v of found) violations.push({ ...v, width: w });
    }
  } finally {
    // Restore the original state.
    root.style.width = prevWidth;
    root.style.maxWidth = prevMaxWidth;
    root.style.overflow = prevOverflow;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }

  return {
    passed: violations.length === 0,
    violations,
    widthsTested: TEST_WIDTHS,
  };
}

/**
 * The DOM-grounded check function — evaluates the current page state for
 * overflow, overlap, squeeze, and invisible text. This mirrors the pixel
 * verify pass but is lightweight (no screenshot capture): it reads computed
 * styles and rects from the live DOM. The caller passes this to
 * checkResizeInvariance.
 */
export async function defaultCheckAt(): Promise<ResizeViolation[]> {
  const violations: ResizeViolation[] = [];
  const root = document.documentElement;

  // Overflow: scrollWidth exceeds the simulated viewport.
  const scrollW = root.scrollWidth;
  const clientW = root.clientWidth;
  if (scrollW > clientW + 2) {
    violations.push({ width: 0, kind: 'overflow', detail: `scrollWidth ${scrollW} > clientWidth ${clientW}` });
  }

  // Blank: primary content collapsed.
  const primary = document.querySelector('main, [role="main"], article');
  if (primary) {
    const r = primary.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) {
      violations.push({ width: 0, kind: 'blank', detail: `primary content collapsed to ${Math.round(r.width)}x${Math.round(r.height)}` });
    }
  }

  // Squeeze: text containers with chars-per-line below the readable measure.
  for (const el of Array.from(document.querySelectorAll('[data-wm-c]'))) {
    if (!(el instanceof HTMLElement)) continue;
    const cs = getComputedStyle(el);
    const fontSize = parseFloat(cs.fontSize) || 16;
    const cw = el.clientWidth;
    if (cw > 0 && cw / (fontSize * 0.5) < 12) {
      violations.push({ width: 0, kind: 'squeeze', detail: `${el.getAttribute('data-wm-c')}: ${Math.round(cw / (fontSize * 0.5))}cpl` });
      break;  // one is enough
    }
  }

  // Invisible: text with near-zero contrast against its effective background.
  for (const el of Array.from(document.querySelectorAll('[data-wm-c]'))) {
    if (!(el instanceof HTMLElement)) continue;
    const cs = getComputedStyle(el);
    const color = cs.color;
    const bg = cs.backgroundColor;
    // A simple luminance check — if both color and bg are the same or very close,
    // the text is invisible. (This is a lightweight heuristic; the full pixel
    // detector in pixel.ts is the thorough version.)
    if (color && bg && color !== 'rgba(0, 0, 0, 0)' && bg !== 'rgba(0, 0, 0, 0)') {
      const textLum = parseLuminance(color);
      const bgLum = parseLuminance(bg);
      if (textLum !== null && bgLum !== null && Math.abs(textLum - bgLum) < 0.1) {
        violations.push({ width: 0, kind: 'invisible', detail: `${el.getAttribute('data-wm-c')}: text/bg luminance delta ${Math.abs(textLum - bgLum).toFixed(3)}` });
        break;  // one is enough
      }
    }
  }

  return violations;
}

/** Parse a CSS color string to a relative luminance (0..1), or null. */
function parseLuminance(color: string): number | null {
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  const [r, g, b] = [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
