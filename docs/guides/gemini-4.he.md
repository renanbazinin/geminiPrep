# הוספת Gemini 4 (מתג ה־Pro)

Google הוציאה את **Gemini 4 Argon** (`gemini-4-argon`) לזמינות כללית (GA) ב־2026-10-13. זהו מודל ההסקה
המוביל של Google. המדריך מסביר את מתג **Gemini 4** שמעביר את הצ׳אט למודל הזה, מה משתנה ב־API לעומת
Gemini 3.x, ואיך הוא נוסף ונבדק.

## שימוש

- **בצ׳אט:** המתג **Gemini 4 · Pro** בסרגל העליון. כשהוא דולק, כל תור חדש משתמש ב־`gemini-4-argon`. כשהוא
  כבוי, הצ׳אט חוזר למודל שנבחר בהגדרות. המתג אף פעם לא דורס את הבחירה הזו.
- **הגדרות ← Model configuration:** אותה הגדרה מופיעה כ־**Use Gemini 4 (Pro model)**. כשהיא דולקת, תפריט
  המודלים נעול, והפקדים ש־Gemini 4 מתעלם מהם מושבתים עם הסבר.
- הבחירה נשמרת בדפדפן ונשארת אחרי טעינה מחדש.
- המתג עובד עם שני הספקים (Gemini Developer API ו־Vertex AI) ועם שני מצבי ה־API (Interactions ו־Generate
  Content).
- החלפת מודל פותחת שיחה שמורה חדשה מההיסטוריה המקומית, כמו בכל החלפת מודל אחרת. מכאן כל מודל ממשיך
  בשרשרת משלו.
- אם השרת לא מציע את המודל, המתג מושבת, ו״דולק״ שנשמר קודם נכבה מעצמו.

## אותו דבר או מסובך יותר?

**בצ׳אט רגיל זה אותו API, עם פחות הגדרות.** מבנה הבקשה, אירועי הסטרימינג, `previous_interaction_id` והכלים
נשארים כמו שהיו. Gemini 4 מוריד הגדרות ולא מוסיף:

| תחום | Gemini 3.x | Gemini 4 | מה האפליקציה עושה |
| --- | --- | --- | --- |
| דגימה | `temperature`, `top_p` מכובדים | מתעלם מהם | לא שולחת אותם; הסליידרים מושבתים |
| רמות חשיבה | `minimal`, `low`, `medium`, `high` | `low`, `medium` (ברירת מחדל), `high`; `minimal` מחזיר HTTP 400 | שולחת `minimal` כ־`low`; האפשרות מושבתת |
| תקציב פלט | החשיבה חולקת את `max_output_tokens` | אותו דבר, אבל חושב יותר | מעלה את הגבול ל־32,768 לפחות (ערך גבוה יותר נשמר) |
| מטמון מפורש (`cachedContents`) | נתמך | לא נתמך; רק מטמון משתמע | דוחה `cachedContent` לפני פנייה ל־Google |
| מיקומים ב־Vertex | הרבה אזורים בודדים | רק `global`, `us`, `eu` | דוחה אזורים אחרים לפני פנייה ל־Google, עם הודעה ברורה |
| שכבה חינמית | זמינה | שכבה בתשלום בלבד | השגיאה של Google מוצגת כמו שהיא |

**long decode הוא היכולת היחידה שבאמת מסובכת יותר.** מדובר בתשובות ארוכות מ־64K טוקנים בערך, עד 1,048,576,
ושני הספקים מממשים את זה אחרת:

- **Gemini Developer API:** ‏Interactions עם `background: true`, ואז שליפת התוצאה במקום סטרימינג, וחיבור
  הטקסט מכמה צעדי `model_output`.
- **Vertex AI:** רק Generate Content ב־endpoint ‏`v1beta1` תומך בזה, ו־Vertex Interactions לא. הלקוח שולח
  שוב ושוב את הבקשה עם `continuation_token` עד `finish_reason=STOP`. לכל בקשה יש מגבלה של 20 דקות.

האפליקציה לא מממשת long decode. מגבלת הפלט שלה נשארת 65,536 טוקנים.

## איפה זה רץ

