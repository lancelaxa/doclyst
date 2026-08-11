import { readFileSync, writeFileSync } from 'node:fs';
import { fillPdf } from './packages/core/dist/pdf/fill.js';
const rec = {
  CANDIDATE_NAME: 'Aisha Rahman',
  JOB_TITLE: 'Data Analyst',
  REPORTING_MANAGER: 'Wei Lun Tan',
  FULL_NAME: 'Priya Nair',
};
const r = await fillPdf(new Uint8Array(readFileSync('/tmp/fx-prepared.pdf')), (k) => rec[k] ?? '', {});
writeFileSync('/tmp/fx-filled.pdf', r.bytes);
console.log('replaced:', r.replaced, '| shrunk:', r.shrunkFields);
