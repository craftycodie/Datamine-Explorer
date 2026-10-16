// vite.config.ts reads the version of the datamine package at build time: the package's exports do not
// let its package.json be imported.
declare const __DATAMINE_PACKAGE_VERSION__: string | undefined;

export const DATAMINE_VERSION = typeof __DATAMINE_PACKAGE_VERSION__ === "undefined" ? "unknown" : __DATAMINE_PACKAGE_VERSION__;

export const REPOSITORY_URL = "https://github.com/craftycodie/Datamine-Explorer";
export const ISSUES_URL = `${REPOSITORY_URL}/issues/new`;
