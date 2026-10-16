import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UpdateDialog } from "../src/components/UpdateDialog";
import {
  checkForUpdate,
  fetchReleases,
  manualCheckMessage,
  releaseFromResponse,
  selectUpdateRelease,
  type ReleaseInfo,
} from "../src/lib/update-check";

const release = (tagName: string, prerelease = false): ReleaseInfo => ({
  body: "",
  htmlUrl: `https://github.com/craftycodie/Datamine-Explorer/releases/tag/${tagName}`,
  name: tagName,
  prerelease,
  publishedAt: "2026-08-17T18:10:00Z",
  tagName,
});

const olderStable = release("00020.26.08.10.1200.release");
const currentAlpha = "00023.26.08.16.1810.alpha";
const newerPrerelease = release("00024.26.08.17.1810.alpha", true);
const newerStable = release("00025.26.08.18.0900.release");

describe("selectUpdateRelease", () => {
  it("offers a newer pre-release to a non-release build", () => {
    expect(selectUpdateRelease([olderStable, newerPrerelease], currentAlpha)).toEqual(newerPrerelease);
  });

  it("ignores pre-releases for a release-branch build", () => {
    expect(selectUpdateRelease([newerPrerelease], "00023.26.08.16.1810.release")).toBeNull();
    expect(selectUpdateRelease([newerPrerelease, newerStable], "00023.26.08.16.1810.release")).toEqual(newerStable);
  });

  it("takes the highest seq, not the list order", () => {
    expect(selectUpdateRelease([newerPrerelease, newerStable, olderStable], currentAlpha)).toEqual(newerStable);
    expect(selectUpdateRelease([olderStable, newerStable, newerPrerelease], currentAlpha)).toEqual(newerStable);
  });

  it("returns nothing when the build is already the newest or the same", () => {
    expect(selectUpdateRelease([olderStable, newerPrerelease], newerPrerelease.tagName)).toBeNull();
    expect(selectUpdateRelease([], currentAlpha)).toBeNull();
  });

  it("compares seq as a number", () => {
    expect(selectUpdateRelease([release("100.26.08.18.0900.alpha")], "99.26.08.16.1810.alpha")?.tagName).toBe("100.26.08.18.0900.alpha");
  });
});

describe("releaseFromResponse", () => {
  const base = { html_url: "https://example.test/r", tag_name: "00024.26.08.17.1810.alpha" };

  it("maps a release", () => {
    expect(releaseFromResponse({ ...base, body: " notes \n", name: " Name ", prerelease: true, published_at: "2026-08-17T18:10:00Z" })).toEqual({
      body: "notes",
      htmlUrl: "https://example.test/r",
      name: "Name",
      prerelease: true,
      publishedAt: "2026-08-17T18:10:00Z",
      tagName: "00024.26.08.17.1810.alpha",
    });
  });

  it("falls back to the tag for a missing name", () => {
    expect(releaseFromResponse({ ...base, name: null })?.name).toBe(base.tag_name);
  });

  it("drops drafts, malformed tags and missing fields", () => {
    expect(releaseFromResponse({ ...base, draft: true })).toBeNull();
    expect(releaseFromResponse({ ...base, tag_name: "v1.2.3" })).toBeNull();
    expect(releaseFromResponse({ ...base, tag_name: "untracked version" })).toBeNull();
    expect(releaseFromResponse({ ...base, tag_name: "00024.26.08.17.alpha" })).toBeNull();
    expect(releaseFromResponse({ tag_name: base.tag_name })).toBeNull();
    expect(releaseFromResponse({ html_url: base.html_url })).toBeNull();
  });
});

describe("fetchReleases", () => {
  const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

  it("keeps only valid releases", async () => {
    const list = await fetchReleases(
      answer([
        { html_url: "https://example.test/a", tag_name: "00024.26.08.17.1810.alpha" },
        { html_url: "https://example.test/b", tag_name: "nightly" },
        { draft: true, html_url: "https://example.test/c", tag_name: "00025.26.08.18.0900.alpha" },
      ])
    );
    expect(list.map((r) => r.tagName)).toEqual(["00024.26.08.17.1810.alpha"]);
  });

  it("throws on an error status and on a non-list answer", async () => {
    await expect(fetchReleases(answer({ message: "rate limit" }, 403))).rejects.toThrow("403");
    await expect(fetchReleases(answer({}))).rejects.toThrow();
  });
});

describe("checkForUpdate", () => {
  const list = async () => [olderStable, newerPrerelease];

  it("reports an available update", async () => {
    expect(await checkForUpdate({ currentBuild: currentAlpha, fetchList: list, manual: false, skipped: null })).toEqual({ kind: "available", release: newerPrerelease });
  });

  it("stays quiet about a skipped tag on the automatic check only", async () => {
    const skipped = newerPrerelease.tagName;
    expect(await checkForUpdate({ currentBuild: currentAlpha, fetchList: list, manual: false, skipped })).toEqual({ kind: "current" });
    expect(await checkForUpdate({ currentBuild: currentAlpha, fetchList: list, manual: true, skipped })).toEqual({ kind: "available", release: newerPrerelease });
  });

  it("offers a newer release again after a skip", async () => {
    const fetchList = async () => [newerPrerelease, newerStable];
    const outcome = await checkForUpdate({ currentBuild: currentAlpha, fetchList, manual: false, skipped: newerPrerelease.tagName });
    expect(outcome).toEqual({ kind: "available", release: newerStable });
  });

  it("does not fetch for an untracked build", async () => {
    let fetched = false;
    const fetchList = async () => {
      fetched = true;
      return [newerStable];
    };
    expect(await checkForUpdate({ currentBuild: "untracked version", fetchList, manual: true, skipped: null })).toEqual({ kind: "untracked" });
    expect(fetched).toBe(false);
  });

  it("turns a failed fetch into an error outcome", async () => {
    const fetchList = async (): Promise<ReleaseInfo[]> => {
      throw new Error("offline");
    };
    expect(await checkForUpdate({ currentBuild: currentAlpha, fetchList, manual: false, skipped: null })).toEqual({ kind: "error", message: "offline" });
  });

  it("says current when nothing is newer", async () => {
    expect(await checkForUpdate({ currentBuild: newerStable.tagName, fetchList: list, manual: true, skipped: null })).toEqual({ kind: "current" });
  });
});

describe("manualCheckMessage", () => {
  it("words each outcome", () => {
    expect(manualCheckMessage({ kind: "current" })).toBe("You're up to date");
    expect(manualCheckMessage({ kind: "error", message: "offline" })).toContain("offline");
    expect(manualCheckMessage({ kind: "available", release: newerStable })).toContain(newerStable.tagName);
    expect(manualCheckMessage({ kind: "untracked" })).toContain("untracked");
  });
});

describe("UpdateDialog", () => {
  const render = (r: ReleaseInfo) =>
    renderToStaticMarkup(createElement(UpdateDialog, { currentBuild: currentAlpha, onDownload() {}, onLater() {}, onSkip() {}, release: r }));

  it("shows both builds, the buttons and the notes", () => {
    const html = render({ ...newerStable, body: "- fixed a thing", name: "Big release" });
    for (const text of [currentAlpha, newerStable.tagName, "Big release", "- fixed a thing", "Download", "Skip this version", "Later", "Update available"]) {
      expect(html).toContain(text);
    }
  });

  it("never injects release notes as HTML", () => {
    const html = render({ ...newerStable, body: "<script>alert(1)</script><img src=x onerror=alert(1)>" });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("copes with empty notes", () => {
    expect(render(newerStable)).toContain("No release notes.");
  });
});
