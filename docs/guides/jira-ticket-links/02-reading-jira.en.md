# 2 · Reading what the bot needs

[עברית](02-reading-jira.he.md) · [1 Access](01-read-only-access.en.md) · **2 Reading Jira** · [3 The create link](03-create-link.en.md) · [4 Chatbot integration](04-chatbot-integration.en.md)

To fill a ticket correctly, the bot needs the **real** values for one project: its work types, priorities, components, versions, open epics, and the people who can be reporter or assignee. Everything here is a read.

## The reads

| Need | Jira Cloud (`/rest/api/3`) | Data Center (`/rest/api/2`) |
| --- | --- | --- |
| Projects | `GET /project/search?query=…` | `GET /project` |
| Project ID and style | `GET /project/{KEY}` | `GET /project/{KEY}` |
| Work types you can create | `GET /issue/createmeta/{KEY}/issuetypes` | `GET /issue/createmeta/{KEY}/issuetypes` |
| Priorities | `GET /priority/search` | `GET /priority` |
| Components | `GET /project/{KEY}/components` | `GET /project/{KEY}/components` |
| Versions | `GET /project/{KEY}/versions` | `GET /project/{KEY}/versions` |
| Epic Link field ID | `GET /field` | `GET /field` |
| Search (epics, duplicates) | `POST /search/jql` | `GET /search?jql=…` |
| People | `GET /user/search?query=…` | `GET /user/search?username=…` |
| One work item | `GET /issue/{KEY-N}` | `GET /issue/{KEY-N}` |
| Fields on a work type's create screen | `GET /issue/createmeta/{KEY}/issuetypes/{typeId}` | `GET /issue/createmeta/{KEY}/issuetypes/{typeId}` |

Search on Cloud is a `POST` only because the JQL goes in the body. It doesn't change anything.

## Examples

The responses below are trimmed from a real Cloud project, `DESK`.

### Project: ID and style

```bash
curl -u "$EMAIL:$TOKEN" "$JIRA/rest/api/3/project/DESK"
```

```json
{ "id": "10001", "key": "DESK", "name": "DeskFlow Demo", "style": "next-gen" }
```

- `id` (not the key) is what the create link needs.
- `style` decides how an epic is linked: `next-gen` means **team-managed** and uses the `parent` field; `classic` means **company-managed** and uses the Epic Link field. Data Center is always the classic kind. See [step 3](03-create-link.en.md).

### Work types you can create

```bash
curl -u "$EMAIL:$TOKEN" "$JIRA/rest/api/3/issue/createmeta/DESK/issuetypes"
```

```json
{ "issueTypes": [
  { "id": "10006", "name": "Epic",    "subtask": false, "hierarchyLevel": 1 },
  { "id": "10007", "name": "Subtask", "subtask": true,  "hierarchyLevel": -1 },
  { "id": "10009", "name": "Story",   "subtask": false, "hierarchyLevel": 0 },
  { "id": "10011", "name": "Bug",     "subtask": false, "hierarchyLevel": 0 }
] }
```

Use `createmeta` rather than the project's full type list: it returns only types this user can create. Skip `subtask: true` types, since a subtask needs an existing parent. Data Center returns the same list under `values` instead of `issueTypes`.

### Open epics

Epics are the types at `hierarchyLevel: 1`. Their name varies by language and configuration, so don't hard-code "Epic".

```bash
curl -u "$EMAIL:$TOKEN" -X POST "$JIRA/rest/api/3/search/jql" \
  -H "Content-Type: application/json" \
  -d '{"jql":"project = \"DESK\" AND issuetype in (\"Epic\") AND statusCategory != Done ORDER BY updated DESC","fields":["summary","status"],"maxResults":50}'
```

```json
{ "issues": [
  { "key": "DESK-15", "fields": { "summary": "Booking reliability", "status": { "name": "To Do" } } },
  { "key": "DESK-14", "fields": { "summary": "Booking experience",  "status": { "name": "To Do" } } }
] }
```

On Data Center: `GET $JIRA/rest/api/2/search?jql=<url-encoded JQL>&fields=summary,status`.

### Epic Link field (company-managed and Data Center)

```bash
curl -u "$EMAIL:$TOKEN" "$JIRA/rest/api/3/field"
```

Find the field whose `schema.custom` is `com.pyxis.greenhopper.jira:gh-epic-link`. Its `id`, for example `customfield_10014`, differs per site, so look it up instead of hard-coding it.

### People

```bash
curl -u "$EMAIL:$TOKEN" "$JIRA/rest/api/3/user/search?query=renan&maxResults=10"
```

```json
[ { "accountId": "712020…", "accountType": "atlassian", "displayName": "Renan Bazinin", "active": true } ]
```

- Keep only `active` users. On Cloud, also keep only `accountType: "atlassian"`; this drops bots and apps.
- Pass only the ID and display name to the model. Never pass email addresses.
- Data Center returns `name` (the username), which is what its create link uses.

### Duplicates

Before drafting, search the project for similar open work:

```sql
project = "DESK" AND text ~ "booking Safari crash" AND statusCategory != Done ORDER BY updated DESC
```

## Building JQL safely

The model and the user supply the search words, so never paste them into JQL directly. Quote and escape every value:

```ts
const jqlString = (v: string) => '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

`project = ${jqlString(key)} AND text ~ ${jqlString(words)}`
// words = 'Done" OR project = SECRET'  →  stays a harmless string
```

Also check that keys match `^[A-Z][A-Z0-9_]*$` (project) or `^[A-Z][A-Z0-9_]*-\d+$` (work item) before putting them in a URL path.

## Practical tips

- **Cache** a project's options for a few minutes. They rarely change, and a single chat turn may ask for them several times.
- **Tolerate partial failure.** If priorities or versions return 403, use an empty list and keep going. Only the project itself is required.
- **Show only unreleased, unarchived versions.** New work doesn't target a shipped version.
- **Limit results**, for example 50 epics and 20 search hits, to keep the model's context small.

Next: [3 · The create link →](03-create-link.en.md)
