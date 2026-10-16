import { backend } from "./backend";

// Opens a link in the system's browser: through the opener plugin in the desktop app, in a new tab in a browser.
export async function openExternal(url: string): Promise<void> {
  if (backend.kind === "tauri") {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
