import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { randomBytes } from 'node:crypto';
import {
  chooseCompressionLevel,
  DEFLATE_LEVEL,
  STORE_LEVEL,
} from '../src/internal/compression.js';
import { buildZip } from '../src/output/zip.js';

describe('chooseCompressionLevel', () => {
  it('deflates text, which compresses well', () => {
    const xml = new TextEncoder().encode('<w:p><w:r><w:t>hello</w:t></w:r></w:p>'.repeat(200));
    expect(chooseCompressionLevel(xml)).toBe(DEFLATE_LEVEL);
  });

  it('stores incompressible data rather than deflating it twice', () => {
    // Stands in for an embedded JPEG or PNG: already compressed, so a second
    // pass costs time and returns marginally larger output.
    expect(chooseCompressionLevel(new Uint8Array(randomBytes(100_000)))).toBe(STORE_LEVEL);
  });

  it('does not bother probing very small parts', () => {
    expect(chooseCompressionLevel(new Uint8Array(16))).toBe(DEFLATE_LEVEL);
  });

  it('handles an empty part', () => {
    expect(() => chooseCompressionLevel(new Uint8Array())).not.toThrow();
  });
});

describe('buildZip compression', () => {
  it('round-trips incompressible entries byte for byte', () => {
    // Correctness of the stored path matters more than its speed: a generated
    // document must come back out of the archive exactly as it went in.
    const document = new Uint8Array(randomBytes(50_000));
    const archive = buildZip([{ name: 'a.docx', bytes: document }]);
    expect(unzipSync(archive)['a.docx']).toEqual(document);
  });

  it('round-trips compressible entries byte for byte', () => {
    const document = new TextEncoder().encode('x'.repeat(50_000));
    const archive = buildZip([{ name: 'a.txt', bytes: document }]);
    expect(unzipSync(archive)['a.txt']).toEqual(document);
  });

  it('still compresses what is worth compressing', () => {
    const compressible = new TextEncoder().encode('a'.repeat(100_000));
    expect(buildZip([{ name: 'a.txt', bytes: compressible }]).length).toBeLessThan(5_000);
  });
});
