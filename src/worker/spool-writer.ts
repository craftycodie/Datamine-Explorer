// Where a live session's log goes: a file in the temp folder (Tauri) or in the browser's private
// file system (OPFS), plus its sidecar. The writer batches what the session produces and appends
// it every 100 ms or 64 KiB, sidecar first so that every entry in the text has its line.
import { sidecarPathOf } from "./sidecar";
import type { SpoolSink } from "./live-session";

export const FLUSH_INTERVAL_MS = 100;
export const FLUSH_CHARACTERS = 64 * 1024;

// The spool folder, as the worker sees it. Paths are whatever the host reads by; the sidecar of a
// path is `sidecarPathOf(path)`.
export interface SpoolHost {
  // Makes the text file and an empty sidecar, and gives the text file's path.
  create(name: string): Promise<string>;
  // The newest spool whose sidecar says it is from this server (its prefix URL), if any.
  find(prefix: string): Promise<string | undefined>;
  // Opens an existing spool to append to.
  resume(path: string): Promise<void>;
  append(path: string, bytes: Uint8Array): Promise<void>;
  // Everything is written; the files stay readable.
  finish(path: string): Promise<void>;
}

export interface WriterHooks {
  // The first bytes are in the file.
  opened(path: string): Promise<void>;
  // More bytes are.
  grown(): Promise<void>;
  failed(message: string): void;
}

const encoder = new TextEncoder();

export class SpoolWriter implements SpoolSink {
  path: string | undefined;
  // bytes of text written
  bytes = 0;
  private texts: string[] = [];
  private sides: string[] = [];
  private pending = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private opened = false;
  private broken = false;

  // `start` names a new spool and gives the sidecar's first line.
  constructor(
    private host: SpoolHost,
    private start: () => { name: string; head: string },
    private hooks: WriterHooks
  ) {}

  // Carry on in a spool that exists and is already open in the engine.
  attach(path: string, size: number) {
    this.path = path;
    this.opened = true;
    this.bytes = size;
  }

  text(chunk: string) {
    this.texts.push(chunk);
    this.queued(chunk.length);
  }

  side(chunk: string) {
    this.sides.push(chunk);
    this.queued(chunk.length);
  }

  private queued(characters: number) {
    this.pending += characters;
    if (this.pending >= FLUSH_CHARACTERS) {
      void this.flush();
    } else {
      this.timer ??= setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.chain = this.chain.then(() => this.write());
    return this.chain;
  }

  private async write() {
    if (this.broken || (this.texts.length === 0 && this.sides.length === 0)) {
      return;
    }
    const text = this.texts.join("");
    let side = this.sides.join("");
    this.texts = [];
    this.sides = [];
    this.pending = 0;
    try {
      if (!this.path) {
        const { name, head } = this.start();
        this.path = await this.host.create(name);
        side = head + side;
      }
      if (side) {
        await this.host.append(sidecarPathOf(this.path), encoder.encode(side));
      }
      if (text) {
        const bytes = encoder.encode(text);
        await this.host.append(this.path, bytes);
        this.bytes += bytes.length;
        if (this.opened) {
          await this.hooks.grown();
        } else {
          this.opened = true;
          await this.hooks.opened(this.path);
        }
      }
    } catch (error) {
      this.broken = true;
      this.hooks.failed(error instanceof Error ? error.message : String(error));
    }
  }

  // Writes what is left and lets go of the files for writing.
  async close() {
    await this.flush();
    if (this.path && !this.broken) {
      await this.host.finish(this.path).catch(() => undefined);
    }
  }
}
