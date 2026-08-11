#!/usr/bin/env node
/**
 * Fold the built app into one self-contained HTML file.
 *
 * The point is to make Doclyst usable by someone who has a browser and
 * nothing else: download `doclyst.html`, double-click it, done. No install,
 * no build step, no server, no network — it works offline and keeps working
 * on a machine that has never had Node on it.
 *
 * It also has to be one file rather than a folder, because a browser opening
 * a page from `file://` refuses to fetch a separate ES module across that
 * origin. Inlining sidesteps that: the bundle has no imports of its own, so
 * as an inline module it simply runs.
 *
 * Inlining does mean the script and style are no longer "self", which
 * `script-src 'self'` would block. Rather than loosening that to
 * `'unsafe-inline'`, the exact SHA-256 of each inlined block is pinned in the
 * policy — strictly narrower than the original, since only these two blocks
 * can execute. `connect-src 'none'`, the directive the privacy claim rests
 * on, is untouched.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const assets = join(dist, 'assets');

function findAsset(extension) {
  const match = readdirSync(assets).find((name) => name.endsWith(extension));
  if (!match) throw new Error(`No ${extension} asset found in ${assets}. Run the build first.`);
  return readFileSync(join(assets, match), 'utf8');
}

const sha256 = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

const script = findAsset('.js');
const style = findAsset('.css');

let html = readFileSync(join(dist, 'index.html'), 'utf8');

// Replace the built references with the code itself.
//
// The replacements are functions, not strings: `String.replace` treats `$&`,
// `$'` and friends as substitution patterns, and minified JavaScript is full
// of `$`. Passing a string would silently corrupt the inlined bundle — and
// the corruption shows up only as a CSP hash mismatch at load time.
html = html.replace(
  /<script[^>]*src="[^"]*"[^>]*><\/script>/,
  () => `<script type="module">${script}</script>`,
);
html = html.replace(/<link[^>]*rel="stylesheet"[^>]*>/, () => `<style>${style}</style>`);

if (html.includes('<script type="module" src') || html.includes('rel="stylesheet"')) {
  throw new Error('An asset reference survived inlining; the single file would be incomplete.');
}

// Re-pin the policy to exactly these two blocks.
html = html.replace(/script-src 'self'/, () => `script-src ${sha256(script)}`);
html = html.replace(/style-src 'self'/, () => `style-src ${sha256(style)}`);

const target = join(dist, 'doclyst.html');
writeFileSync(target, html);

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`Wrote apps/web/dist/doclyst.html (${kb} KB, self-contained)`);
