#!/usr/bin/env node
// Computes the Datamine Explorer build string: {seq}.{yy}.{mm}.{dd}.{hhmm}.{branch}
// Example: 00042.26.08.15.0534.alpha
//
// Seq comes from DATAMINE_EXPLORER_SEQ / GITHUB_RUN_NUMBER (the CI run number) when set,
// otherwise it is the highest matching git tag + 1 (local convenience).
//
// Prints JSON: { buildString, packageVersion, showWatermark, seq, branch, stamp, commit, builtAt }
//
// Env:
//   DATAMINE_EXPLORER_BRANCH: branch name override (default: git rev-parse --abbrev-ref HEAD)
//   DATAMINE_EXPLORER_SEQ / GITHUB_RUN_NUMBER: build sequence
//   DATAMINE_EXPLORER_UNTRACKED=1: force the "untracked version" build
import { execSync } from "node:child_process";

// the local seq scan only looks at tags in this shape
const BUILD_TAG_RE = /^(\d{5})\.\d{2}\.\d{2}\.\d{2}\.\d{4}\..+$/;

const pad2 = (n) => String(n).padStart(2, "0");

const sanitizeBranch = (branch) =>
  branch
    .trim()
    .replace(/\//g, "-")
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "_");

const git = (args) => {
  try {
    return execSync(`git ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

const now = new Date();
const builtAt = now.toISOString();
const commit = (process.env.GITHUB_SHA || git("rev-parse HEAD")).slice(0, 7);

const forceUntracked = process.env.DATAMINE_EXPLORER_UNTRACKED === "1";
const branchRaw = process.env.DATAMINE_EXPLORER_BRANCH || git("rev-parse --abbrev-ref HEAD") || "unknown";

if (forceUntracked || branchRaw === "HEAD") {
  const result = {
    buildString: "untracked version",
    packageVersion: "0.0.1",
    showWatermark: true,
    seq: 0,
    branch: branchRaw,
    stamp: "00.00.00.0000",
    commit,
    builtAt,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

const branch = sanitizeBranch(branchRaw);

const seqFromEnv = Number.parseInt(process.env.DATAMINE_EXPLORER_SEQ || process.env.GITHUB_RUN_NUMBER || "", 10);

let seq;
if (Number.isFinite(seqFromEnv) && seqFromEnv > 0) {
  seq = seqFromEnv;
} else {
  let maxSeq = 0;
  for (const tag of git("tag --list").split(/\r?\n/)) {
    const match = BUILD_TAG_RE.exec(tag.trim());
    if (match) {
      maxSeq = Math.max(maxSeq, Number.parseInt(match[1], 10));
    }
  }
  seq = maxSeq + 1;
}

const stamp = `${pad2(now.getUTCFullYear() % 100)}.${pad2(now.getUTCMonth() + 1)}.${pad2(now.getUTCDate())}.${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}`;
const result = {
  buildString: `${String(seq).padStart(5, "0")}.${stamp}.${branch}`,
  packageVersion: `0.${seq}.0`,
  showWatermark: branchRaw !== "release",
  seq,
  branch,
  stamp,
  commit,
  builtAt,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
