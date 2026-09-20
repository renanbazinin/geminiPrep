import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { JiraClient } from "./client.js";
import { JiraReceipts, runJiraChat } from "./chat.js";
import { jiraRoutes } from "./routes.js";
const config = { siteUrl: "https://test.atlassian.net", baseUrl: "https://test.atlassian.net", email: "test@example.com", token: "test-token", projectKey: "DESK" };
const issue = (key = "DESK-1", extra = {}) => ({ key, fields: { project: {key:"DESK"}, summary:"Booking API", status:{name:"To Do"}, issuetype:{name:"Task"}, labels:["chatbot-demo","demo-owner-renan"], ...extra } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status});
afterEach(() => vi.restoreAllMocks());

describe("Jira client", () => {
  it("paginates structured searches and quotes JQL values", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({issues:[issue()], nextPageToken:"page2"})).mockResolvedValueOnce(json({issues:[issue("DESK-2")],isLast:true}));
    const result = await new JiraClient(config,fetcher).search({owner:"Renan",status:'Done" OR project = SECRET'});
    expect(result.issues).toHaveLength(2);
    const first = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(first.jql).toContain('project = "DESK" AND labels = "demo-owner-renan"');
    expect(first.jql).toContain('status = "Done\\" OR project = SECRET"');
    expect(JSON.parse(fetcher.mock.calls[1][1].body).nextPageToken).toBe("page2");
  });
  it("bounds pagination even if Jira repeats an empty page token", async () => {
    const fetcher = vi.fn().mockImplementation(async () => json({issues:[],nextPageToken:"same"}));
    expect((await new JiraClient(config,fetcher).search()).truncated).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("rejects other projects both before the call and after key redirects", async () => {
    const fetcher = vi.fn().mockResolvedValue(json(issue("OTHER-1",{project:{key:"OTHER"}})));
    const client = new JiraClient(config,fetcher);
    await expect(client.get("OTHER-1")).rejects.toThrow("Only DESK");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.get("DESK-1")).rejects.toThrow("Only DESK");
  });
  it("changes only simulated owner labels and leaves unrelated labels alone", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(issue())).mockResolvedValueOnce(new Response(null,{status:204})).mockResolvedValueOnce(json(issue("DESK-1",{labels:["chatbot-demo","demo-owner-koko"]})));
    const result = await new JiraClient(config,fetcher).update({key:"DESK-1",owner:"Koko"});
    const body = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(body.update.labels).toEqual([{remove:"demo-owner-renan"},{add:"demo-owner-koko"}]);
    expect(body.fields.assignee).toBeUndefined();
    expect(result.saved).toBe(true);
  });
  it("uses the discovered transition ID, not the status name", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(issue())).mockResolvedValueOnce(json(issue()))
      .mockResolvedValueOnce(json({transitions:[{id:"73",name:"Finish QA",to:{name:"Done"}}]}))
      .mockResolvedValueOnce(new Response(null,{status:204})).mockResolvedValueOnce(json(issue("DESK-1",{status:{name:"Done"}})));
    await new JiraClient(config,fetcher).transition({key:"DESK-1",status:"Done"});
    expect(JSON.parse(fetcher.mock.calls[3][1].body)).toEqual({transition:{id:"73"}});
  });
  it("discovers create metadata, sends ADF and reports a saved write even when read-back fails", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({issueTypes:[{id:"10002",name:"Task"}],isLast:true}))
      .mockResolvedValueOnce(json({key:"DESK-13"},201)).mockResolvedValueOnce(json({},503));
    const result = await new JiraClient(config,fetcher).create({summary:"New task",description:"Acceptance: works",owner:"Dana"});
    expect(result).toMatchObject({saved:true,key:"DESK-13"});
    const fields = JSON.parse(fetcher.mock.calls[1][1].body).fields;
    expect(fields.issuetype.id).toBe("10002");
    expect(fields.description.type).toBe("doc");
    expect(fields.labels).toContain("demo-owner-dana");
  });
  it("does not retry an uncertain comment write", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(issue())).mockRejectedValueOnce(new Error("network"));
    await expect(new JiraClient(config,fetcher).comment({key:"DESK-1",text:"hello"})).rejects.toThrow("uncertain");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("Jira model loop and request receipts", () => {
  const chatRequest = {provider:"gemini" as const, model:"test-model",temperature:1,maxOutputTokens:1024,messages:[{role:"user" as const,content:"Show tickets"}]};
  it("preserves signatures and every function call, including same-name calls", async () => {
    const client = new JiraClient(config);
    vi.spyOn(client,"get").mockImplementation(async key => client.normalize(issue(key)));
    const content = {role:"model",parts:[{thoughtSignature:"opaque-signature",functionCall:{id:"a",name:"jira_get",args:{key:"DESK-1"}}},{functionCall:{id:"b",name:"jira_get",args:{key:"DESK-2"}}}]};
    const fetcher = vi.fn().mockResolvedValueOnce(json({candidates:[{content}]})).mockResolvedValueOnce(json({candidates:[{content:{role:"model",parts:[{text:"Two tickets."}]}}]}));
    vi.stubEnv("GEMINI_API_KEY","model-key");
    try {
      const result = await runJiraChat({request:chatRequest,client,project:null,fetchImpl:fetcher});
      expect(result.actions).toHaveLength(2);
      const second = JSON.parse(fetcher.mock.calls[1][1].body);
      expect(second.contents[1]).toEqual(content);
      expect(second.contents[2].parts.map((p:any) => p.functionResponse.id)).toEqual(["a","b"]);
      expect(fetcher.mock.calls[0][0]).toContain(":generateContent");
      expect(fetcher.mock.calls[0][0]).not.toContain("streamGenerateContent");
    } finally { vi.unstubAllEnvs(); }
  });
  it("stops the loop after an uncertain write", async () => {
    const client = new JiraClient(config);
    const create = vi.spyOn(client,"create").mockRejectedValue(new Error("Outcome uncertain"));
    const fetcher = vi.fn().mockResolvedValue(json({candidates:[{content:{role:"model",parts:[{functionCall:{name:"jira_create",args:{summary:"Task",description:"Test"}}}]}}]}));
    vi.stubEnv("GEMINI_API_KEY","model-key");
    try {
      const result = await runJiraChat({request:chatRequest,client,project:null,fetchImpl:fetcher});
      expect(result.actions[0].ok).toBe(false); expect(create).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllEnvs(); }
  });
  it("replays completed receipts across instances and refuses reuse with different payloads", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),"jira-receipts-test-"));
    try {
      const id = randomUUID();
      const execute = vi.fn(async () => ({text:"Saved",actions:[]}));
      await new JiraReceipts(directory).run(id,{prompt:"create"},execute);
      expect(await new JiraReceipts(directory).run(id,{prompt:"create"},execute)).toEqual({text:"Saved",actions:[]});
      expect(execute).toHaveBeenCalledTimes(1);
      await expect(new JiraReceipts(directory).run(id,{prompt:"other"},execute)).rejects.toThrow("different message");
    } finally { fs.rmSync(directory,{recursive:true,force:true}); }
  });
  it("does not repeat an in-flight request", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),"jira-receipts-test-"));
    let finish!: (value: any) => void;
    const receipts = new JiraReceipts(directory); const id = randomUUID();
    const first = receipts.run(id,{},() => new Promise(resolve => {finish=resolve;}));
    try { await expect(receipts.run(id,{},async () => ({text:"duplicate",actions:[]}))).rejects.toThrow("already started"); }
    finally { finish({text:"done",actions:[]}); await first; fs.rmSync(directory,{recursive:true,force:true}); }
  });
});

describe("Jira routes", () => {
  it("never returns the credential and rejects cross-origin requests", async () => {
    const app = express(); app.use(express.json()); app.use("/api/jira",jiraRoutes({client:new JiraClient(config)}));
    const response = await request(app).get("/api/jira/config");
    expect(response.status).toBe(200); expect(JSON.stringify(response.body)).not.toContain(config.token);
    expect(response.body.configured).toBe(true);
    expect((await request(app).get("/api/jira/issues").set("Origin","https://evil.example")).status).toBe(403);
    expect((await request(app).get("/api/jira/config").set("Host","evil.example")).status).toBe(403);
  });
});
