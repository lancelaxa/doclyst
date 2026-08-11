import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

/**
 * Writing straight to disk with the File System Access API.
 *
 * The in-memory path holds every generated document until the user downloads
 * them, and building a ZIP holds a second copy. For a few hundred image-heavy
 * documents that reaches a gigabyte or more, at which point browsers cancel
 * the download without reporting it. Streaming each document to a folder — or
 * each entry into a ZIP — as it is produced keeps peak memory to roughly one
 * document, whatever the batch size.
 *
 * The API is Chromium-only today, so everything here is progressive
 * enhancement: {@link supportsFileSystemAccess} gates it, and the existing
 * download path remains for browsers without it.
 *
 * Privacy note: the picker grants this page write access to exactly the
 * location the user chose, for this session only. The handle is deliberately
 * never persisted — storing it in IndexedDB is the usual trick for reusing a
 * folder across visits, and doing so would break this app's guarantee that it
 * writes nothing to browser storage.
 */

/** Minimal shapes of the File System Access API, which TS does not ship. */
interface WritableFileStream {
  write(data: BufferSource): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

export interface FileHandleLike {
  createWritable(options?: { keepExistingData?: boolean }): Promise<WritableFileStream>;
}

export interface DirectoryHandleLike {
  readonly name?: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
}

interface FileSystemAccessWindow {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<DirectoryHandleLike>;
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileHandleLike>;
}

function api(): FileSystemAccessWindow {
  return window as unknown as FileSystemAccessWindow;
}

/**
 * Whether this browser can write to a user-chosen location.
 *
 * Also requires a secure context: the API is unavailable over plain HTTP, and
 * checking here gives a clearer answer than letting the call fail.
 */
export function supportsFileSystemAccess(): boolean {
  return (
    window.isSecureContext &&
    typeof api().showDirectoryPicker === 'function' &&
    typeof api().showSaveFilePicker === 'function'
  );
}

/** Raised when the user dismisses a picker; not an error worth reporting. */
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Ask the user for a folder to write documents into. */
export async function pickDirectory(): Promise<DirectoryHandleLike | undefined> {
  const picker = api().showDirectoryPicker;
  if (!picker) return undefined;
  return picker({ mode: 'readwrite' });
}

/** Ask the user where to save a ZIP archive. */
export async function pickZipFile(suggestedName: string): Promise<FileHandleLike | undefined> {
  const picker = api().showSaveFilePicker;
  if (!picker) return undefined;
  return picker({
    suggestedName,
    types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
  });
}

/** Write one file into a directory, replacing anything already there. */
export async function writeFileTo(
  directory: DirectoryHandleLike,
  filename: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await directory.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes as Uint8Array<ArrayBuffer>);
  } catch (error) {
    // Leaving a half-written document on disk would be worse than none: it
    // would look like a finished contract. Abort discards it where supported.
    await writable.abort?.(error).catch(() => undefined);
    throw error;
  }
  await writable.close();
}

/**
 * A ZIP being written incrementally to a file on disk.
 *
 * fflate hands finished chunks to a synchronous callback, while writing to
 * disk is asynchronous. Chunks are therefore appended to a promise chain and
 * awaited between entries, which bounds how much of the archive is ever held
 * in memory to roughly one document.
 */
export class StreamingZipWriter {
  readonly #zip: Zip;
  readonly #writable: WritableFileStream;
  #pending: Promise<void> = Promise.resolve();
  #failure: unknown;
  #finished: Promise<void>;
  #resolveFinished!: () => void;
  #rejectFinished!: (error: unknown) => void;

  private constructor(writable: WritableFileStream) {
    this.#writable = writable;
    this.#finished = new Promise((resolve, reject) => {
      this.#resolveFinished = resolve;
      this.#rejectFinished = reject;
    });

    this.#zip = new Zip((error, chunk, final) => {
      if (error) {
        this.#failure ??= error;
        this.#rejectFinished(error);
        return;
      }
      // Serialise writes: the callback can fire again before the previous
      // write resolves, and out-of-order chunks would corrupt the archive.
      this.#pending = this.#pending.then(async () => {
        if (this.#failure) return;
        try {
          await this.#writable.write(chunk as Uint8Array<ArrayBuffer>);
          if (final) this.#resolveFinished();
        } catch (writeError) {
          this.#failure ??= writeError;
          this.#rejectFinished(writeError);
        }
      });
    });
  }

  static async create(handle: FileHandleLike): Promise<StreamingZipWriter> {
    return new StreamingZipWriter(await handle.createWritable());
  }

  /**
   * Add one document to the archive.
   *
   * Generated .docx files are themselves ZIPs and PDFs are largely compressed,
   * so entries are stored rather than deflated a second time — the same choice
   * the in-memory writer makes, and here it also avoids a pointless CPU cost
   * per document.
   */
  async add(filename: string, bytes: Uint8Array, compress: boolean): Promise<void> {
    if (this.#failure) throw this.#failure;

    const entry = compress ? new ZipDeflate(filename, { level: 6 }) : new ZipPassThrough(filename);
    // Set after construction: the deflate options do not carry a timestamp.
    // Fixing it matches the in-memory writer, so the archive stays
    // reproducible and records nothing about when each row was processed.
    entry.mtime = FIXED_TIMESTAMP;

    this.#zip.add(entry);
    entry.push(bytes, true);

    // Waiting here is what keeps memory flat: the next document is not filled
    // until this one has reached the disk.
    await this.#pending;
    if (this.#failure) throw this.#failure;
  }

  /** Finish the archive and close the file. */
  async close(): Promise<void> {
    if (this.#failure) throw this.#failure;
    this.#zip.end();
    await this.#pending;
    await this.#finished;
    await this.#writable.close();
  }

  /** Give up, discarding the partial archive. */
  async abort(reason?: unknown): Promise<void> {
    this.#failure ??= reason ?? new Error('aborted');
    await this.#writable.abort?.(reason).catch(() => undefined);
  }
}

/** Matches the engine's fixed archive timestamp, keeping output reproducible. */
const FIXED_TIMESTAMP = new Date(Date.UTC(1980, 0, 1));
