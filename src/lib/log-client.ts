// The main thread's end of the log worker: sends its requests, answers its file reads from the
// backend, and hands back what it reports.
import type { CallRequest, CallResult, WorkerRequest, WorkerResponse } from "../worker/protocol";
import { translate } from "../localization";
import { backend } from "./backend";
import type { Filters, SearchSpec } from "./filter";
import type { SourceSpec } from "./types";

export class LogClient {
  private worker: Worker;
  private nextReq = 0;
  private waiting = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();

  constructor(private onMessage: (message: WorkerResponse) => void) {
    this.worker = new Worker(new URL("../worker/log.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.receive(event.data);
    this.worker.onerror = (event) => {
      this.onMessage({ id: -1, message: translate("worker_failed", { error: event.message }), type: "error" });
    };
  }

  private post(request: WorkerRequest, transfer: Transferable[] = []) {
    this.worker.postMessage(request, transfer);
  }

  private receive(message: WorkerResponse) {
    switch (message.type) {
      case "host":
        void this.hostAnswer(message);
        break;
      case "result":
        this.waiting.get(message.req)?.resolve(message.value as never);
        this.waiting.delete(message.req);
        break;
      case "failed":
        this.waiting.get(message.req)?.reject(new Error(message.message));
        this.waiting.delete(message.req);
        break;
      default:
        this.onMessage(message);
    }
  }

  private async hostAnswer(message: Extract<WorkerResponse, { type: "host" }>) {
    const { call, callId } = message;
    try {
      if (call.kind === "stat") {
        this.post({ callId, stat: await backend.stat(call.path), type: "hostResult" });
        return;
      }
      if (call.kind !== "read") {
        this.post({ callId, text: await backend.spoolCall(call), type: "hostResult" });
        return;
      }
      const bytes = await backend.readRange(call.path, call.offset, call.length);
      const exact = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
      const buffer = (exact ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer;
      this.post({ bytes: buffer, callId, type: "hostResult" }, [buffer]);
    } catch (error) {
      this.post({ callId, error: error instanceof Error ? error.message : String(error), type: "hostResult" });
    }
  }

  open(id: number, path: string) {
    this.post({ id, path, type: "open" });
  }

  connect(id: number, url: string, fresh: boolean) {
    this.post({ fresh, id, spool: backend.kind === "tauri" ? "tauri" : "opfs", type: "connect", url });
  }

  sources(id: number, sources: SourceSpec[]) {
    this.post({ id, sources, spool: backend.kind === "tauri" ? "tauri" : "opfs", type: "sources" });
  }

  disconnect(id: number) {
    this.post({ id, type: "disconnect" });
  }

  close(id: number) {
    this.post({ id, type: "close" });
  }

  refresh(id: number) {
    this.post({ id, type: "refresh" });
  }

  filters(filters: Filters, onlyMatches: boolean) {
    this.post({ filters, onlyMatches, type: "filters" });
  }

  search(spec: SearchSpec | undefined) {
    this.post({ spec, type: "search" });
  }

  call<N extends CallRequest["name"]>(call: Extract<CallRequest, { name: N }>): Promise<CallResult[N]> {
    return new Promise((resolve, reject) => {
      const req = ++this.nextReq;
      this.waiting.set(req, { reject, resolve: resolve as (value: never) => void });
      this.post({ call, req, type: "call" });
    });
  }

  terminate() {
    this.worker.terminate();
    for (const pending of this.waiting.values()) {
      pending.reject(new Error("closed"));
    }
    this.waiting.clear();
  }
}
