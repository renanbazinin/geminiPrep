# 1 · Read-only access to Jira

[עברית](01-read-only-access.he.md) · **1 Access** · [2 Reading Jira](02-reading-jira.en.md) · [3 The create link](03-create-link.en.md) · [4 Chatbot integration](04-chatbot-integration.en.md)

## The idea

A chatbot helps people write good tickets, but it **never creates them**. It reads Jira (projects, work types, epics, people), drafts the ticket, and hands back a link that opens Jira's create screen with everything filled in. The person reviews it and presses **Create**.

Why this design:

- The bot holds **no write credentials**, which makes the security review much simpler.
- The ticket is created **by the person**, with their own permissions and name.
- No accidental or duplicate tickets from a confused model.

This guide covers getting the read-only credential.

## Cloud or Data Center

| | Jira Cloud | Jira Data Center (self-hosted) |
| --- | --- | --- |
| Address | `https://your-company.atlassian.net` | `https://jira.your-company.internal` |
| REST API | `/rest/api/3/` | `/rest/api/2/` |
| Credential | API token **with scopes** | Personal access token (PAT) |
| Auth header | Basic `email:token` | `Authorization: Bearer <PAT>` |
| How it's kept read-only | Read scopes only | A service user with read permissions only |
| User ID in links | `accountId` | `username` |

The examples below set `$JIRA` to the API base address.

## Jira Cloud: scoped API token

1. Go to https://id.atlassian.com/manage-profile/security/api-tokens. It's your account settings, not admin.atlassian.com. If your organization uses Atlassian **service accounts** (admin.atlassian.com → Directory → Service accounts), create the token there instead, so it isn't tied to one employee.
2. Choose **Create API token with scopes** → app **Jira** → scopes **`read:jira-work`** and **`read:jira-user`** only.
3. Scoped tokens call Jira through Atlassian's gateway, which needs your site's cloud ID:

```bash
curl https://your-company.atlassian.net/_edge/tenant_info
# {"cloudId":"56d7178f-…"}

JIRA=https://api.atlassian.com/ex/jira/56d7178f-…
```

4. Test it:

```bash
curl -u "$EMAIL:$TOKEN" "$JIRA/rest/api/3/myself"
# {"accountId":"712020…","displayName":"Ticket Bot","active":true, …}
```

A classic token (without scopes) uses `JIRA=https://your-company.atlassian.net` directly, but it can do everything the user can, including writes. Prefer scoped.

## Jira Data Center: personal access token

PATs have no scopes; a PAT can do whatever its user can. Make the **user** read-only:

1. Create a dedicated user, for example `ticket-bot`.
2. In the projects' permission schemes, give it **Browse Projects** only. No Create, Edit, Comment, or Transition. Add the global **Browse users and groups** permission so people search works.
3. Log in as that user → Profile → **Personal Access Tokens** → **Create token**, with an expiry date.

```bash
JIRA=https://jira.your-company.internal
curl -H "Authorization: Bearer $PAT" "$JIRA/rest/api/2/myself"
# {"name":"ticket-bot","displayName":"Ticket Bot","active":true, …}
```

## Two locks, not one

Even with a read-only credential, make the code read-only too, so a bug or a manipulated prompt can't reach a write endpoint:

```ts
const READ_ONLY = [
  /^\/rest\/api\/[23]\/myself$/,
  /^\/rest\/api\/[23]\/project\/[A-Z][A-Z0-9_]*(\/(components|versions))?$/,
  /^\/rest\/api\/[23]\/issue\/createmeta\/[A-Z][A-Z0-9_]*\/issuetypes(\?|$)/,
  // … one pattern per read in step 2
];

function jiraGet(path: string) {
  if (!READ_ONLY.some(p => p.test(path))) throw new Error(`Blocked: ${path}`);
  return fetch(JIRA + path, { method: "GET", headers: AUTH, redirect: "error" });
}
```

Expose only `jiraGet()` and one search function, with no generic "send request" method. `redirect: "error"` stops credentials from following a redirect somewhere else.

## Keeping the token safe

- Store it in your secret manager (Vault, AWS Secrets Manager, Azure Key Vault, GCP Secret Manager), on the server only.
- Never send it to the browser, and never put it in the model's prompt.
- Remove it from error messages and logs.
- Give it an expiry date and rotate it on a schedule.

## When a call fails

| Status | Usually means |
| --- | --- |
| 401 | Wrong email or token, or a scoped token sent to the site address instead of the gateway |
| 403 | Missing scope or project permission |
| 404 | Doesn't exist, **or** isn't visible to this user. Jira doesn't say which. |
| 429 | Rate limited. Back off using the `Retry-After` header. |

Next: [2 · Reading Jira →](02-reading-jira.en.md)
