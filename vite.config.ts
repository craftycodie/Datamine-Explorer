import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const devServicePath = fileURLToPath(new URL("./scripts/dev-service.mjs", import.meta.url));

// The service is imported again whenever it changes on disk, so edits to it apply
// without restarting the dev server. Its open root is lost then; the next list call sets it.
async function devServiceLoad(): Promise<typeof import("./scripts/dev-service.mjs")> {
  const version = statSync(devServicePath).mtimeMs;
  return import(`${pathToFileURL(devServicePath).href}?v=${version}`);
}

// In a browser the file reads are the dev server's /api; Tauri answers them itself.
const devService: Plugin = {
  name: "datamine-explorer-dev-service",
  configureServer(server) {
    server.middlewares.use("/api", (req, res, next) => {
      devServiceLoad()
        .then((service) => service.handleApi(req, res))
        .catch(next);
    });
  },
};

// CI passes the build as JSON in DATAMINE_EXPLORER_BUILD_INFO; anywhere else it is an untracked build.
function buildInfo(): unknown {
  const fromEnv = process.env.DATAMINE_EXPLORER_BUILD_INFO;
  if (fromEnv) {
    return JSON.parse(fromEnv);
  }
  const script = fileURLToPath(new URL("./scripts/compute-build-string.mjs", import.meta.url));
  const stdout = execFileSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, DATAMINE_EXPLORER_UNTRACKED: "1" },
  });
  return JSON.parse(stdout);
}

// The datamine package's exports do not include its package.json, so the version is read from disk here.
function datamineVersion(): string {
  const file = fileURLToPath(new URL("./node_modules/@blamnetwork/datamine/package.json", import.meta.url));
  return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
}

// Tauri expects a fixed dev port and serves dist/ when built.
export default defineConfig({
  plugins: [react(), devService],
  clearScreen: false,
  server: { port: 1421, strictPort: true },
  define: {
    __DATAMINE_EXPLORER_BUILD__: JSON.stringify(buildInfo()),
    __DATAMINE_PACKAGE_VERSION__: JSON.stringify(datamineVersion()),
  },
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});
