import { translate } from "../localization";
import { backend } from "./backend";

// Puts text on the clipboard. The desktop app has a plugin for it; a browser needs a secure page and
// a recent click or key press, and falls back to the old copy command where that is refused.
export async function clipboardWrite(text: string): Promise<void> {
  if (backend.kind === "tauri") {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // fall through to the copy command
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;user-select:text";
  const from = document.activeElement as HTMLElement | null;
  document.body.append(area);
  area.select();
  const done = document.execCommand("copy");
  area.remove();
  from?.focus?.();
  if (!done) {
    throw new Error(translate("clipboard_refused"));
  }
}
