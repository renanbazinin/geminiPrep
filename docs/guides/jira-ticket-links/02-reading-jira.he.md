# 2 · קריאת הנתונים שהבוט צריך

[English](02-reading-jira.en.md) · [1 גישה](01-read-only-access.he.md) · **2 קריאה מ־Jira** · [3 קישור היצירה](03-create-link.he.md) · [4 שילוב בצ׳אטבוט](04-chatbot-integration.he.md)

כדי למלא טיקט נכון, הבוט צריך את הערכים **האמיתיים** של פרויקט אחד: סוגי העבודה (work types) שלו, העדיפויות, הרכיבים, הגרסאות, ה־Epics (אפיקים) הפתוחים, והאנשים שיכולים להיות מדווח (reporter) או אחראי (assignee). כל הפעולות כאן הן קריאה בלבד.

## פעולות הקריאה

| צורך | Jira Cloud (`/rest/api/3`) | Data Center (`/rest/api/2`) |
| --- | --- | --- |
| פרויקטים | `GET /project/search?query=…` | `GET /project` |
| מזהה הפרויקט והסגנון שלו | `GET /project/{KEY}` | `GET /project/{KEY}` |
| סוגי עבודה שאפשר ליצור | `GET /issue/createmeta/{KEY}/issuetypes` | `GET /issue/createmeta/{KEY}/issuetypes` |
| עדיפויות | `GET /priority/search` | `GET /priority` |
| רכיבים | `GET /project/{KEY}/components` | `GET /project/{KEY}/components` |
| גרסאות | `GET /project/{KEY}/versions` | `GET /project/{KEY}/versions` |
| מזהה השדה Epic Link | `GET /field` | `GET /field` |
| חיפוש (Epics, כפילויות) | `POST /search/jql` | `GET /search?jql=…` |
| אנשים | `GET /user/search?query=…` | `GET /user/search?username=…` |
| פריט עבודה (work item) בודד | `GET /issue/{KEY-N}` | `GET /issue/{KEY-N}` |
| השדות במסך היצירה של סוג עבודה | `GET /issue/createmeta/{KEY}/issuetypes/{typeId}` | `GET /issue/createmeta/{KEY}/issuetypes/{typeId}` |

החיפוש ב־Cloud הוא `POST` רק משום שה־JQL נשלח בגוף הבקשה. הוא לא משנה שום דבר.

## דוגמאות

התשובות שלהלן מקוצרות, ונלקחו מפרויקט Cloud אמיתי, `DESK`.

### פרויקט: מזהה וסגנון

```bash
curl -u "$EMAIL:$TOKEN" "$JIRA/rest/api/3/project/DESK"
```

```json
{ "id": "10001", "key": "DESK", "name": "DeskFlow Demo", "style": "next-gen" }
```

- קישור היצירה צריך את `id` (ולא את המפתח).
- השדה `style` קובע איך מקשרים טיקט ל־Epic: ‏`next-gen` פירושו פרויקט **מנוהל־צוות** (team-managed), שמשתמש בשדה `parent`; ‏`classic` פירושו פרויקט **מנוהל־חברה** (company-managed), שמשתמש בשדה Epic Link. ב־Data Center הפרויקטים תמיד מהסוג הקלאסי. ראו [שלב 3](03-create-link.he.md).

### סוגי עבודה שאפשר ליצור

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

השתמשו ב־`createmeta` ולא ברשימת הסוגים המלאה של הפרויקט: הוא מחזיר רק סוגים שהמשתמש הזה יכול ליצור. דלגו על סוגים עם `subtask: true`, כי תת־משימה צריכה הורה (parent) קיים. ב־Data Center אותה רשימה מוחזרת תחת `values` במקום תחת `issueTypes`.

### ה־Epics הפתוחים

ה־Epics הם הסוגים שמסומנים ב־`hierarchyLevel: 1`. השם שלהם משתנה לפי השפה וההגדרות, לכן אל תקבעו את «Epic» בקוד.

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

ב־Data Center: ‏`GET $JIRA/rest/api/2/search?jql=<url-encoded JQL>&fields=summary,status`.

### השדה Epic Link (מנוהל־חברה ו־Data Center)

```bash
curl -u "$EMAIL:$TOKEN" "$JIRA/rest/api/3/field"
```

מצאו את השדה שה־`schema.custom` שלו הוא `com.pyxis.greenhopper.jira:gh-epic-link`. ה־`id` שלו, למשל `customfield_10014`, שונה מאתר לאתר, לכן חפשו אותו במקום לקבוע אותו בקוד.

### אנשים

```bash
curl -u "$EMAIL:$TOKEN" "$JIRA/rest/api/3/user/search?query=renan&maxResults=10"
```

```json
[ { "accountId": "712020…", "accountType": "atlassian", "displayName": "Renan Bazinin", "active": true } ]
```

- השאירו רק משתמשים פעילים (`active`). ב־Cloud השאירו גם רק `accountType: "atlassian"`; כך מסננים בוטים ואפליקציות.
- העבירו למודל רק את המזהה ואת שם התצוגה. לעולם אל תעבירו כתובות אימייל.
- ב־Data Center מוחזר `name` (שם המשתמש), וזה הערך שקישור היצירה שם משתמש בו.

### כפילויות

לפני ניסוח הטיוטה, חפשו בפרויקט עבודה פתוחה דומה:

```sql
project = "DESK" AND text ~ "booking Safari crash" AND statusCategory != Done ORDER BY updated DESC
```

## בניית JQL בצורה בטוחה

מילות החיפוש מגיעות מהמודל ומהמשתמש, לכן לעולם אל תדביקו אותן ישירות לתוך ה־JQL. עטפו כל ערך במירכאות ובצעו לו escape:

```ts
const jqlString = (v: string) => '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

`project = ${jqlString(key)} AND text ~ ${jqlString(words)}`
// words = 'Done" OR project = SECRET'  →  stays a harmless string
```

בדקו גם שמפתחות תואמים ל־`^[A-Z][A-Z0-9_]*$` (פרויקט) או ל־`^[A-Z][A-Z0-9_]*-\d+$` (פריט עבודה) לפני שמכניסים אותם לנתיב ב־URL.

## טיפים מעשיים

- **שמרו במטמון** את האפשרויות של פרויקט לכמה דקות. הן משתנות לעיתים רחוקות, ותור אחד בצ׳אט עשוי לבקש אותן כמה פעמים.
- **התמודדו עם כשל חלקי.** אם העדיפויות או הגרסאות מחזירות 403, השתמשו ברשימה ריקה והמשיכו. רק הפרויקט עצמו הוא חובה.
- **הציגו רק גרסאות שלא שוחררו ולא הועברו לארכיון.** גרסה שכבר שוחררה אינה גרסת יעד לעבודה חדשה.
- **הגבילו את מספר התוצאות**, למשל 50 Epics ו־20 תוצאות חיפוש, כדי שההקשר של המודל יישאר קטן.

הבא: [3 · קישור היצירה ←](03-create-link.he.md)
