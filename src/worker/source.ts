// Where file bytes come from: the main thread reads them for the worker.
export interface ByteSource {
  read(offset: number, length: number): Promise<Uint8Array>;
}

// How much of the file one read asks for while indexing and searching.
export const CHUNK_BYTES = 8 * 1024 * 1024;
// An entry is read up to this size; the rest of a longer one is not shown or searched.
export const ENTRY_BYTES_MAXIMUM = 8 * 1024 * 1024;
