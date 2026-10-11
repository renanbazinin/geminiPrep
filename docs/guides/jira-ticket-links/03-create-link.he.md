# 3 · קישור היצירה הממולא מראש

[English](03-create-link.en.md) · [1 גישה](01-read-only-access.he.md) · [2 קריאה מ־Jira](02-reading-jira.he.md) · **3 קישור היצירה** · [4 שילוב בצ׳אטבוט](04-chatbot-integration.he.md)

Jira יכולה לפתוח את מסך היצירה שלה כשהשדות כבר ממולאים מתוך ה־URL. המשתמש רואה טופס Jira רגיל, בודק אותו ולוחץ **Create** (יצירה). פתיחת הקישור לבדה אינה יוצרת דבר.

```
<site>/secure/CreateIssueDetails!init.jspa?pid=…&issuetype=…&summary=…
```

`<site>` הוא הכתובת שאנשים גולשים אליה (`https://your-company.atlassian.net` או `https://jira.your-company.internal`), **ולא** שער ה־API (API gateway) משלב 1.

## דוגמה אמיתית

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

## פרמטרים

| שדה | פרמטר | ערך | דוגמה |
| --- | --- | --- | --- |
| פרויקט | `pid` | **המזהה** (ID) של הפרויקט | `pid=10001` |
| סוג עבודה (work type) | `issuetype` | מזהה הסוג | `issuetype=10011` |
| תקציר | `summary` | טקסט | `summary=Date%20picker%20crash` |
| תיאור | `description` | טקסט, ירידות שורה כ־`%0A` | `description=Steps%3A%0A1.%20Open` |
| עדיפות | `priority` | מזהה העדיפות | `priority=2` |
| מדווח (reporter) | `reporter` | `accountId` ב־Cloud / `username` ב־DC | `reporter=712020…` |
| אחראי (assignee) | `assignee` | כמו במדווח | `assignee=jdoe` |
| תוויות | `labels` | חוזר, פעם אחת לכל תווית, ללא רווחים | `labels=safari&labels=booking-flow` |
| רכיבים | `components` | מזהי רכיבים, חוזר | `components=201&components=202` |
| גרסאות יעד | `fixVersions` | מזהי גרסאות, חוזר | `fixVersions=10000` |
| Epic (אפיק), פרויקט מנוהל־צוות (team-managed) | `parent` | מפתח ה־Epic | `parent=DESK-15` |
| Epic, פרויקט מנוהל־חברה (company-managed), DC | מזהה השדה Epic Link | מפתח ה־Epic | `customfield_10014=OPS-7` |
| כל שדה אחר | `customfield_NNNNN` | ערך השדה | `customfield_10050=EU` |

הטופס מצפה למזהים (IDs), ולכן [שלב 2](02-reading-jira.he.md) אוסף אותם. המירו כל שם («Bug», «High», «Renan») למזהה שלו לפני שבונים את הקישור.

## קידוד

| תו | בקידוד | למה |
| --- | --- | --- |
| רווח | `%20` | השתמשו ב־`%20`, לא ב־`+`. ‏`%20` פירושו «רווח» בכל דרך שבה הדף מפענח את ה־URL. |
| ירידת שורה | `%0A` | שומר על חלקי התיאור בשורות נפרדות |
| `+` | `%2B` | «C++ build fails» נשאר «C++» |
| `&` `=` `#` `:` | `%26` `%3D` `%23` `%3A` | כך הם לא שוברים את מחרוזת השאילתה (query string) |

התיאור הוא טקסט פשוט. ב־Data Center מתפרש בו גם תחביר Jira wiki markup (`h3. Steps`, `*bold*`, `* bullet`).

## בונה קישור להעתקה

ללא תלויות. הוא עובד גם ב־Node וגם בדפדפן:

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

ההחלפה של `+` בטוחה: `URLSearchParams` כותב `+` אמיתי כ־`%2B`, כך שכל `+` שנותר היה במקור רווח.

## מגבלות ובדיקות

- **אורך.** שמרו על קישורים קצרים מכ־6,000 תווים. שרתי proxy ודפדפנים עלולים לקטוע קישורים ארוכים יותר. אם התיאור ארוך, הזהירו את המשתמש ותנו לו להדביק אותו במסך היצירה.
- **שדות מוסתרים אינם נקלטים.** אם שדה אינו מופיע במסך היצירה של הפרויקט, Jira משמיטה את הפרמטר שלו בשקט.
- **לא כל הפרמטרים מתועדים.** Atlassian מתעדת את `pid`,‏ `issuetype`,‏ `summary` ו־`description`. את השאר בדקו פעם אחת במופע שלכם: בנו קישור מלא, פתחו אותו, השוו כל שדה, וסגרו את הטופס בלי ליצור.
- **לא תמיד אפשר למלא מראש את ההורה (parent).** אם לא `parent` ולא שדה Epic Link רלוונטיים, השמיטו אותו ואמרו למשתמש איזה Epic לבחור במסך.

הבא: [4 · שילוב בצ׳אטבוט ←](04-chatbot-integration.he.md)