| ספק | Endpoint | הערות |
| --- | --- | --- |
| Gemini Developer API | גלובלי | נדרש מפתח API בתשלום |
| Vertex · Interactions | `global` | האפליקציה תמיד משתמשת ב־global עבור Interactions |
| Vertex · Generate Content | `global`, ‏`us` (`aiplatform.us.rep…`), ‏`eu` (`aiplatform.eu.rep…`) | אזורים בודדים כמו `europe-west1` לא נתמכים |

**עיבוד נתונים באירופה:** לפי Google, עיבוד ה־ML של Gemini 4 מתבצע רק במולטי־אזורים `us` ו־`eu`, לא
ב־`global`. כדי שהעיבוד יישאר באירופה, משתמשים ב־**Vertex · Generate Content** עם **EU multi-region**.
Interactions באפליקציה הזו תמיד רץ על `global`.

**תמחור** (Gemini Developer API, לכל מיליון טוקנים): ‏$2 לקלט ו־$10 לפלט, כולל חשיבה, עד 2026-11-30.
מ־2026-12-01 המחיר הוא ‏$4 / ‏$20. קלט מהמטמון עולה ‏$0.10, ואחר כך ‏$0.20.

## איך זה נוסף

1. **מודול כללים משותף אחד**, [`shared/gemini-4.ts`](../../shared/gemini-4.ts). הוא מחזיק את המודל
   (`PRO_MODEL`), את התווית, את אזורי Vertex המותרים, את תקציב הפלט המינימלי ועוזרים קטנים. ‏`isGemini4Model()`
   מתאים לקידומת `gemini-4`, כך שגרסאות עתידיות של Gemini 4 יקבלו את אותם כללים.
2. **קטלוג**, [`server/catalog.ts`](../../server/catalog.ts). מודל ה־Pro מתווסף לסוף שתי רשימות מודלי הצ׳אט,
   גם כש־`GEMINI_CHAT_MODELS` או `VERTEX_CHAT_MODELS` מצמצמים אותן, כך שהמתג תמיד עובד. המיקום בסוף מונע ממנו
   להפוך לברירת המחדל בהגדרות חדשות. הוא מצטרף גם למעבדת האזורים.
3. **ולידציה**, [`server/chat/validation.ts`](../../server/chat/validation.ts). דוחה אזור Vertex לא נתמך
   ומטמון מפורש לפני כל פנייה ל־Google.
4. **בוני הבקשות**, [`server/chat/interactions.ts`](../../server/chat/interactions.ts)
   ו־[`server/chat/upstream.ts`](../../server/chat/upstream.ts). עבור Gemini 4 הם משמיטים דגימה, ממפים
   `minimal` ל־`low`, ומעלים גבול פלט קטן. העברה למודל התמונה עדיין משתמשת במודל התמונה עם ההגדרות שלו.
5. **דפדפן.** הגדרת `proModel` ([`src/lib/storage.ts`](../../src/lib/storage.ts)) והמתג
   ([`src/components/ProModelToggle.tsx`](../../src/components/ProModelToggle.tsx)). ‏`chatModelFor()` בוחר את
   המודל לכל תור ולהתאמת שרשרת השיחה.

כדי להעביר את המתג למודל Pro עתידי, משנים את `PRO_MODEL` ואת `PRO_MODEL_LABEL`, ואז עוברים על הכללים
באותו קובץ.

## באג שנמצא בבדיקות

ההרצה החיה הראשונה נכשלה ב**המשך שיחה ב־Vertex Interactions שנשלח מיד אחרי התור הראשון**. Google ענתה
*״Previous interaction … is in an invalid state (current state: IN_PROGRESS)״*. הסיבה הייתה באפליקציה, לא
ב־Gemini 4. הפרוקסי ביטל את הסטרים של Google ברגע שראה `interaction.completed`, ו־Vertex מסיים לשמור את התור
רק כשהסטרים שלו נסגר כרגיל:

| איך הסטרים הראשון הסתיים | המשך מיידי (3.8 Flash ו־Gemini 4) |
| --- | --- |
| בוטל ב־`interaction.completed` (הקוד הישן) | נכשל ב־6 מתוך 6 |
| נקרא עד הסוף הטבעי שלו | הצליח ב־3 מתוך 3 |

