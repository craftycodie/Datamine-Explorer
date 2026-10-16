import "./buffer-shim";
import type { FileStat } from "../lib/types";
import { type Host, LogEngine } from "./engine";
import { isOpfsPath } from "../lib/opfs";
import { OpfsSpool } from "./opfs-spool";
import type { HostCall, SpoolMode, WorkerRequest, WorkerResponse } from "./protocol";
import type { SpoolHost } from "./spool-writer";

function send(message: WorkerResponse, transfer: Transferable[] = []) {
  postMessage(message, { transfer });
}

// The worker reads files by asking the main thread, which owns the backend. Paths in OPFS are the
// worker's own.
type HostResult = Uint8Array | FileStat | string | undefined;
const waiting = new Map<number, { resolve: (value: HostResult) => void; reject: (error: Error) => void }>();
let nextCall = 0;

function hostCall<T extends HostResult>(call: HostCall, transfer: Transferable[] = []): Promise<T> {
  return new Promise((resolve, reject) => {
    const callId = ++nextCall;
    waiting.set(callId, { reject, resolve: resolve as (value: HostResult) => void });
    send({ call, callId, type: "host" }, transfer);
  });
}

const opfs = new OpfsSpool();
let spoolMode: SpoolMode = "opfs";

const tauriSpool: SpoolHost = {
  append: (path, bytes) => {
    const copy = bytes.slice().buffer as ArrayBuffer;
    return hostCall<undefined>({ bytes: copy, kind: "spoolAppend", path }, [copy]);
  },
  create: (name) => hostCall<string>({ kind: "spoolCreate", name }),
  find: (prefix) => hostCall<string | undefined>({ kind: "spoolFind", prefix }),
  finish: (path) => hostCall<undefined>({ kind: "spoolFinish", path }),
  resume: (path) => hostCall<undefined>({ kind: "spoolResume", path }),
};

const host: Host = {
  read: (path, offset, length) =>
    isOpfsPath(path) ? opfs.read(path, offset, length) : hostCall<Uint8Array>({ kind: "read", length, offset, path }),
  get spool() {
    return spoolMode === "tauri" ? tauriSpool : opfs;
  },
  stat: (path) => (isOpfsPath(path) ? opfs.stat(path) : hostCall<FileStat>({ kind: "stat", path })),
};

const engine = new LogEngine(host, send);

onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  switch (request.type) {
    case "open":
      void engine.open(request.id, request.path);
      break;
    case "refresh":
      void engine.refresh(request.id);
      break;
    case "connect":
      spoolMode = request.spool;
      engine.connect(request.id, request.url, request.fresh);
      break;
    case "disconnect":
      void engine.disconnect(request.id);
      break;
    case "close":
      engine.close(request.id);
      break;
    case "filters":
      engine.filtersSet(request.filters, request.onlyMatches);
      break;
    case "search":
      engine.searchSet(request.spec);
      break;
    case "call":
      engine.call(request.call).then(
        (value) => send({ req: request.req, type: "result", value }),
        (error) => send({ message: error instanceof Error ? error.message : String(error), req: request.req, type: "failed" })
      );
      break;
    case "hostResult": {
      const pending = waiting.get(request.callId);
      waiting.delete(request.callId);
      if (request.error !== undefined) {
        pending?.reject(new Error(request.error));
      } else if (request.bytes) {
        pending?.resolve(new Uint8Array(request.bytes));
      } else if (request.stat) {
        pending?.resolve(request.stat);
      } else {
        pending?.resolve(request.text);
      }
      break;
    }
  }
};
