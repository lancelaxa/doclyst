/**
 * Handing generated documents back to the user.
 *
 * Object URLs point at an in-memory blob scoped to this tab; they are not
 * addresses on a server and nothing is uploaded to produce one. Each is
 * revoked as soon as the download has been handed to the browser, so the
 * generated personal data is not left reachable for the life of the page.
 */

const MIME_TYPES: Readonly<Record<string, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  zip: 'application/zip',
};

function mimeTypeFor(filename: string): string {
  const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  return MIME_TYPES[extension] ?? 'application/octet-stream';
}

/** Trigger a download of `bytes` under `filename`. */
export function downloadBytes(bytes: Uint8Array, filename: string): void {
  // The array is handed to Blob directly rather than copied first. Blob accepts
  // a typed-array view, and it takes its own snapshot of the bytes — so an
  // explicit copy just doubles peak memory, which for a ZIP of several hundred
  // documents is hundreds of megabytes that can push a tab over its heap limit.
  // The cast narrows `Uint8Array<ArrayBufferLike>` to the `ArrayBuffer`-backed
  // form `BlobPart` requires. Nothing here ever produces a SharedArrayBuffer —
  // the engine returns plain arrays — so the wider type is only a limitation of
  // the standard library's signature.
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeTypeFor(filename) });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();

  // Revoking immediately can cut the download short in some browsers, so the
  // handle is released on the next turn instead of being kept for the session.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
