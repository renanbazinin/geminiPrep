# Generate Content: ה־API חסר המצב של Gemini (לפני Interactions)

לפני Interactions API, כל צ׳אטבוט Gemini נבנה על **Generate Content**: ‏`generateContent` לתשובה שלמה אחת,
ו־`streamGenerateContent` לתשובה בסטרימינג. זה עדיין ה־API הנפוץ ביותר של Gemini. ‏Google אומרת שהוא
״remains fully supported״, וממליצה על Interactions לפיתוח חדש.

המדריך מסביר איך Generate Content עובד, את הפרטים שבהם נופלים, ומתי הוא עדיין הבחירה הנכונה. הוא כללי ומתאים
לכל צ׳אטבוט Gemini. סעיף קצר בסוף מראה איך המאגר הזה משתמש בו.

הרעיון המרכזי: **השרת לא זוכר כלום.** כל בקשה נושאת את כל השיחה, וההיסטוריה שייכת לאפליקציה שלכם.

---

## 1. Endpoints ואימות

| ספק | URL | אימות |
| --- | --- | --- |
| Gemini Developer API | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | `x-goog-api-key: <key>` |
| Vertex AI, גלובלי | `https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/publishers/google/models/{model}:generateContent` | `Authorization: Bearer <ADC token>` |
| Vertex AI, מולטי־אזור | `https://aiplatform.{eu\|us}.rep.googleapis.com/v1/projects/{project}/locations/{eu\|us}/…` | אותו דבר |
| Vertex AI, אזור בודד | `https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/…` | אותו דבר |

לסטרימינג מחליפים את `:generateContent` ב־`:streamGenerateContent?alt=sse`. התשובה מגיעה אז כ־server-sent
events, וכל שורת `data:` היא אובייקט תשובה שלם עם החלק הבא.

ל־Generate Content תמיד היו endpoints אזוריים ומולטי־אזוריים ב־Vertex. זה עדיין אחד היתרונות המעשיים שלו.
ראו §10.

---

## 2. בקשה

```json
{
  "contents": [
    { "role": "user",  "parts": [{ "text": "Hi, my name is Dana." }] },
    { "role": "model", "parts": [{ "text": "Hi Dana, how can I help?" }] },
    { "role": "user",  "parts": [{ "text": "What is my name?" }] }
  ],
  "systemInstruction": { "parts": [{ "text": "Answer in one sentence." }] },
  "tools": [{ "functionDeclarations": [ /* … */ ] }],
  "toolConfig": { "functionCallingConfig": { "mode": "AUTO" } },
  "generationConfig": {
    "maxOutputTokens": 8192,
    "temperature": 1,
    "thinkingConfig": { "thinkingLevel": "low" }
  }
}
```

| שדה | משמעות |
| --- | --- |
| `contents[]` | השיחה, מהישן לחדש. ‏`role` הוא `user` או `model`; הרשומה האחרונה היא בדרך כלל `user` |
| `parts[]` | ‏`text`, ‏`inlineData` (‏`mimeType` ו־`data` ב־base64), ‏`fileData` (URI של קובץ שהועלה), ‏`functionCall`, ‏`functionResponse` |
| `systemInstruction` | התנהגות ותפקיד. נשלח ב**כל** בקשה, כי שום דבר לא נשמר |
| `tools`, `toolConfig` | הפונקציות שלכם (`functionDeclarations`) או כלים מובנים (`googleSearch`, ‏`urlContext`, ‏`codeExecution`); מצב `AUTO`, ‏`ANY`, ‏`NONE` או `VALIDATED` |
| `generationConfig` | ‏`maxOutputTokens`, ‏`temperature`, ‏`topP`, ‏`topK`, ‏`stopSequences`, ‏`seed`, ‏`responseMimeType`, ‏`responseSchema`, ‏`responseModalities`, ‏`thinkingConfig`, … |
| `safetySettings[]` | ספי חסימה לפי קטגוריה |
| `cachedContent` | שם של מטמון מפורש שמצורף לפני השיחה (ראו §4) |

שמות השדות ב־camelCase. ב־Interactions הם ב־snake_case (`generation_config`).

---

## 3. תשובה

```json
{
  "candidates": [{
    "content": { "role": "model", "parts": [{ "text": "Your name is Dana.", "thoughtSignature": "…" }] },
    "finishReason": "STOP"
  }],
  "usageMetadata": {
    "promptTokenCount": 41, "candidatesTokenCount": 6, "thoughtsTokenCount": 120,
    "cachedContentTokenCount": 0, "totalTokenCount": 167
  },
  "responseId": "…",
  "modelVersion": "gemini-3.8-flash"
}
```

