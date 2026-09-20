import { Router } from "express";
import fs from "node:fs";
import { resolveGeminiChatModels, resolveProbeRegions, resolveVertexChatModels, resolveVertexProject } from "../catalog.js";
import { validateChatRequest } from "../chat/validation.js";
import { getVertexAccessToken } from "../vertex-auth.js";
import { JiraClient } from "./client.js";
import { JiraReceipts, runJiraChat } from "./chat.js";

export function jiraRoutes(options: { fetchImpl?: typeof fetch; client?: JiraClient; receipts?: JiraReceipts } = {}) {
  const router = Router();
  const receipts = options.receipts ?? new JiraReceipts();
  const client = () => options.client ?? new JiraClient(undefined, options.fetchImpl);
  router.use((req, res, next) => {
    // The existing app is a local lab, not an authenticated enterprise server.
    const address = req.socket.remoteAddress ?? "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)) {
      res.status(403).json({ error: "Jira demo access is limited to this computer." }); return;
    }
    const origin = req.headers.origin;
    const localHosts = ["localhost", "127.0.0.1", "[::1]"];
    try {
      if (!localHosts.includes(new URL(`http://${req.headers.host}`).hostname)) throw new Error();
    } catch { res.status(403).json({ error: "Use localhost to access the Jira demo." }); return; }
    if (origin) {
      try {
        const url = new URL(origin);
        const sameOrigin = localHosts.includes(url.hostname) && url.host === req.headers.host;
        const localDev = localHosts.includes(url.hostname) && ["5173", "5174", "3001"].includes(url.port);
        if (!sameOrigin && !localDev) throw new Error();
      } catch { res.status(403).json({ error: "This origin cannot access Jira." }); return; }
    }
    if (req.method === "POST" && !req.is("application/json")) { res.status(415).json({ error: "JSON is required." }); return; }
    next();
  });
  router.get("/config", (_req, res) => {
    try { const { token, siteUrl, projectKey } = client().config;
      res.json({ configured: Boolean(token), siteUrl, projectKey, ownershipMode: "simulated-labels" });
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });
  router.get("/issues", async (req, res) => {
    try { res.json(await client().search(req.query)); }
    catch (error) { res.status(502).json({ error: (error as Error).message }); }
  });
  router.post("/connect", async (req, res) => {
    try {
      const { token, email, scoped } = req.body;
      if (typeof token !== "string" || token.length < 10 || token.length > 4096 || /[\r\n"#]/.test(token)
        || typeof email !== "string" || !/^[^\s"#]+@[^\s"#]+\.[^\s"#]+$/.test(email) || typeof scoped !== "boolean")
        throw new Error("Enter your Atlassian email and API token.");
      const current = client().config;
      const baseUrl = scoped ? "https://api.atlassian.com/ex/jira/56d7178f-a215-4681-8587-2b391744df0d" : current.siteUrl;
      // The connect form is deliberately bound to the prepared demo site.
      if (current.siteUrl !== "https://renanbazinin2.atlassian.net") throw new Error("For another site, configure server environment variables directly.");
      const candidate = new JiraClient({ ...current, baseUrl, token, email }, options.fetchImpl);
      await candidate.request(`/rest/api/3/project/${current.projectKey}`);
      await candidate.search();
      fs.writeFileSync(".env.jira.local", `JIRA_EMAIL=${email}\nJIRA_API_TOKEN=${token}\nJIRA_API_BASE_URL=${baseUrl}\n`, { mode: 0o600 });
      res.json({ connected: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connection failed.";
      res.status(400).json({ error: typeof req.body.token === "string" && req.body.token ? message.replaceAll(req.body.token, "[REDACTED]") : message });
    }
  });
  router.post("/chat", async (req, res) => {
    try {
      const request = validateChatRequest(req.body, { vertexModels: resolveVertexChatModels(), geminiModels: resolveGeminiChatModels(), regions: resolveProbeRegions() });
      if (request.tool || request.cachedContent || request.messages.some(m => m.files)) throw new Error("Jira chat accepts text messages only.");
      if (request.messages.length > 60) throw new Error("Start a new Jira conversation after 60 messages.");
      const jira = client();
      if (!jira.config.token) { res.status(503).json({ error: "Add JIRA_API_TOKEN to .env, then refresh the connection." }); return; }
      const result = await receipts.run(req.body.requestId, { request, site: jira.config.siteUrl, project: jira.config.projectKey }, async onAction => runJiraChat({
        request, client: jira, project: resolveVertexProject(null).project,
        vertexToken: request.provider === "vertex" ? await getVertexAccessToken() : undefined,
        fetchImpl: options.fetchImpl, onAction,
      }));
      res.json(result);
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });
  return router;
}
