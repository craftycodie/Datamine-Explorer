// For vite.config.ts, which mounts the handler in the dev server.
import type { IncomingMessage, ServerResponse } from "node:http";

export function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void>;