- **הטקסט** נמצא ב־`candidates[0].content.parts[*].text`. בסטרימינג משרשרים את הטקסט של כל מקטע. מדלגים על
  חלקים עם `"thought": true`, שמופיעים רק אם מבקשים סיכומי חשיבה עם `thinkingConfig.includeThoughts`.
- **`finishReason`** אומר למה התשובה נעצרה. הערכים הנפוצים הם `STOP`, ‏`MAX_TOKENS`, ‏`SAFETY`, ‏`RECITATION`,
  ‏`MALFORMED_FUNCTION_CALL`, ‏`MISSING_THOUGHT_SIGNATURE` ו־`CONTINUATION` (ראו §8). לפרומפט שנחסם אין
  candidates, ובמקומם יש `promptFeedback.blockReason`.
- **`usageMetadata`** הוא החשבון. ‏`thoughtsTokenCount` מחויב כפלט ונספר מתוך `maxOutputTokens`.
  ‏`cachedContentTokenCount` מראה טוקנים שהגיעו ממטמון, משתמע או מפורש.
- **קריאה לפונקציה** בסטרימינג מגיעה שלמה במקטע אחד.

---

## 4. הזיכרון באחריותכם

בכל תור הלקוח מוסיף את ההודעה החדשה של המשתמש, שולח **הכול**, ואז מוסיף את תשובת המודל להיסטוריה שלו.

```text
turn 1:  [u1]                   → m1
turn 2:  [u1, m1, u2]           → m2
turn 3:  [u1, m1, u2, m2, u3]   → m3
```

מה נובע מזה:

- **העלות וזמן התגובה גדלים בכל תור**, כי טוקני הקלט הם כל ההיסטוריה. בשיחה ארוכה ההודעות הראשונות נשלחות
  שוב ושוב.
- **מטמון משתמע** מקל על זה: ‏Google נותנת אוטומטית הנחה על תחילית חוזרת של הפרומפט. שומרים חומר קבוע (הוראת
  מערכת, קבצים) בהתחלה ומוסיפים תורים חדשים בסוף, כדי שהתחילית תישאר זהה.
- **מטמון מפורש** (`cachedContents`) שומר חומר סטטי גדול, כמו מדריכים או חוזים, פעם אחת עם TTL. אחר כך שולחים
  `cachedContent` ורק את התורים החדשים. האחסון מחויב כל עוד המטמון חי, ומטמון קשור למודל ולמיקום אחד. חלק
  מהמודלים החדשים לא תומכים בו בכלל; ‏Gemini 4 הוא אחד מהם.
- **גבולות ההיסטוריה שלכם.** כשהשיחה גדלה מעבר לחלון ההקשר, אתם מחליטים אם לקצץ, לסכם או לסרב. ה־API לא יעשה
  את זה בשבילכם.
- **הפרטיות פשוטה:** מלבד מטמון משתמע ומדיניות הלוגים, ‏Google לא שומרת מצב שיחה. מחיקת הצ׳אט מקומית באמת
  מוחקת אותו.

---

## 5. חשיבה

‏Gemini 2.5 ומעלה חושבים לפני שהם עונים. אתם קובעים כמה:

| שדה | מודלים | הערות |
| --- | --- | --- |
| `thinkingConfig.thinkingLevel` | ‏Gemini 3.x ו־4 | ‏`minimal` / ‏`low` / ‏`medium` / ‏`high`. הערכים הנתמכים משתנים לפי מודל, ו־Gemini 4 דוחה `minimal` |
| `thinkingConfig.thinkingBudget` | ‏Gemini 2.5 | תקציב בטוקנים. ‏Gemini 4 דוחה אותו עם HTTP 400 |
| `thinkingConfig.includeThoughts` | כל מודלי החשיבה | מחזיר *סיכומי* חשיבה כחלקים עם `thought: true` |

החשיבה חולקת את `maxOutputTokens` עם התשובה. אם תשובה נעצרת עם `MAX_TOKENS` אחרי מעט מאוד מילים גלויות, החשיבה
גמרה את התקציב. מעלים את `maxOutputTokens` או מורידים את רמת החשיבה.

---

## 6. Thought signatures: המלכודת הכי גדולה

מודלי חשיבה מצמידים **`thoughtSignature`** מוצפן לחלקים בתשובה. הוא מעביר את מצב ההסקה של המודל לבקשה הבאה,
וזה חשוב כי Generate Content עצמו לא שומר מצב.

