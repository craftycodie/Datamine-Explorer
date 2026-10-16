// The datamine reader uses Node's Buffer; this has to run before it is imported.
import { Buffer } from "buffer";

(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;
