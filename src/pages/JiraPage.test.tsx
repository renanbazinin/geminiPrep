// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { JiraPage } from "./JiraPage";
vi.mock("../contexts/AppContext", () => ({ useApp: () => ({ settings: { provider:"gemini",models:{gemini:"model"},temperature:1,maxOutputTokens:1024,thinkingLevel:"low",systemInstruction:"" } }) }));
vi.mock("../components/MarkdownMessage", () => ({ MarkdownMessage: ({children}: {children:string}) => <div>{children}</div> }));
const connection = {configured:true,siteUrl:"https://example.atlassian.net",projectKey:"DESK",ownershipMode:"simulated-labels"};
const tickets = [
  {key:"DESK-4",summary:"Booking API",status:"In Progress",type:"Story",owner:"Renan",description:"API acceptance criteria",url:"https://example.atlassian.net/browse/DESK-4",assignee:null},
  {key:"DESK-8",summary:"Calendar screen",status:"In QA",type:"Story",owner:"Bobo",description:"Calendar acceptance criteria",url:"https://example.atlassian.net/browse/DESK-8",assignee:null},
];
const response = (data:unknown) => Promise.resolve(new Response(JSON.stringify(data),{status:200}));
beforeEach(() => { localStorage.clear(); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("Jira space", () => {
  it("renders live tickets and filters by demo owner and status", async () => {
    vi.stubGlobal("fetch", vi.fn((url:string) => response(url.endsWith("config") ? connection : {issues:tickets,fetchedAt:new Date().toISOString(),truncated:false})));
    render(<MemoryRouter><JiraPage /></MemoryRouter>);
    await screen.findByText("Booking API");
    fireEvent.click(screen.getByRole("button",{name:/R Renan Software/}));
    expect(screen.queryByText("Calendar screen")).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"Renan ×"}));
    fireEvent.change(screen.getByLabelText("Filter by status"),{target:{value:"In QA"}});
    expect(screen.queryByText("Booking API")).toBeNull();
    expect(screen.getByText("Calendar screen")).toBeTruthy();
  });
  it("keeps credentials out of browser history storage and clears the token after connecting", async () => {
    let connected=false;
    vi.stubGlobal("fetch",vi.fn((url:string) => {
      if(url.endsWith("connect")){ connected=true; return response({connected:true}); }
      if(url.endsWith("config")) return response({...connection,configured:connected});
      return response({issues:tickets,fetchedAt:new Date().toISOString(),truncated:false});
    }));
    render(<MemoryRouter><JiraPage /></MemoryRouter>);
    await screen.findByLabelText("API token");
    fireEvent.change(screen.getByLabelText("API token"),{target:{value:"test-secret-token"}});
    fireEvent.click(screen.getByRole("button",{name:"Connect Jira"}));
    await screen.findByText("Booking API");
    expect(screen.queryByLabelText("API token")).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain("test-secret-token");
    fireEvent.click(screen.getByRole("button",{name:"Connection"}));
    expect((screen.getByLabelText("API token") as HTMLInputElement).value).toBe("");
  });
  it("sends the selected model and a request ID, shows tool results, and refreshes tickets", async () => {
    const fetcher = vi.fn((url:string) => response(url.endsWith("config") ? connection : url.endsWith("chat") ? {text:"DESK-4 is in progress.",actions:[{tool:"jira_get",ok:true,result:{key:"DESK-4"}}]} : {issues:tickets,fetchedAt:new Date().toISOString(),truncated:false}));
    vi.stubGlobal("fetch",fetcher);
    render(<MemoryRouter><JiraPage /></MemoryRouter>);
    await screen.findByText("Booking API");
    fireEvent.change(screen.getByLabelText("Message Jira assistant"),{target:{value:"Read DESK-4"}});
    fireEvent.click(screen.getByRole("button",{name:"Send"}));
    await screen.findByText("DESK-4 is in progress.");
    const call = fetcher.mock.calls.find(([url]) => url.endsWith("chat")) as unknown as [string,RequestInit];
    const body=JSON.parse(call[1].body as string);
    expect(body.model).toBe("model"); expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
    await waitFor(() => expect(fetcher.mock.calls.filter(([url])=>url.endsWith("issues")).length).toBe(2));
    expect(screen.getByText("1 Jira action")).toBeTruthy();
  });
});