| כלל | פירוט |
| --- | --- |
| איפה הוא מופיע | על חלק ה־`functionCall` הראשון בתשובה, או על החלק האחרון בתשובה בלי קריאות לפונקציות |
| קריאה לפונקציה, ‏Gemini 3 ו־4 | **חובה.** מחזירים את החלק עם החתימה בלי שינוי. בלעדיו מתקבלת שגיאת ולידציה 400 |
| קריאות רציפות | כל צעד בתור הנוכחי צריך את החתימה שלו בחזרה. תור מתחיל בהודעת המשתמש האחרונה שאינה `functionResponse` |
| קריאות מקבילות | רק לקריאה הראשונה יש חתימה. שולחים את כל הקריאות בסדר המקורי ואחריהן את כל התשובות; שילוב ביניהן נותן 400 |
| תורי טקסט רגילים | מומלץ להחזיר, אבל לא נאכף |
| ‏Gemini 2.5 | אופציונלי |

כלל מעשי: **שומרים אובייקטי `Part` שלמים מהמודל, לא רק את הטקסט או את ארגומנטי הפונקציה.** ה־SDKs הרשמיים
עושים את זה אוטומטית כשמוסיפים את התשובה המלאה להיסטוריית הצ׳אט. לקוחות REST שנבנו ביד הם אלה שנשברים.
‏Interactions פותר את הבעיה: במצב stateful השרת שומר את החתימות.

---

## 7. סבב קריאה לפונקציה

```text
1. request:  contents + tools (functionDeclarations), mode AUTO
2. response: parts: [{ functionCall: { name, args }, thoughtSignature }]
3. you run the function
4. request:  contents + the model's functionCall part (unchanged) +
             { role: "user", parts: [{ functionResponse: { name, response: { … } } }] }
5. response: the final text answer (or another call)
```

כל סבב שולח שוב את כל ההיסטוריה, כולל הגדרות הכלים. כלים מובנים כמו `googleSearch`, ‏`urlContext` ו־`codeExecution`
רצים אצל Google ולא צריכים את שלב 3. תוצאות החיפוש חוזרות ב־`groundingMetadata`.

**פלט מובנה** לא צריך כלים. מגדירים `responseMimeType: "application/json"` ו־`responseSchema` (או
`responseJsonSchema`) בתוך `generationConfig`.

---

## 8. תשובות ארוכות מאוד (long decode ב־Gemini 4)

בקשה אחת מייצרת עד 65,536 טוקנים של פלט וחשיבה. ‏Gemini 4 יכול להמשיך, עד כמיליון טוקנים, דרך **continuation**:

1. התשובה נעצרת עם `finishReason: "CONTINUATION"` ו־`continuationToken`.
2. שולחים שוב את אותה בקשה (contents, הוראת מערכת וכלים) יחד עם ה־`continuationToken`.
3. חוזרים עד ש־`finishReason` הוא `STOP`, ומחברים את הטקסט. ‏`maxOutputTokens` מצטבר לאורך הלולאה.

ב־Vertex זה עובד רק ב־endpoint ‏`v1beta1`, ולכל בקשה יש מגבלה של 20 דקות. ה־Google Gen AI SDK מריץ את הלולאה
בשבילכם (`automatic_continuation`).

---

## 9. ‏Generate Content מול Interactions

| | Generate Content | Interactions |
| --- | --- | --- |
| מצב | אין. שולחים את ההיסטוריה בכל תור | נשמר אצל Google; שולחים `previous_interaction_id` ואת הקלט החדש |
| קלט | `contents[]` עם `role` ו־`parts` | `input` (טקסט, או צעדים מוגדרים) |
| פלט | `candidates[].content.parts` | ציר זמן של `steps` (`model_output`, ‏`thought`, ‏`function_call`, …) |
| סטרימינג | `:streamGenerateContent?alt=sse`, כל מקטע הוא תשובה שלמה | `"stream": true`, אירועים מוגדרים (`step.start`, ‏`step.delta`, ‏`interaction.completed`) |
| הגדרות | `generationConfig` (camelCase) | `generation_config` (snake_case), נשלח מחדש בכל תור |
| תוצאות פונקציה | חלק `functionResponse` | קלט `function_result` עם `call_id` |
| חיפוש | `googleSearch`, ציטוטים ב־`groundingMetadata` | `google_search`, צעדי חיפוש, ‏`annotations` בתוך הטקסט |
| פלט JSON | `responseMimeType` + `responseSchema` | `response_format` ברמה העליונה |
| Thought signatures | אתם מחזירים אותן | השרת שומר אותן (מצב stateful) |
| שמירה | שום דבר לא נשמר | אינטראקציות שמורות פגות (למשל אחרי 7 ימים ב־Vertex preview); אפשר לכבות עם `store: false` |

