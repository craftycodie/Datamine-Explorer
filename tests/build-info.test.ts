import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILD_INFO,
  isNewerBuild,
  isReleaseBranchBuild,
  parseBuildBranch,
  parseBuildSeq,
} from "../src/build-info";

const script = fileURLToPath(new URL("../scripts/compute-build-string.mjs", import.meta.url));

function compute(env: Record<string, string>) {
  const stdout = execFileSync(process.execPath, [script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  return JSON.parse(stdout);
}

describe("build string parsers", () => {
  it("reads seq and branch", () => {
    expect(parseBuildSeq("00030.26.08.20.0200.alpha")).toBe(30);
    expect(parseBuildBranch("00030.26.08.20.0200.alpha")).toBe("alpha");
    expect(parseBuildBranch("00030.26.08.20.0200.feature-x.1")).toBe("feature-x.1");
  });

  it("returns null for untracked and malformed strings", () => {
    expect(parseBuildSeq("untracked version")).toBeNull();
    expect(parseBuildBranch("untracked version")).toBeNull();
    expect(parseBuildSeq("datamine-v0.1.0")).toBeNull();
    expect(parseBuildSeq("00030.26.08.20.alpha")).toBeNull();
  });

  it("spots release builds", () => {
    expect(isReleaseBranchBuild("00031.26.08.21.1200.release")).toBe(true);
    expect(isReleaseBranchBuild("00031.26.08.21.1200.alpha")).toBe(false);
    expect(isReleaseBranchBuild("untracked version")).toBe(false);
  });

  it("compares by seq", () => {
    expect(isNewerBuild("00031.26.08.21.1200.alpha", "00030.26.08.20.0200.alpha")).toBe(true);
    expect(isNewerBuild("00030.26.08.20.0200.alpha", "00030.26.08.20.0200.alpha")).toBe(false);
    expect(isNewerBuild("00029.26.08.20.0200.alpha", "00030.26.08.20.0200.alpha")).toBe(false);
    expect(isNewerBuild("00031.26.08.21.1200.alpha", "untracked version")).toBe(false);
    expect(isNewerBuild("untracked version", "00030.26.08.20.0200.alpha")).toBe(false);
  });

  it("is untracked when vite did not define the build", () => {
    expect(BUILD_INFO.buildString).toBe("untracked version");
    expect(BUILD_INFO.showWatermark).toBe(true);
  });
});

describe("compute-build-string", () => {
  it("builds the string from seq and branch", () => {
    const info = compute({ DATAMINE_EXPLORER_SEQ: "30", DATAMINE_EXPLORER_BRANCH: "alpha" });
    expect(info.buildString).toMatch(/^00030\.\d{2}\.\d{2}\.\d{2}\.\d{4}\.alpha$/);
    expect(info.packageVersion).toBe("0.30.0");
    expect(info.showWatermark).toBe(true);
    expect(info.seq).toBe(30);
    expect(info.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parseBuildSeq(info.buildString)).toBe(30);
  });

  it("takes the CI run number when no seq override is set", () => {
    const info = compute({ GITHUB_RUN_NUMBER: "7", DATAMINE_EXPLORER_BRANCH: "main" });
    expect(info.seq).toBe(7);
    expect(info.buildString.startsWith("00007.")).toBe(true);
  });

  it("sanitises the branch", () => {
    const info = compute({ DATAMINE_EXPLORER_SEQ: "1", DATAMINE_EXPLORER_BRANCH: "feature/my branch!" });
    expect(info.branch).toBe("feature-my_branch_");
    expect(info.buildString.endsWith(".feature-my_branch_")).toBe(true);
  });

  it("hides the watermark only on release", () => {
    const info = compute({ DATAMINE_EXPLORER_SEQ: "2", DATAMINE_EXPLORER_BRANCH: "release" });
    expect(info.showWatermark).toBe(false);
    expect(isReleaseBranchBuild(info.buildString)).toBe(true);
  });

  it("is untracked when forced or on a detached HEAD", () => {
    for (const env of [
      { DATAMINE_EXPLORER_UNTRACKED: "1", DATAMINE_EXPLORER_BRANCH: "alpha" },
      { DATAMINE_EXPLORER_BRANCH: "HEAD", DATAMINE_EXPLORER_SEQ: "5" },
    ]) {
      const info = compute(env);
      expect(info.buildString).toBe("untracked version");
      expect(info.packageVersion).toBe("0.0.1");
      expect(info.showWatermark).toBe(true);
    }
  });
});
