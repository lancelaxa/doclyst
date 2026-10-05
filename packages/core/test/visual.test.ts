import { describe, expect, it } from 'vitest';
import { compareRenderedPages, type RenderedPage } from '../src/verify/visual.js';

/**
 * The pixel comparison, on synthetic pages: a white page with dark
 * rectangles standing in for words. Scale 1, so a pixel is a point, and the
 * view box puts pixel (0, 0) at the top left of a 200 × 100 point page.
 */

const WIDTH = 200;
const HEIGHT = 100;

function page(...inked: { x: number; y: number; w: number; h: number; grey?: number }[]): RenderedPage {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(255);
  for (const { x, y, w, h, grey = 0 } of inked) {
    for (let row = y; row < y + h; row += 1) {
      for (let column = x; column < x + w; column += 1) {
        const p = (row * WIDTH + column) * 4;
        data[p] = grey;
        data[p + 1] = grey;
        data[p + 2] = grey;
      }
    }
  }
  return { width: WIDTH, height: HEIGHT, data, scale: 1, viewBox: [0, 0, WIDTH, HEIGHT], rotation: 0 };
}

const WORD = { x: 20, y: 20, w: 30, h: 10 };
const SALARY = { x: 100, y: 20, w: 25, h: 10 };

describe('compareRenderedPages', () => {
  it('finds nothing between identical pages', () => {
    expect(compareRenderedPages(page(WORD, SALARY), page(WORD, SALARY), [])).toEqual({ lost: [], unexplained: [] });
  });

  it('ignores a shift of a pixel, as re-saving in another program can cause', () => {
    const shifted = { ...SALARY, x: SALARY.x + 1 };
    expect(compareRenderedPages(page(WORD, SALARY), page(WORD, shifted), [])).toEqual({ lost: [], unexplained: [] });
  });

  it('reports ink that no longer shows, wherever the file says it is', () => {
    // The salary is gone from the picture: drawn white, hidden in a layer,
    // or drawn with a font whose shapes were swapped.
    const result = compareRenderedPages(page(WORD, SALARY), page(WORD), []);
    expect(result.lost.length).toBeGreaterThan(0);
    for (const box of result.lost) {
      // In PDF points, y up: the salary's band is y 70–80 on this page.
      expect(box.x0).toBeGreaterThanOrEqual(90);
      expect(box.x1).toBeLessThanOrEqual(135);
      expect(box.y1).toBeGreaterThan(70);
    }
  });

  it('counts text faded to near-white as lost', () => {
    const faded = { ...SALARY, grey: 230 };
    expect(compareRenderedPages(page(WORD, SALARY), page(WORD, faded), []).lost.length).toBeGreaterThan(0);
  });

  it('accepts new ink where the structural check found an addition', () => {
    const signature = { x: 60, y: 70, w: 50, h: 8 };
    const explained = [{ x0: 60, y0: 22, x1: 110, y1: 30 }];
    expect(compareRenderedPages(page(WORD), page(WORD, signature), explained)).toEqual({ lost: [], unexplained: [] });
  });

  it('reports new ink nothing accounts for', () => {
    const signature = { x: 60, y: 70, w: 50, h: 8 };
    const result = compareRenderedPages(page(WORD), page(WORD, signature), []);
    expect(result.lost).toEqual([]);
    expect(result.unexplained.length).toBeGreaterThan(0);
  });

  it('does not treat a dark mark over existing text as lost text', () => {
    // Ink on ink: the original is still dark there, so nothing was hidden.
    const over = { x: 15, y: 18, w: 40, h: 14 };
    expect(compareRenderedPages(page(WORD), page(over), [{ x0: 15, y0: 68, x1: 55, y1: 82 }]).lost).toEqual([]);
  });

  it('leaves pages of different sizes to the structural check', () => {
    const other: RenderedPage = { ...page(), width: 100, data: new Uint8ClampedArray(100 * HEIGHT * 4) };
    expect(compareRenderedPages(page(WORD), other, [])).toEqual({ lost: [], unexplained: [] });
  });
});
