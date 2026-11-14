import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { AppVersion, LibraryVersion } from "../shared/contracts.js";
import { resolveLargeFilesEngine } from "./documents/config.js";

const COMMIT = /^[0-9a-f]{7,40}(-dirty)?$/;
const nodeRequire = createRequire(import.meta.url);

type PackageInfo = { version: string; repository?: string };

let packageInfo: PackageInfo | undefined;
let checkoutCommit: string | null | undefined;
const installedVersions = new Map<string, string | null>();

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

/**
 * The version of an installed npm package, from its own package.json: the one that runs, which a
 * range in this app's package.json would not say. It looks in the directories Node searches from
 * this file, so it finds the package wherever the server's imports find it.
 */
function readInstalledVersion(name: string): string | undefined {
  let version = installedVersions.get(name);
  if (version === undefined) {
    version = null;
    for (const directory of nodeRequire.resolve.paths(name) ?? []) {
      try {
        const json = JSON.parse(readFileSync(path.join(directory, name, "package.json"), "utf8")) as { version?: unknown };
        if (typeof json.version === "string") {
          version = json.version;
          break;
        }
      } catch {
        // Not installed in this directory: try the next one.
      }
    }
    installedVersions.set(name, version);
  }
  return version ?? undefined;
}

/**
 * The npm packages the footer names. llm-large-files is one only on the npm engine: the original
 * engine runs the copy in packages/large-files, and the installed package then serves nothing.
 */
function resolveLibraries(env: NodeJS.ProcessEnv): LibraryVersion[] {
  const names = resolveLargeFilesEngine(env) === "npm" ? ["llm-large-files"] : [];
  return names.flatMap((name) => {
    const version = readInstalledVersion(name);
    return version ? [{ name, version }] : [];
  });
}

/** The commit's page on GitHub, from a repository URL such as git+https://github.com/owner/repo.git. */
export function githubCommitUrl(repository: string | undefined, commit: string): string | undefined {
  const match = repository?.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return match ? `https://github.com/${match[1]}/${match[2]}/commit/${commit.replace(/-dirty$/, "")}` : undefined;
}

/**
 * What the footer shows: the package version, plus the commit and the deploy time when known, and
 * the versions of the npm packages it names.
 */
export function resolveAppVersion(env: NodeJS.ProcessEnv = process.env): AppVersion {
  const { version, repository } = readPackage();
  const fromEnv = env.APP_COMMIT?.trim();
  const commit = fromEnv && COMMIT.test(fromEnv) ? fromEnv : readCheckoutCommit();
  const commitUrl = commit ? githubCommitUrl(repository, commit) : undefined;
  const deployed = env.APP_DEPLOYED_AT?.trim();
  const deployedAt = deployed && !Number.isNaN(Date.parse(deployed)) ? new Date(deployed).toISOString() : undefined;
  const libraries = resolveLibraries(env);
  return {
    version,
    ...(commit ? { commit } : {}),
    ...(commitUrl ? { commitUrl } : {}),
    ...(deployedAt ? { deployedAt } : {}),
    ...(libraries.length ? { libraries } : {}),
  };
}
