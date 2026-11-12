import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AppVersion } from "../shared/contracts.js";

const COMMIT = /^[0-9a-f]{7,40}(-dirty)?$/;

type PackageInfo = { version: string; repository?: string };

let packageInfo: PackageInfo | undefined;
let checkoutCommit: string | null | undefined;

/** The app's package.json. The server runs from the repository root, locally and in the image. */
function readPackage(): PackageInfo {
  if (packageInfo) return packageInfo;
  try {
    const json = JSON.parse(readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as {
      version?: unknown;
      repository?: string | { url?: unknown };
    };
    const repository = typeof json.repository === "string" ? json.repository : json.repository?.url;
    packageInfo = {
      version: typeof json.version === "string" ? json.version : "0.0.0",
      ...(typeof repository === "string" ? { repository } : {}),
    };
  } catch {
    packageInfo = { version: "0.0.0" };
  }
  return packageInfo;
}

/** The commit of a local checkout. The Cloud Run image has no git: the deploy script sets APP_COMMIT. */
function readCheckoutCommit(): string | undefined {
  if (checkoutCommit === undefined) {
    try {
      const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3_000,
      }).trim();
      checkoutCommit = COMMIT.test(commit) ? commit : null;
    } catch {
      checkoutCommit = null;
    }
  }
  return checkoutCommit ?? undefined;
}

/** The commit's page on GitHub, from a repository URL such as git+https://github.com/owner/repo.git. */
export function githubCommitUrl(repository: string | undefined, commit: string): string | undefined {
  const match = repository?.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return match ? `https://github.com/${match[1]}/${match[2]}/commit/${commit.replace(/-dirty$/, "")}` : undefined;
}

/** What the footer shows: the package version, plus the commit and the deploy time when known. */
export function resolveAppVersion(env: NodeJS.ProcessEnv = process.env): AppVersion {
  const { version, repository } = readPackage();
  const fromEnv = env.APP_COMMIT?.trim();
  const commit = fromEnv && COMMIT.test(fromEnv) ? fromEnv : readCheckoutCommit();
  const commitUrl = commit ? githubCommitUrl(repository, commit) : undefined;
  const deployed = env.APP_DEPLOYED_AT?.trim();
  const deployedAt = deployed && !Number.isNaN(Date.parse(deployed)) ? new Date(deployed).toISOString() : undefined;
  return {
    version,
    ...(commit ? { commit } : {}),
    ...(commitUrl ? { commitUrl } : {}),
    ...(deployedAt ? { deployedAt } : {}),
  };
}
