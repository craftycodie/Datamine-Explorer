// Looks for a newer build among the repository's GitHub releases. Ported from MegaCrow's update check.
import { BUILD_TAG_RE, isNewerBuild, isReleaseBranchBuild, parseBuildSeq } from "../build-info";
import { storedGet, storedSet } from "./stored";

const RELEASES_URL = "https://api.github.com/repos/craftycodie/Datamine-Explorer/releases?per_page=100";
// "dmv." is from the app's old name, Datamine Viewer, like the other saved settings.
export const SKIPPED_UPDATE_KEY = "dmv.skippedUpdate";

export type ReleaseInfo = {
  tagName: string;
  htmlUrl: string;
  name: string;
  // the release notes, markdown source shown as plain text
  body: string;
  publishedAt: string;
  prerelease: boolean;
};

type ReleaseResponse = {
  tag_name?: string;
  html_url?: string;
  name?: string | null;
  body?: string | null;
  published_at?: string | null;
  created_at?: string | null;
  prerelease?: boolean;
  draft?: boolean;
};

// Drafts and tags that are not build strings are not updates.
export function releaseFromResponse(data: ReleaseResponse): ReleaseInfo | null {
  if (!data.tag_name || !data.html_url || data.draft || !BUILD_TAG_RE.test(data.tag_name)) {
    return null;
  }
  return {
    body: data.body?.trim() ?? "",
    htmlUrl: data.html_url,
    name: data.name?.trim() || data.tag_name,
    prerelease: Boolean(data.prerelease),
    publishedAt: data.published_at ?? data.created_at ?? "",
    tagName: data.tag_name,
  };
}

// Throws when GitHub cannot be reached or answers with an error (rate limits included); the caller decides
// whether anyone hears about it. Only the Accept header is sent, so the request needs no CORS preflight.
export async function fetchReleases(fetchImpl: typeof fetch = fetch): Promise<ReleaseInfo[]> {
  const response = await fetchImpl(RELEASES_URL, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status}`);
  }
  const data: unknown = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("GitHub gave an unexpected answer");
  }
  return data.flatMap((item) => releaseFromResponse(item as ReleaseResponse) ?? []);
}

// The newest release above the current build. Pre-releases count unless the current build is a release-branch one.
export function selectUpdateRelease(releases: readonly ReleaseInfo[], currentBuild: string): ReleaseInfo | null {
  const fullOnly = isReleaseBranchBuild(currentBuild);
  let best: ReleaseInfo | null = null;
  for (const release of releases) {
    if ((release.prerelease && fullOnly) || !isNewerBuild(release.tagName, currentBuild)) {
      continue;
    }
    if (!best || isNewerBuild(release.tagName, best.tagName)) {
      best = release;
    }
  }
  return best;
}

export type UpdateOutcome =
  | { kind: "available"; release: ReleaseInfo }
  | { kind: "current" }
  | { kind: "untracked" }
  | { kind: "error"; message: string };

export type UpdateCheckOptions = {
  currentBuild: string;
  // the tag the user chose to skip; only the automatic check honours it
  skipped: string | null;
  manual: boolean;
  // swapped out by tests
  fetchList?: () => Promise<ReleaseInfo[]>;
};

export async function checkForUpdate({ currentBuild, skipped, manual, fetchList = fetchReleases }: UpdateCheckOptions): Promise<UpdateOutcome> {
  if (parseBuildSeq(currentBuild) === null) {
    return { kind: "untracked" };
  }
  let releases: ReleaseInfo[];
  try {
    releases = await fetchList();
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  const release = selectUpdateRelease(releases, currentBuild);
  if (!release || (!manual && skipped === release.tagName)) {
    return { kind: "current" };
  }
  return { kind: "available", release };
}

export function skippedUpdateGet(): string | null {
  return storedGet(SKIPPED_UPDATE_KEY);
}

export function skippedUpdateSet(tag: string) {
  storedSet(SKIPPED_UPDATE_KEY, tag);
}


// What the About dialog says after a manual check; the update itself opens its own dialog.
export function manualCheckMessage(outcome: UpdateOutcome): string {
  switch (outcome.kind) {
    case "available":
      return `${outcome.release.tagName} is available`;
    case "current":
      return "You're up to date";
    case "untracked":
      return "This is an untracked build, so there is nothing to compare";
    case "error":
      return `Could not check for updates: ${outcome.message}`;
  }
}