הפרוקסי קורא עכשיו את הסטרים עד הסוף ומתעלם מכל מה שמגיע אחרי הסיום. בדיקת רגרסיה מכסה את זה. בדפדפן,
מי שמקליד מהר או שולח הודעה שנייה מהר יכול היה להיתקל בבאג הישן עם כל מודל.

## אימות

בדיקות אוטומטיות, עם תגובות Google מדומות ובלי לצרוך מכסה:

- [`server/chat/gemini-4.test.ts`](../../server/chat/gemini-4.test.ts) מריץ כל מסלול בקשה של הצ׳אט: ‏Gemini
  API עם Interactions v1 ו־v1beta ועם Generate Content, ואז Vertex עם Interactions ועם Generate Content
  ב־`global`, ‏`eu` ו־`us`. בכל מסלול נבדקים ה־URL, המודל, השמטת הדגימה, תקציב הפלט, הטקסט שמגיע בסטרים,
  ושאין דליפת פרטי גישה. בדיקות נוספות מכסות המשך שיחה שמורה, העברה למודל תמונה, מיפוי רמות חשיבה, אזורים
  ומטמונים שנדחים, שגיאות של שכבה חינמית, ושמודלים אחרים לא השתנו.
- [`src/components/ProModelToggle.test.tsx`](../../src/components/ProModelToggle.test.tsx) מכסה את המתג בצ׳אט
  ובהגדרות: מעבר הלוך ושוב, שרשראות שיחה נפרדות, טעינה מחדש, שרת בלי המודל, אזהרות אזור, פקדים מושבתים
  והגדרות ישנות שמורות.
- [`server/chat/vertex-interactions.test.ts`](../../server/chat/vertex-interactions.test.ts) מחזיק את בדיקת
  הרגרסיה של קריאת הסטרים עד הסוף.

בדיקה חיה שולחת בקשות אמיתיות בתשלום (כמה מילים בכל אחת, חשיבה נמוכה) דרך ה־`/api/chat/stream` של
האפליקציה עצמה:

```bash
npm run check:gemini-4
```

מוסיפים `-- gemini` או `-- vertex` כדי לבדוק ספק אחד. תוצאות מ־2026-10-13, כולן עברו:

| מסלול | תוצאה |
| --- | --- |
| Gemini API · Interactions v1, שיחה חדשה והמשך | עבר; ההמשך זכר את התור הראשון |
| Gemini API · Interactions v1beta עם חשיבה `minimal` ו־Top P | עבר, נשלח כ־`low` ובלי Top P |
| Gemini API · Interactions v1 עם JSON schema | עבר, `{"sum": 5}` |
| Gemini API · Generate Content | עבר |
| Vertex · Interactions (global), שיחה חדשה והמשך | עבר אחרי תיקון קריאת הסטרים |
| Vertex · Generate Content ב־`global`, ‏`eu`, ‏`us` | עבר |
| Vertex · Generate Content ב־`europe-west1` | נדחה מקומית, כמתוכנן |

בבדיקה ידנית בדפדפן, עם המתג דלוק, התקבלה התשובה *״I am Gemini 4 Argon … 17 multiplied by 23 is 391״*.
הבקשה לספק כללה `max_output_tokens: 32768` ובלי temperature.

## מה עוד לא מכוסה

- long decode (פלט מעל 64K טוקנים), כמתואר למעלה
- ‏Gemini 4 Argon Cyber Permissive (`gemini-4-argon-cyber-permissive`), שזמין רק ברשימת היתרים
- שימוש במחשב (computer use, ב־preview ב־Gemini 4) ו־Live API (לא נתמך)

## מקורות רשמיים (נבדקו ב־2026-10-13)

- [עמוד המודל Gemini 4 Argon](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon)
- [מה חדש ומעבר (latest model)](https://ai.google.dev/gemini-api/docs/latest-model)
- [יומן השינויים של Gemini API](https://ai.google.dev/gemini-api/docs/changelog)
- [מדריך המפתחים של Vertex ל־Gemini 4 Argon](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-argon)
- [מפרט המודל Gemini 4 Argon ב־Vertex](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/4-argon)
- [תחילת עבודה עם Gemini 4 ב־Vertex](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/get-started-with-gemini-4)
