import type { Box } from '../pdf/content.js';

/**
 * Comparing pages as they look, not as they are built.
 *
 * The structural comparison in `returned.ts` reads what a page says it draws.
 * A PDF can say one thing and show another — a font whose "4" is drawn as a
 * "9", a layer switched off, a pattern that paints over text, instructions
 * hidden from a parser that a viewer still runs. Rendering both versions and
 * comparing the pixels catches all of those at once, because what is
 * compared is what a person would see.
 *
 * Rendering needs a PDF renderer and a canvas, which this package does not
 * have; the caller supplies one (the browser page uses pdf.js). Everything
 * here works on the pixels it is given.
 */

/** One page rendered to RGBA pixels on a white background. */
export interface RenderedPage {
  readonly width: number;
  readonly height: number;
  /** RGBA, four bytes per pixel, row by row from the top. */
  readonly data: Uint8Array | Uint8ClampedArray;
  /** Pixels per PDF point. */
  readonly scale: number;
  /** The area of the page rendered, in PDF points: [x0, y0, x1, y1]. */
  readonly viewBox: readonly [number, number, number, number];
  /** Page rotation in degrees. */
  readonly rotation: number;
}

/** Renders every page of a PDF, all at the same scale. */
export type PageRenderer = (bytes: Uint8Array) => Promise<readonly RenderedPage[]>;

export interface VisualDifference {
  /** Places, in PDF points, where ink the sent page had no longer shows. */
  readonly lost: readonly Box[];
  /** Places where new ink shows that nothing structural accounts for. */
  readonly unexplained: readonly Box[];
}

/** Darker than this (0–255 luminance) counts as ink. */
const INK_THRESHOLD = 160;
/** Side of the square cells pixels are counted in, in pixels. */
const CELL = 12;
/** Lost or added ink pixels in one cell before it counts. */
const CELL_MIN = 8;
/** Margin around a structural addition that still counts as explained, in pixels. */
const EXPLAINED_MARGIN = 6;

/**
 * Compare a sent page with its returned copy, pixel by pixel.
 *
 * Ink the sent page had and the returned page does not is *lost*: the
 * original letter no longer shows there. Returned ink is widened by one pixel
 * first, so the half-pixel shifts of re-saving in another program never count.
 * New ink is fine — it is the signature — provided the structural comparison
 * already accounts for it; `explained` is where it found additions. Anything
 * else new is *unexplained*, and worth a look.
 *
 * Pages of different sizes are not compared here; the structural check has
 * already reported those.
 */
export function compareRenderedPages(
  sent: RenderedPage,
  returned: RenderedPage,
  explained: readonly Box[],
): VisualDifference {
  if (sent.width !== returned.width || sent.height !== returned.height) return { lost: [], unexplained: [] };
  const { width, height } = sent;

  const sentInk = inkOf(sent);
  const returnedInk = inkOf(returned);
  const sentNear = dilate(sentInk, width, height);
  const returnedNear = dilate(returnedInk, width, height);

  const columns = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const lostCounts = new Uint32Array(columns * rows);
  const addedCounts = new Uint32Array(columns * rows);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const cell = Math.floor(y / CELL) * columns + Math.floor(x / CELL);
      if (sentInk[i] && !returnedNear[i]) lostCounts[cell] = (lostCounts[cell] as number) + 1;
      if (returnedInk[i] && !sentNear[i]) addedCounts[cell] = (addedCounts[cell] as number) + 1;
    }
  }

  // On a turned page the mapping from points to pixels is not the simple one
  // used here, so additions cannot be lined up; lost ink is still reported.
  const canExplain = sent.rotation % 360 === 0;
  const explainedPixels = explained.map((box) => toPixels(box, sent, EXPLAINED_MARGIN));
  const lost: Box[] = [];
  const unexplained: Box[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const cell = row * columns + column;
      const pixels = { x0: column * CELL, y0: row * CELL, x1: (column + 1) * CELL, y1: (row + 1) * CELL };
      if ((lostCounts[cell] as number) >= CELL_MIN) lost.push(toPoints(pixels, sent));
      if (canExplain && (addedCounts[cell] as number) >= CELL_MIN && !explainedPixels.some((box) => overlaps(box, pixels))) {
        unexplained.push(toPoints(pixels, sent));
      }
    }
  }
  return { lost, unexplained };
}

function inkOf(page: RenderedPage): Uint8Array {
  const ink = new Uint8Array(page.width * page.height);
  const { data } = page;
  for (let i = 0, p = 0; i < ink.length; i += 1, p += 4) {
    const alpha = (data[p + 3] as number) / 255;
    // Composited onto white, in case the renderer left transparency.
    const r = 255 - alpha * (255 - (data[p] as number));
    const g = 255 - alpha * (255 - (data[p + 1] as number));
    const b = 255 - alpha * (255 - (data[p + 2] as number));
    ink[i] = 0.299 * r + 0.587 * g + 0.114 * b < INK_THRESHOLD ? 1 : 0;
  }
  return ink;
}

/** Widen every ink pixel to its eight neighbours. */
function dilate(ink: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(ink.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!ink[y * width + x]) continue;
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx;
          if (xx >= 0 && xx < width) out[yy * width + xx] = 1;
        }
      }
    }
  }
  return out;
}

/** A box in PDF points as pixels on the rendered page, widened by `margin`. */
function toPixels(box: Box, page: RenderedPage, margin: number): Box {
  const [vx0, , , vy1] = page.viewBox;
  return {
    x0: (box.x0 - vx0) * page.scale - margin,
    x1: (box.x1 - vx0) * page.scale + margin,
    y0: (vy1 - box.y1) * page.scale - margin,
    y1: (vy1 - box.y0) * page.scale + margin,
  };
}

/** A box in pixels as PDF points. */
function toPoints(box: Box, page: RenderedPage): Box {
  const [vx0, , , vy1] = page.viewBox;
  return {
    x0: vx0 + box.x0 / page.scale,
    x1: vx0 + box.x1 / page.scale,
    y0: vy1 - box.y1 / page.scale,
    y1: vy1 - box.y0 / page.scale,
  };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}