---

## 10. מתי Generate Content עדיין הבחירה הנכונה

- **אסור לכם לשמור שיחות אצל Google.** רגולציה, מדיניות שמירת מידע או חוזים עם לקוחות.
- **צריך אזור מסוים.** ב־Vertex יש ל־Generate Content endpoints אזוריים ומולטי־אזוריים. לעיבוד באירופה בלבד
  משתמשים במולטי־אזור `eu`.
- **חומר סטטי גדול שמשמש הרבה שיחות.** מטמון מפורש עובד עם Generate Content.
- **כבר יש לכם לוגיקת היסטוריה.** למשל מסד נתונים משלכם של תורים, סיכום שיחה או לקוח בסגנון OpenAI.
- **תשובה ארוכה מאוד אחת ב־Vertex.** ‏long decode שם קיים רק ב־Generate Content.

בוחרים ב־**Interactions** כשרוצים ש־Google תחזיק את המצב: בקשות המשך קטנות יותר, חתימות שמטופלות בשבילכם וסוכני
רקע. זו הסיבה ש־Google ממליצה עליו לפרויקטים חדשים.

---

## 11. במאגר הזה

- **הגדרות ← Conversation API ← Generate Content** הוא מצב ה״legacy״, לכל ספק בנפרד. ‏Vertex מתחיל במצב הזה,
  ו־Gemini API מתחיל ב־Interactions.
- [`server/chat/upstream.ts`](../../server/chat/upstream.ts) בונה את גוף הבקשה ואת כתובות ה־endpoint שלמעלה.
  הוא מפענח את סטרים ה־SSE, מסתיר חלקי `thought` ואוסף קריאות לפונקציות.
- [`server/chat/stream.ts`](../../server/chat/stream.ts) מריץ **ניתוב כלים אוטומטי**. מודל הצ׳אט מקבל
  `functionDeclarations` במצב `AUTO`. אם הוא קורא ל־`generate_image` או ל־`generate_graph`, השרת מבצע קריאה שנייה
  למומחה על אותו סטרים. הוא אף פעם לא שולח `functionResponse` בחזרה, ולכן כללי החתימות של קריאה לפונקציה לא חלים.
  ראו [auto-tool-routing.he.md](auto-tool-routing.he.md).
- הדפדפן שולח את **כל ההיסטוריה המקומית** בכל תור, ושומר רק טקסט וקבצים, בלי חתימות. זה בסדר לתורי טקסט רגילים,
  שבהם חתימות הן אופציונליות.
- בורר **האזור** של Vertex חל רק במצב הזה. ‏Interactions תמיד משתמש ב־`global`.
- [מעבדת המטמון](../tests/cache.he.md) ו[מדריך המטמון](context-caching.he.md) עוסקים במטמון מפורש, ששייך ל־API
  הזה.
- ‏Gemini 4 עובד גם במצב הזה. ראו [gemini-4.he.md](gemini-4.he.md).

## מעבר מבוט Generate Content ל־Interactions

1. מחליפים את `contents` ב־`input`, ובהמשכים שולחים רק את הקלט החדש יחד עם `previous_interaction_id`.
2. משנים את `generationConfig` ל־`generation_config` (snake_case), ושולחים אותו, את `system_instruction` ואת
   `tools` מחדש בכל תור. הם לא עוברים בירושה.
3. קוראים `steps` במקום `candidates`. הטקסט נמצא בצעדי `model_output`.
4. ממפים תוצאות פונקציה ל־`function_result` עם `call_id`.
5. מחליטים על שמירה: ‏`store: true` (stateful), או `store: false` וממשיכים לשלוח היסטוריה בעצמכם.
6. שומרים את התמליל המקומי. אינטראקציות שמורות פגות, ותרצו לבנות מחדש מההיסטוריה המקומית (מצב ה־Interactions
   במאגר הזה עושה בדיוק את זה).

## מקורות רשמיים (נבדקו ב־2026-10-13)

- [מפרט Generate Content API](https://ai.google.dev/api/generate-content)
- [מעבר ל־Interactions API](https://ai.google.dev/gemini-api/docs/migrate-to-interactions)
- [Thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)
- [חשיבה](https://ai.google.dev/gemini-api/docs/thinking)
- [Thought signatures ב־Vertex](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking/thought-signatures)
