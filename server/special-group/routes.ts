import { Router, type Response } from "express";
import type { SpecialGroupConnection } from "../../shared/special-group/types.js";
import { sanitizeDraft } from "../../shared/special-group/draft.js";
import { resolveGeminiChatModels, resolveProbeRegions, resolveVertexChatModels, resolveVertexProject } from "../catalog.js";
import { validateChatRequest } from "../chat/validation.js";
import { getVertexAccessToken } from "../vertex-auth.js";
import { runSpecialGroupChat } from "./chat.js";
import { isSiteUrl, saveLocalConnection, specialGroupConfig, type SpecialGroupConfig } from "./config.js";
import { clearProjectOptionsCache, findPeople, getCreateScreenFields, getProjectOptions, listProjects } from "./jira-lookups.js";
import { localOnly } from "./local-only.js";
import { ReadOnlyJiraClient } from "./read-only-client.js";
import { SPECIAL_GROUP_PROMPT } from "./system-prompt.js";

// HTTP surface under /api/special-group. Handlers stay thin: parse input, call a module, return JSON.

const fail = (res: Response, status: number, error: unknown) =>
  res.status(status).json({ error: error instanceof Error ? error.message : String(error) });

/** Scoped tokens call Jira through api.atlassian.com, which needs the site's cloud ID. */
async function discoverCloudId(siteUrl: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(`${siteUrl}/_edge/tenant_info`, { redirect: "error", signal: AbortSignal.timeout(10000) });
  const data = await response.json().catch(() => ({})) as { cloudId?: unknown };
  if (!response.ok || typeof data.cloudId !== "string" || !/^[a-z0-9-]+$/i.test(data.cloudId)) {
    throw new Error("Couldn't find this site's cloud ID. Check the site address.");
  }
  return data.cloudId;
}

export function specialGroupRoutes(options: { fetchImpl?: typeof fetch; config?: () => SpecialGroupConfig } = {}) {
  const router = Router();
  const fetchImpl = options.fetchImpl ?? fetch;
  const config = options.config ?? specialGroupConfig;
  const client = () => new ReadOnlyJiraClient(config(), fetchImpl);
  router.use(localOnly);

  router.get("/config", (_req, res) => {
    try {
      const { token, siteUrl, defaultProjectKey } = config();
      res.json({ configured: Boolean(token), siteUrl, defaultProjectKey, readOnly: true } satisfies SpecialGroupConnection);
    } catch (error) { fail(res, 400, error); }
  });

  router.get("/prompt", (_req, res) => { res.json({ prompt: SPECIAL_GROUP_PROMPT }); });

  router.post("/connect", async (req, res) => {
    const { email, token, scoped } = req.body ?? {};
    try {
      const siteUrl = String(req.body?.siteUrl ?? config().siteUrl).trim().replace(/\/$/, "");
      if (!isSiteUrl(siteUrl)) throw new Error("The site must look like https://your-site.atlassian.net.");
      if (typeof email !== "string" || !/^[^\s"#]+@[^\s"#]+\.[^\s"#]+$/.test(email.trim())) throw new Error("Enter your Atlassian email.");
      if (typeof token !== "string" || token.trim().length < 10 || token.length > 4096) throw new Error("Paste the complete API token.");
      if (typeof scoped !== "boolean") throw new Error("Say whether the token was created with scopes.");
      const baseUrl = scoped ? `https://api.atlassian.com/ex/jira/${await discoverCloudId(siteUrl, fetchImpl)}` : siteUrl;
      const candidate = new ReadOnlyJiraClient({ siteUrl, baseUrl, email: email.trim(), token: token.trim(), defaultProjectKey: null }, fetchImpl);
      const me = await candidate.get("/rest/api/3/myself");
      const projects = await listProjects(candidate);
      saveLocalConnection({ siteUrl, baseUrl, email: email.trim(), token: token.trim() });
      clearProjectOptionsCache();
      res.json({ connected: true, account: me.displayName ?? null, projects: projects.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connection failed.";
      res.status(400).json({ error: typeof token === "string" && token ? message.replaceAll(token, "[REDACTED]") : message });
    }
  });

  router.get("/projects", async (req, res) => {
    try { res.json({ projects: await listProjects(client(), String(req.query.query ?? "")) }); }
    catch (error) { fail(res, 502, error); }
  });

  router.get("/projects/:key/options", async (req, res) => {
    try { res.json(await getProjectOptions(client(), req.params.key, { fresh: req.query.fresh === "1" })); }
    catch (error) { fail(res, 502, error); }
  });

  router.get("/projects/:key/types/:typeId/fields", async (req, res) => {
    try { res.json({ fields: await getCreateScreenFields(client(), req.params.key, req.params.typeId) }); }
    catch (error) { fail(res, 502, error); }
  });

  router.get("/people", async (req, res) => {
    try { res.json({ people: await findPeople(client(), String(req.query.query ?? "")) }); }
    catch (error) { fail(res, 502, error); }
  });

  router.post("/chat", async (req, res) => {
    try {
      const { draft: rawDraft, ...chat } = req.body ?? {};
      const request = validateChatRequest(chat, { vertexModels: resolveVertexChatModels(), geminiModels: resolveGeminiChatModels(), regions: resolveProbeRegions() });
      if (request.tool || request.cachedContent || request.interactions || request.messages.some(m => m.files)) {
        throw new Error("The Special Group chat accepts plain text messages only.");
      }
      if (request.messages.length > 80) throw new Error("This session is long. Start a new session to continue.");
      const jira = client();
      if (!jira.config.token) { res.status(503).json({ error: "Connect Jira first." }); return; }
      res.json(await runSpecialGroupChat({
        request, draft: sanitizeDraft(rawDraft), client: jira, project: resolveVertexProject(null).project,
        vertexToken: request.provider === "vertex" ? await getVertexAccessToken() : undefined, fetchImpl: options.fetchImpl,
      }));
    } catch (error) { fail(res, 400, error); }
  });

  return router;
}
