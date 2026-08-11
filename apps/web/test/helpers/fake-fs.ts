/**
 * A stand-in for the File System Access API, injected into the page.
 *
 * The real pickers open native dialogs that cannot be driven from a test, but
 * everything worth testing happens after the picker returns: the streaming
 * loop, the write-per-document behaviour, entry naming, and the bytes that end
 * up on disk. Faking only the two picker entry points leaves all of that on
 * the real code path, and the fake records exactly what was written so the
 * output can be verified byte for byte.
 *
 * Returned as a string because it is installed with `page.addInitScript`, so
 * it must run in the browser before the app's own module loads.
 */
export const installFakeFileSystem = `
(() => {
  const written = {};       // filename -> number[]
  const order = [];         // filenames in the order they were closed
  const aborted = [];
  // Records how many documents existed at once, to prove memory stays flat.
  let openWritables = 0;
  let maxOpenWritables = 0;

  function makeWritable(commit) {
    const chunks = [];
    openWritables += 1;
    maxOpenWritables = Math.max(maxOpenWritables, openWritables);
    return {
      async write(data) {
        chunks.push(Array.from(new Uint8Array(
          data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        )));
      },
      async close() {
        openWritables -= 1;
        commit([].concat(...chunks));
      },
      async abort(reason) {
        openWritables -= 1;
        commit(null, reason);
      },
    };
  }

  window.__fakeFs = { written, order, aborted, stats: () => ({ maxOpenWritables }) };

  window.showDirectoryPicker = async () => ({
    name: 'fake-folder',
    async getFileHandle(name) {
      return {
        async createWritable() {
          return makeWritable((bytes, reason) => {
            if (bytes === null) { aborted.push(name); return; }
            written[name] = bytes;
            order.push(name);
          });
        },
      };
    },
  });

  window.showSaveFilePicker = async ({ suggestedName } = {}) => ({
    async createWritable() {
      return makeWritable((bytes, reason) => {
        if (bytes === null) { aborted.push(suggestedName); return; }
        written[suggestedName ?? 'archive.zip'] = bytes;
        order.push(suggestedName ?? 'archive.zip');
      });
    },
  });
})();
`;

/** Remove the pickers, so the page behaves like Firefox or Safari. */
export const removeFileSystemAccess = `
(() => {
  delete window.showDirectoryPicker;
  delete window.showSaveFilePicker;
})();
`;
