# 3 · The prefilled create link

[עברית](03-create-link.he.md) · [1 Access](01-read-only-access.en.md) · [2 Reading Jira](02-reading-jira.en.md) · **3 The create link** · [4 Chatbot integration](04-chatbot-integration.en.md)

Jira can open its create screen with fields already filled in from the URL. The person sees a normal Jira form, checks it, and presses **Create**. Nothing is created by opening the link.

```
<site>/secure/CreateIssueDetails!init.jspa?pid=…&issuetype=…&summary=…
```

`<site>` is the address people browse to (`https://your-company.atlassian.net` or `https://jira.your-company.internal`), **not** the API gateway from step 1.

## A real example

```
https://your-company.atlassian.net/secure/CreateIssueDetails!init.jspa
  ?pid=10001                      ← project DESK (ID, not key)
  &issuetype=10011                ← Bug
  &summary=Booking%20page%20crashes%20on%20Safari%20when%20selecting%20a%20date
  &description=Context%3A%0AThe%20booking%20page%20crashes...
  &priority=2                     ← High
  &reporter=712020…               ← Renan (Cloud accountId)
  &parent=DESK-15                 ← epic "Booking reliability"
```

## Parameters

| Field | Parameter | Value | Example |
| --- | --- | --- | --- |
| Project | `pid` | project **ID** | `pid=10001` |
| Work type | `issuetype` | type ID | `issuetype=10011` |
| Summary | `summary` | text | `summary=Date%20picker%20crash` |
| Description | `description` | text, line breaks as `%0A` | `description=Steps%3A%0A1.%20Open` |
| Priority | `priority` | priority ID | `priority=2` |
| Reporter | `reporter` | Cloud `accountId` / DC `username` | `reporter=712020…` |
| Assignee | `assignee` | same as reporter | `assignee=jdoe` |
| Labels | `labels` | repeated, once per label, no spaces | `labels=safari&labels=booking-flow` |
| Components | `components` | repeated component IDs | `components=201&components=202` |
| Fix versions | `fixVersions` | repeated version IDs | `fixVersions=10000` |
| Epic (team-managed) | `parent` | epic key | `parent=DESK-15` |
| Epic (company-managed, DC) | Epic Link field ID | epic key | `customfield_10014=OPS-7` |
| Any other field | `customfield_NNNNN` | the field's value | `customfield_10050=EU` |

The form wants IDs, which is why [step 2](02-reading-jira.en.md) collects them. Resolve every name ("Bug", "High", "Renan") to its ID before building the link.

## Encoding

| Character | Encoded | Why |
| --- | --- | --- |
| space | `%20` | Use `%20`, not `+`. `%20` means "space" however the page decodes the URL. |
| line break | `%0A` | Keeps description sections on separate lines |
| `+` | `%2B` | "C++ build fails" stays "C++" |
| `&` `=` `#` `:` | `%26` `%3D` `%23` `%3A` | Can't break the query string |

The description is plain text. Data Center also renders Jira wiki markup in it (`h3. Steps`, `*bold*`, `* bullet`).

## A builder you can copy

No dependencies. It works in Node and in the browser:

```ts
type Named = { id: string; name: string };
type Draft = {
  project?: { id: string; key: string }; issueType?: Named; summary?: string; description?: string;
  priority?: Named; reporter?: string; assignee?: string;            // accountId (Cloud) or username (DC)
  labels?: string[]; components?: Named[]; fixVersions?: Named[]; parentKey?: string;
};

export function buildCreateLink(site: string, d: Draft, parentParam: string | null) {
  const missing = [!d.project && "project", !d.issueType && "work type", !d.summary && "summary"]
    .filter((m): m is string => Boolean(m));
  if (!d.project || !d.issueType) return { url: null, missing };
  const p = new URLSearchParams({ pid: d.project.id, issuetype: d.issueType.id });
  if (d.summary) p.set("summary", d.summary);
  if (d.description) p.set("description", d.description);
  if (d.priority) p.set("priority", d.priority.id);
  if (d.reporter) p.set("reporter", d.reporter);
  if (d.assignee) p.set("assignee", d.assignee);
  d.labels?.forEach(l => p.append("labels", l.trim().replace(/\s+/g, "-")));
  d.components?.forEach(c => p.append("components", c.id));
  d.fixVersions?.forEach(v => p.append("fixVersions", v.id));
  if (d.parentKey && parentParam) p.set(parentParam, d.parentKey);   // "parent" or "customfield_10014"
  const url = `${site}/secure/CreateIssueDetails!init.jspa?${p.toString().replace(/\+/g, "%20")}`;
  return { url, missing };
}
```

The `+` replacement is safe: `URLSearchParams` writes a real `+` as `%2B`, so every remaining `+` was a space.

## Limits and checks

- **Length.** Keep links under about 6,000 characters. Proxies and browsers can cut longer ones. If the description is long, warn the user and let them paste it on the create screen.
- **Fields missing from the create screen are ignored.** If a field isn't on that work type's create screen, Jira silently drops its parameter. Check with `GET /issue/createmeta/{KEY}/issuetypes/{typeId}`, which lists each `fieldId` on the screen. Leave missing fields out of the link and tell the user. On a real team-managed project, `priority` wasn't on any create screen, so `priority=2` would have been silently dropped.
- **Not every parameter is documented.** Atlassian documents `pid`, `issuetype`, `summary`, and `description`. Check the rest once on your instance: build a full link, open it, compare each field, and close the form without creating.
- **The parent can't always be prefilled.** If neither `parent` nor an Epic Link field applies, leave it out and tell the user which epic to pick on the screen.

Next: [4 · Chatbot integration →](04-chatbot-integration.en.md)
