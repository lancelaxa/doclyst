// pdf.js ships no type declarations for its worker module. Only the one
// export used here is declared.
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
