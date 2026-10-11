# 1 · גישת קריאה בלבד ל־Jira

[English](01-read-only-access.en.md) · **1 גישה** · [2 קריאה מ־Jira](02-reading-jira.he.md) · [3 קישור היצירה](03-create-link.he.md) · [4 שילוב בצ׳אטבוט](04-chatbot-integration.he.md)

## הרעיון

הצ׳אטבוט עוזר לאנשים לכתוב טיקטים טובים, אבל **לעולם לא יוצר אותם בעצמו**. הוא קורא מ־Jira (פרויקטים, סוגי עבודה (work types), Epics (אפיקים), אנשים), מנסח טיוטה של הטיקט ומחזיר קישור שפותח את מסך היצירה של Jira כשכל השדות כבר ממולאים. האדם עובר על הטיוטה ולוחץ על **Create**.

למה דווקא התכנון הזה:

- לבוט **אין הרשאות כתיבה**, וזה מפשט מאוד את סקירת האבטחה.
- הטיקט נוצר **על ידי האדם עצמו**, עם ההרשאות והשם שלו.
- אין טיקטים שנוצרו בטעות ואין כפילויות בגלל מודל שהתבלבל.

המדריך הזה מסביר איך להשיג פרטי גישה לקריאה בלבד.

## ההבדלים בין Cloud ל־Data Center

| | Jira Cloud | Jira Data Center (אירוח עצמי) |
| --- | --- | --- |
| כתובת | `https://your-company.atlassian.net` | `https://jira.your-company.internal` |
| REST API | `/rest/api/3/` | `/rest/api/2/` |
| פרטי גישה | טוקן API **עם הרשאות (scopes)** | טוקן גישה אישי (PAT) |
| כותרת אימות | Basic `email:token` | `Authorization: Bearer <PAT>` |
| איך מבטיחים קריאה בלבד | רק הרשאות קריאה | משתמש שירות עם הרשאות קריאה בלבד |
| מזהה משתמש בקישורים | `accountId` | `username` |

בדוגמאות שלהלן `$JIRA` מכיל את כתובת הבסיס של ה־API.

## טוקן API עם הרשאות ב־Jira Cloud

1. היכנסו אל https://id.atlassian.com/manage-profile/security/api-tokens. זה עמוד הגדרות החשבון שלכם, לא admin.atlassian.com. אם הארגון שלכם משתמש ב־**חשבונות שירות** (service accounts) של Atlassian (admin.atlassian.com → Directory → Service accounts), צרו את הטוקן שם, כדי שהוא לא יהיה קשור לעובד מסוים.
2. בחרו **Create API token with scopes**, אחר כך את האפליקציה **Jira**, ואז רק את ההרשאות (scopes) **`read:jira-work`** ו־**`read:jira-user`**.
3. טוקנים עם הרשאות פונים ל־Jira דרך ה־gateway של Atlassian, ולשם כך צריך את מזהה הענן (cloud ID) של האתר שלכם:

```bash
curl https://your-company.atlassian.net/_edge/tenant_info
# {"cloudId":"56d7178f-…"}

JIRA=https://api.atlassian.com/ex/jira/56d7178f-…
```

4. בדקו שזה עובד:

```bash
curl -u "$EMAIL:$TOKEN" "$JIRA/rest/api/3/myself"
# {"accountId":"712020…","displayName":"Ticket Bot","active":true, …}
```

טוקן קלאסי (בלי הרשאות) עובד ישירות מול `JIRA=https://your-company.atlassian.net`, אבל הוא יכול לעשות כל מה שהמשתמש יכול, כולל כתיבה. עדיף טוקן עם הרשאות.

## טוקן גישה אישי ב־Jira Data Center

ל־PAT אין הרשאות (scopes): הוא יכול לעשות כל מה שהמשתמש שלו יכול. לכן הגבילו לקריאה בלבד את **המשתמש** עצמו:

1. צרו משתמש ייעודי, למשל `ticket-bot`.
2. בסכמות ההרשאות (permission schemes) של הפרויקטים, תנו לו רק את **Browse Projects**. בלי Create, Edit, Comment או Transition. הוסיפו את ההרשאה הגלובלית **Browse users and groups**, כדי שחיפוש אנשים יעבוד.
3. התחברו בתור המשתמש הזה ועברו אל Profile → **Personal Access Tokens** → **Create token**, עם תאריך תפוגה.

```bash
JIRA=https://jira.your-company.internal
curl -H "Authorization: Bearer $PAT" "$JIRA/rest/api/2/myself"
# {"name":"ticket-bot","displayName":"Ticket Bot","active":true, …}
```

## שני מנעולים, לא אחד

גם כשפרטי הגישה הם לקריאה בלבד, הגבילו גם את הקוד לקריאה בלבד, כדי שבאג או פרומפט שעבר מניפולציה לא יוכלו להגיע ל־endpoint של כתיבה:

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

חשפו רק את `jiraGet()` ופונקציית חיפוש אחת, בלי מתודה כללית של «שליחת בקשה». ההגדרה `redirect: "error"` מונעת מפרטי הגישה להישלח הלאה בעקבות הפניה (redirect) למקום אחר.

## שמירה על הטוקן

- אחסנו אותו במנהל הסודות (secret manager) שלכם — Vault, AWS Secrets Manager, Azure Key Vault, GCP Secret Manager — ורק בצד השרת.
- לעולם אל תשלחו אותו לדפדפן, ולעולם אל תכניסו אותו לפרומפט של המודל.
- הסירו אותו מהודעות שגיאה ומהלוגים.
- הגדירו לו תאריך תפוגה והחליפו אותו (rotation) לפי לוח זמנים קבוע.

## כשקריאה נכשלת

| סטטוס | בדרך כלל פירושו |
| --- | --- |
| 401 | אימייל או טוקן שגויים, או טוקן עם הרשאות שנשלח לכתובת האתר במקום ל־gateway |
| 403 | חסרה הרשאה (scope) או הרשאה בפרויקט |
| 404 | הפריט לא קיים, **או** שהוא לא גלוי למשתמש הזה. Jira לא מציין איזו משתי האפשרויות. |
| 429 | הגבלת קצב (rate limited). המתינו לפני ניסיון חוזר לפי הכותרת `Retry-After`. |

הבא: [2 · קריאה מ־Jira ←](02-reading-jira.he.md)
