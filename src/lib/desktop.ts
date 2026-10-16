// True only in the desktop app's build. vite.config.ts replaces the name with a literal, so code behind
// `if (DESKTOP_BUILD)` is dropped from the web build entirely rather than just hidden.
declare const __DATAMINE_EXPLORER_DESKTOP__: boolean;

export const DESKTOP_BUILD: boolean = __DATAMINE_EXPLORER_DESKTOP__;
