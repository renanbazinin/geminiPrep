// Deploys Gemini Prep to Cloud Run from source (Cloud Build builds the Dockerfile).
//
//   npm run deploy:gcp
//
// Settings come from .env, .env.jira.local and .env.special-group.local (same precedence as the
// app). Keys, tokens and APP_PASSWORD go to Secret Manager; everything else becomes a plain
// Cloud Run environment variable. Override with environment variables:
//   GCP_PROJECT   project to deploy to (default: GCP_PROJECT from .env)
//   REGION        Cloud Run region (default: us-central1)
//   SERVICE       Cloud Run service name (default: gemini-prep)
//   ENV_DIR       folder holding the .env files (default: current folder)
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envDir = path.resolve(process.env.ENV_DIR ?? process.cwd());

function readEnv(file: string): Record<string, string> {
  const full = path.join(envDir, file);
  return fs.existsSync(full) ? parse(fs.readFileSync(full)) : {};
}

const values: Record<string, string> = {
  ...readEnv(".env"),
  ...readEnv(".env.jira.local"),
  ...readEnv(".env.special-group.local"),
};

const project = process.env.GCP_PROJECT || values.GCP_PROJECT || values.GOOGLE_CLOUD_PROJECT;
const region = process.env.REGION || "us-central1";
const service = process.env.SERVICE || "gemini-prep";
const serviceAccount = `${service}-run@${project}.iam.gserviceaccount.com`;

const SECRET_KEYS = ["APP_PASSWORD", "GEMINI_API_KEY", "JIRA_API_TOKEN", "SPECIAL_GROUP_JIRA_API_TOKEN"];
// PORT is reserved by Cloud Run; a local credentials path means nothing in the container.
const SKIPPED_KEYS = new Set(["PORT", "GOOGLE_APPLICATION_CREDENTIALS", "LARGE_FILES_DIR"]);
// Cloud Run caps HTTP/1 request bodies at 32 MiB, so larger uploads could never arrive.
const CLOUD_RUN_MAX_UPLOAD_MB = 30;

if (!project) fail("No project: set GCP_PROJECT in .env or the environment.");
if (!values.APP_PASSWORD?.trim()) fail(`APP_PASSWORD is missing from ${path.join(envDir, ".env")}.`);

function quote(arg: string): string {
  return /[\s"'&|<>^%$();]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function gcloud(args: string[], options: SpawnSyncOptions & { allowFailure?: boolean } = {}) {
  const { allowFailure, ...spawnOptions } = options;
  // gcloud is a .cmd on Windows, which Node only starts through a shell.
  const result = spawnSync("gcloud", [...args, `--project=${project}`].map(quote), {
    cwd: repoRoot,
    shell: true,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...spawnOptions,
  });
  if (result.status !== 0 && !allowFailure) {
    fail(`gcloud ${args.slice(0, 3).join(" ")} failed:\n${String(result.stderr ?? "").trim()}`);
  }
  return { ok: result.status === 0, stdout: String(result.stdout ?? "").trim() };
}

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function step(message: string) {
  console.log(`\n→ ${message}`);
}

step(`Enabling APIs in ${project}`);
gcloud(["services", "enable", "run.googleapis.com", "cloudbuild.googleapis.com",
  "artifactregistry.googleapis.com", "secretmanager.googleapis.com", "aiplatform.googleapis.com"]);

step(`Service account ${serviceAccount}`);
if (!gcloud(["iam", "service-accounts", "describe", serviceAccount], { allowFailure: true }).ok) {
  gcloud(["iam", "service-accounts", "create", `${service}-run`, "--display-name=Gemini Prep (Cloud Run)"]);
}
// Vertex AI calls use this account's credentials (Application Default Credentials on Cloud Run).
gcloud(["projects", "add-iam-policy-binding", project, `--member=serviceAccount:${serviceAccount}`,
  "--role=roles/aiplatform.user", "--condition=None", "--quiet"]);

const secretRefs: string[] = [];
for (const key of SECRET_KEYS) {
  const value = values[key]?.trim();
  if (!value) continue;
  const name = `${service}-${key.toLowerCase().replace(/_/g, "-")}`;
  step(`Secret ${name}`);
  if (!gcloud(["secrets", "describe", name], { allowFailure: true }).ok) {
    gcloud(["secrets", "create", name, "--replication-policy=automatic"]);
  }
  const current = gcloud(["secrets", "versions", "access", "latest", `--secret=${name}`], { allowFailure: true });
  if (!current.ok || current.stdout !== value) {
    gcloud(["secrets", "versions", "add", name, "--data-file=-"], { input: value });
    console.log("  stored a new version");
  }
  gcloud(["secrets", "add-iam-policy-binding", name, `--member=serviceAccount:${serviceAccount}`,
    "--role=roles/secretmanager.secretAccessor", "--condition=None", "--quiet"]);
  secretRefs.push(`${key}=${name}:latest`);
}

const plain: Record<string, string> = {};
for (const [key, value] of Object.entries(values)) {
  if (SECRET_KEYS.includes(key) || SKIPPED_KEYS.has(key) || !value.trim()) continue;
  plain[key] = value;
}
// The container's disk is memory-backed and lost on restart; uploads live in /tmp.
plain.LARGE_FILES_DIR = "/tmp/large-files";
const requestedUploadMb = Number(plain.LARGE_FILES_MAX_UPLOAD_MB) || 100;
plain.LARGE_FILES_MAX_UPLOAD_MB = String(Math.min(requestedUploadMb, CLOUD_RUN_MAX_UPLOAD_MB));

const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gemini-prep-")), "env.yaml");
fs.writeFileSync(envFile, Object.entries(plain).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n") + "\n");

step(`Deploying ${service} to Cloud Run (${region}) — the build takes a few minutes`);
try {
  gcloud([
    "run", "deploy", service,
    "--source=.",
    `--region=${region}`,
    `--service-account=${serviceAccount}`,
    "--allow-unauthenticated", // anyone can reach /login; the app password protects everything else
    `--env-vars-file=${envFile}`,
    `--set-secrets=${secretRefs.join(",")}`,
    "--port=8080",
    "--memory=2Gi",
    "--cpu=1",
    "--timeout=3600",
    "--min-instances=0",
    // One instance: uploaded files and caches live in that instance's memory.
    "--max-instances=1",
    "--quiet",
  ], { stdio: "inherit" });
} finally {
  fs.rmSync(path.dirname(envFile), { recursive: true, force: true });
}

const url = gcloud(["run", "services", "describe", service, `--region=${region}`, "--format=value(status.url)"]).stdout;
console.log(`\n✓ Deployed: ${url}\n  Sign in with APP_PASSWORD from ${path.join(envDir, ".env")}.`);
