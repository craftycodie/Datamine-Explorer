// Build identity, Bungie style: {seq}.{yy}.{mm}.{dd}.{hhmm}.{branch}, or "untracked version".
// vite.config.ts injects the value (from scripts/compute-build-string.mjs) as __DATAMINE_EXPLORER_BUILD__.

export type BuildInfo = {
  buildString: string;
  seq: number;
  branch: string;
  commit: string;
  builtAt: string;
  showWatermark: boolean;
  // 0.{seq}.0, or 0.0.1 when untracked
  packageVersion: string;
};

declare const __DATAMINE_EXPLORER_BUILD__: BuildInfo | undefined;

export const UNTRACKED_BUILD_STRING = "untracked version";

// stands in when vite did not define the build (vitest, other tools)
const untracked: BuildInfo = {
  buildString: UNTRACKED_BUILD_STRING,
  seq: 0,
  branch: "unknown",
  commit: "",
  builtAt: "",
  showWatermark: true,
  packageVersion: "0.0.1",
};

export const BUILD_INFO: BuildInfo =
  typeof __DATAMINE_EXPLORER_BUILD__ === "undefined" ? untracked : __DATAMINE_EXPLORER_BUILD__;

export const BUILD_TAG_RE = /^(\d+)\.(\d{2})\.(\d{2})\.(\d{2})\.(\d{4})\.(.+)$/;

function parseBuildTag(buildString: string): { seq: number; branch: string } | null {
  if (buildString === UNTRACKED_BUILD_STRING) {
    return null;
  }
  const match = BUILD_TAG_RE.exec(buildString.trim());
  if (!match) {
    return null;
  }
  const seq = Number.parseInt(match[1], 10);
  return Number.isFinite(seq) ? { seq, branch: match[6] } : null;
}

export function parseBuildSeq(buildString: string): number | null {
  return parseBuildTag(buildString)?.seq ?? null;
}

// the branch suffix of a build string (alpha, release, ...)
export function parseBuildBranch(buildString: string): string | null {
  return parseBuildTag(buildString)?.branch ?? null;
}

// true only for builds whose string ends in .release
export function isReleaseBranchBuild(buildString: string): boolean {
  return parseBuildBranch(buildString) === "release";
}

export function isNewerBuild(candidateTag: string, currentBuildString: string): boolean {
  const candidate = parseBuildSeq(candidateTag);
  const current = parseBuildSeq(currentBuildString);
  if (candidate === null || current === null) {
    return false;
  }
  return candidate > current;
}
