import fs from "node:fs";
import { parse } from "dotenv";

// Connection settings for the Special Group app. They are separate from the DeskFlow /jira space
// so this app can use its own read-only token.
//
// Lookup order (first wins): .env.special-group.local (written by the Connect form) → .env → process env.

export const LOCAL_ENV_FILE = ".env.special-group.local";
const DEFAULT_SITE = "https://renanbazinin2.atlassian.net";
const SITE_PATTERN = /^https:\/\/[a-z0-9-]+\.atlassian\.net$/i;
const GATEWAY_PATTERN = /^https:\/\/api\.atlassian\.com\/ex\/jira\/[a-z0-9-]+$/i;
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export type SpecialGroupConfig = {
  /** Where people open tickets, for example https://name.atlassian.net. */
  siteUrl: string;
  /** Where the server calls the REST API: the site itself, or the scoped-token gateway. */
  baseUrl: string;
  email: string;
  token: string;
  defaultProjectKey: string | null;
};

function readEnvFile(file: string): Record<string, string> {
  return fs.existsSync(file) ? parse(fs.readFileSync(file)) : {};
}

export function isSiteUrl(value: string): boolean {
  return SITE_PATTERN.test(value);
}

export function specialGroupConfig(): SpecialGroupConfig {
  const files = { ...readEnvFile(".env"), ...readEnvFile(LOCAL_ENV_FILE) };
  const value = (key: string, fallback = "") => files[key] || process.env[key] || fallback;
  const siteUrl = value("SPECIAL_GROUP_JIRA_SITE_URL", value("JIRA_SITE_URL", DEFAULT_SITE)).replace(/\/$/, "");
  const baseUrl = value("SPECIAL_GROUP_JIRA_API_BASE_URL", siteUrl).replace(/\/$/, "");
  const defaultProjectKey = value("SPECIAL_GROUP_JIRA_PROJECT_KEY").toUpperCase() || null;
  if (!isSiteUrl(siteUrl) || !(baseUrl === siteUrl || GATEWAY_PATTERN.test(baseUrl))
    || (defaultProjectKey && !PROJECT_KEY_PATTERN.test(defaultProjectKey))) {
    throw new Error("Invalid Special Group Jira settings. Check the SPECIAL_GROUP_JIRA_* values.");
  }
  return {
    siteUrl,
    baseUrl,
    email: value("SPECIAL_GROUP_JIRA_EMAIL"),
    token: value("SPECIAL_GROUP_JIRA_API_TOKEN"),
    defaultProjectKey,
  };
}

/** Saves credentials from the Connect form. The file is Git-ignored by the `.env.*` rule. */
export function saveLocalConnection(values: { siteUrl: string; baseUrl: string; email: string; token: string }) {
  for (const entry of Object.values(values)) {
    if (/[\r\n"#]/.test(entry)) throw new Error("Connection values cannot contain line breaks, quotes, or #.");
  }
  fs.writeFileSync(LOCAL_ENV_FILE, [
    `SPECIAL_GROUP_JIRA_SITE_URL=${values.siteUrl}`,
    `SPECIAL_GROUP_JIRA_API_BASE_URL=${values.baseUrl}`,
    `SPECIAL_GROUP_JIRA_EMAIL=${values.email}`,
    `SPECIAL_GROUP_JIRA_API_TOKEN=${values.token}`,
    "",
  ].join("\n"), { mode: 0o600 });
}
