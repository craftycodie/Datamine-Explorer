// The explorer's text in each language it speaks. The words are in locales/<locale>.json under flat
// snake_case keys; `{{name}}` in a string is filled from the params, and a count picks between
// `<key>_one` and `<key>_other`.
import { createContext, createElement, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import rosetta from "rosetta";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

export type ExplorerLocale = "en" | "ja";

export const EXPLORER_LOCALES: ExplorerLocale[] = ["en", "ja"];

// each language by its own name, for the language menu
export const LOCALE_NAMES: Record<ExplorerLocale, string> = { en: "English", ja: "日本語" };

type LocaleCatalog = typeof en;

export type MessageKey = keyof LocaleCatalog;

type Params = Record<string, string | number>;

// Text for the user that is put together where the language is not known (the log worker): the UI
// translates it. A plain string is shown as it is, such as an error from the system.
export interface Message {
  key: MessageKey;
  params?: Params;
}

export type Text = string | Message;

const i18n = rosetta<LocaleCatalog>({ en, ja });
i18n.locale("en");

export function localeNormalize(value: unknown): ExplorerLocale {
  return value === "ja" ? "ja" : "en";
}

export const getLocale = (): ExplorerLocale => i18n.locale() as ExplorerLocale;

export function setLocale(locale: ExplorerLocale) {
  i18n.locale(locale);
  // the page says its language, which picks the right fonts for Japanese
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
}

export const translate = (key: MessageKey, params?: Params): string => i18n.t(key, params);

// The `_one` or `_other` form of a key by `count`, which the params get too.
export function translateCount(key: string, count: number, params?: Params): string {
  return translate(`${key}_${count === 1 ? "one" : "other"}` as MessageKey, { ...params, count: count.toLocaleString() });
}

// What a message from the worker says, in the language shown.
export function textOf(text: Text): string {
  return typeof text === "string" ? text : translate(text.key, text.params);
}

interface LocaleContextValue {
  locale: ExplorerLocale;
  setLocale: (locale: ExplorerLocale) => void;
  t: typeof translate;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

// Everything under it renders again when the language changes.
export function LocaleProvider({ children, locale, onLocale }: { children: ReactNode; locale: ExplorerLocale; onLocale: (locale: ExplorerLocale) => void }) {
  const [shown, setShown] = useState(() => {
    setLocale(locale);
    return locale;
  });
  if (shown !== locale) {
    setLocale(locale);
    setShown(locale);
  }
  const change = useCallback(
    (next: ExplorerLocale) => {
      setLocale(next);
      setShown(next);
      onLocale(next);
    },
    [onLocale]
  );
  // a new `t` each time, so components that memoize on it pick up the new language
  const value = useMemo<LocaleContextValue>(() => ({ locale: shown, setLocale: change, t: (key, params) => translate(key, params) }), [change, shown]);
  return createElement(LocaleContext.Provider, { value }, children);
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  return context ?? { locale: getLocale(), setLocale, t: translate };
}

// In components, so they render again when the language changes.
export function useT(): typeof translate {
  return useLocale().t;
}
