import "./styles.css";
import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { storedGet, storedSet } from "./lib/stored";
import { type ExplorerLocale, LocaleProvider, localeNormalize } from "./localization";

// "dmv." like the other saved settings (see App.tsx)
const LOCALE_KEY = "dmv.locale";

// The app in the language last picked.
function Root() {
  const [locale, setLocale] = useState(() => localeNormalize(storedGet(LOCALE_KEY)));
  const onLocale = useCallback((next: ExplorerLocale) => {
    storedSet(LOCALE_KEY, next);
    setLocale(next);
  }, []);
  return (
    <LocaleProvider locale={locale} onLocale={onLocale}>
      <App />
    </LocaleProvider>
  );
}

// No webview menu (Back/Refresh/Inspect); text in inputs and the log stays selectable.
window.addEventListener("contextmenu", (e) => e.preventDefault(), { capture: true });

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Root />
    </StrictMode>
  );
}
