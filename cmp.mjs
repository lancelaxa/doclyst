import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { readPageContent, readPageFonts, readGlyphs } from './packages/core/dist/pdf/content.js';

const doc = await PDFDocument.load(readFileSync('/tmp/fx.pdf'), { updateMetadata: false });
const page = doc.getPage(0);
const glyphs = readGlyphs(readPageContent(page), readPageFonts(page));

// Group into runs sharing a baseline, the way a reader sees lines.
const lines = new Map();
for (const g of glyphs) {
  const key = g.y.toFixed(2);
  if (!lines.has(key)) lines.set(key, []);
  lines.get(key).push(g);
}
console.log('=== Doclyst extraction ===');
for (const [y, gs] of [...lines].sort((a, b) => Number(b[0]) - Number(a[0]))) {
  gs.sort((a, b) => a.x - b.x);
  const text = gs.map((g) => g.text).join('');
  console.log(`  x0=${gs[0].x.toFixed(2).padStart(7)} y=${Number(y).toFixed(2).padStart(7)} size=${gs[0].size.toFixed(2).padStart(5)} ${JSON.stringify(text)}`);
}
