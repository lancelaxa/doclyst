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
  // `slice()` detaches from any larger buffer so the Blob owns exactly these
  // bytes, and Blob wants a plain ArrayBuffer rather than a typed-array view.
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mimeTypeFor(filename) });
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
