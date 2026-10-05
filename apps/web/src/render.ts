import { AnnotationMode, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import type { PageRenderer, RenderedPage } from '@doclyst/core';

/**
 * Rendering PDF pages to pixels, for comparing how a signed copy looks with
 * how the letter looked when it was sent.
 *
 * pdf.js, Mozilla's PDF renderer, does the drawing. It is bundled into the
 * page rather than loaded from anywhere, and it is configured so that it has
 * no reason to reach for the network — no font downloads, no WebAssembly
 * decoders, no form scripting — on top of the page's own policy, which would
 * block it anyway.
 *
 * The legacy build is used: the current one relies on JavaScript features
 * that only the newest browsers have, and the page has to work on whatever
 * an HR team's machines run.
 *
 * pdf.js normally parses in a separate worker loaded from its own file. A
 * page that refuses all network access, and that also has to work as one
 * self-contained file opened from disk, cannot load one. Handing pdf.js its
 * worker code directly makes it run on the page's own thread instead, which
 * it supports for exactly this situation.
 */
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker;

/**
 * Pixels per point. 2 draws an A4 page at about 1190 × 1680, enough for a
 * changed digit in 11-point text to differ by dozens of pixels.
 */
const SCALE = 2;

export const renderPages: PageRenderer = async (bytes) => {
  const task = getDocument({
    // pdf.js takes ownership of the buffer it is given, so it gets a copy.
    data: bytes.slice(),
    useWasm: false,
    enableXfa: false,
    useSystemFonts: true,
    stopAtErrors: false,
    verbosity: 0,
    maxImageSize: 32 * 1024 * 1024,
  });

  const document_ = await task.promise;
  try {
    const pages: RenderedPage[] = [];
    for (let number = 1; number <= document_.numPages; number += 1) {
      const page = await document_.getPage(number);
      const viewport = page.getViewport({ scale: SCALE });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('No canvas available.');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);

      // Annotations are drawn too: a signature added as an annotation, or a
      // box drawn over the salary as one, is part of what a reader sees.
      await page.render({ canvas, canvasContext: context, viewport, annotationMode: AnnotationMode.ENABLE }).promise;

      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const [x0, y0, x1, y1] = page.view as [number, number, number, number];
      pages.push({
        width: canvas.width,
        height: canvas.height,
        data: image.data,
        scale: SCALE,
        viewBox: [x0, y0, x1, y1],
        rotation: page.rotate,
      });
      page.cleanup();
      // Release the canvas's memory now rather than whenever it is collected.
      canvas.width = 0;
      canvas.height = 0;
    }
    return pages;
  } finally {
    await task.destroy();
  }
};
