# DeskFlow Jira space

Open `/jira` in Gemini Prep. The sidebar's **DeskFlow · Jira** entry opens a dedicated conversation beside a live ticket list. The normal chat, image tools, and labs remain available.

## Connect

1. Run `npm run dev` and visit `http://localhost:5173/jira`.
2. Create a scoped Jira token from https://id.atlassian.com/manage-profile/security/api-tokens with `read:jira-work`, `write:jira-work`, and `read:jira-user`.
3. Paste the complete token into **Connect Jira**, verify your Atlassian email, and leave the scopes checkbox checked. Unscoped tokens use the unchecked option.
4. The server verifies project and search access before saving `.env.jira.local`. This file is ignored by Git. It overrides Jira values in `.env`; credentials are not returned to the browser or included in model prompts. Reconnect with a replacement token to rotate it.
5. The prepared connection points to `renanbazinin2.atlassian.net`, project `DESK`. For another site, configure `JIRA_SITE_URL`, `JIRA_API_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, and `JIRA_PROJECT_KEY` in server environment files. The UI connection form is intentionally for this demo site only.

Scoped tokens use `https://api.atlassian.com/ex/jira/<cloudId>`. Unscoped tokens use the site's `https://<name>.atlassian.net` URL. A 401 means authentication was rejected, not that the model failed. Check the full token, its expiry, email, and scopes setting; newly created tokens may take a minute to activate. [Atlassian token documentation](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/).

## Use

- “Show my current tickets.”
- “What is Renan working on?”
- “Move DESK-4 to In QA.”
- “Change the demo owner of DESK-5 to Bobo.”
- “Create a Task for cancellation error handling, demo owner Bobo, with acceptance criteria.”
- “Add a comment to DESK-6: Koko should verify concurrent requests.”

The team strip filters the ticket panel. These display filters do not silently change the chatbot's scope; specify a person in chat when needed. Labels represent demo owners: Renan is software/backend, Bobo software/frontend, Dana project manager, Koko QA. These labels are separate from real Jira assignees. The integration does not pretend to create accounts or send messages to the fictional people.

The model/provider/region come from the app's Settings. Current ticket facts are fetched through Jira tools. Ticket results refresh after each completed chat request, and **Refresh tickets** fetches them on demand. The search panel shows up to 200 items, explicitly indicating truncation.

## Implementation and limits

`server/jira/client.ts` provides scoped, typed API operations. Searches build JQL from structured filters, issue keys and returned project membership are checked, and status transitions are discovered live. No deletion or unrestricted HTTP tool is exposed. Creation discovers work-type IDs; required-field errors are returned rather than inventing values.

`server/jira/chat.ts` runs up to six model rounds and sixteen tools. It uses complete non-streaming model response objects between steps to preserve function-call IDs and thought signatures, then returns the answer and action results. The UI shows a working indicator while it runs. [Gemini thought-signature documentation](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures).

Durable request receipts in `.jira-demo/receipts` prevent replaying the same HTTP request after reconnects or server restarts. Successful actions survive final model errors. Uncertain writes stop execution and are never blindly retried. A new message is a new operation: inspect Jira before manually repeating an interrupted mutation. Receipts may contain ticket data and should be retained while requests might be retried. They are local and Git-ignored.

Chat display history is stored in this browser separately from normal chat. Tool round-trip content is preserved within each request; subsequent user turns send display history and the model fetches live state as needed. **New chat** clears this space's displayed conversation, not Jira work items.

This is a local demo: `/api/jira` requires loopback access and rejects non-local origins/hosts. Before deploying it for multiple users, replace this boundary with authenticated user sessions, authorized project mappings, per-user credentials, and managed secret storage. Do not expose the demo directly as an enterprise service.

Tests mock both model and Jira responses. Run `npm test`, `npm run typecheck`, and `npm run build`. Live verification requires a valid token and model provider.
