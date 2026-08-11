import { readFileSync, writeFileSync } from 'node:fs';
import { preparePdfTemplate } from './packages/core/dist/pdf/autofields.js';
const r = await preparePdfTemplate(new Uint8Array(readFileSync('/tmp/fx.pdf')));
writeFileSync('/tmp/fx-prepared.pdf', r.bytes);
console.log('fields:');
for (const f of r.fields) console.log(`  ${f.name.padEnd(20)} p${f.page} x=${f.x.toFixed(2)} y=${f.y.toFixed(2)} w=${f.width.toFixed(2)} h=${f.height.toFixed(2)} size=${f.fontSizePt.toFixed(1)}`);
console.log('skipped:', r.skipped);
