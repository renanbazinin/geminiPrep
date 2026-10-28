# מעבר מ־generateContent ל־Interactions: מלכודות נפוצות

המדריך מיועד לכל אפליקציית Gemini שעוברת מ־**generateContent** (חסר מצב: שולחים את כל השיחה בכל
בקשה) ל־**Interactions API** (עם מצב: ‏Google שומרת את השיחה, ומשרשרים תורות עם `previous_interaction_id`).
הוא כללי ולא קשור למאגר הזה.

המדריך עוסק בשלושה דברים:

- המיפוי שדה אחר שדה, עם עמודה שאומרת מה לשנות;
- הטעויות בכלים ובקריאות לפונקציות ששוברות מעבר או מוסיפות סבבים;
- הסיבות שאפליקציה איטית יותר מאותן קריאות שנשלחות ידנית מ־Postman.

כל מה שמסומן כ״נבדק״ נבדק בקריאות אמיתיות ב־2026-10-28 עם `gemini-3.8-flash`, גם ב־Gemini Developer
API ‏(`v1`) וגם ב־Vertex AI ‏(`v1beta1`, ‏`locations/global`). ראו [§8](#8-איך-זה-נבדק).

---

## 1. המיפוי: מה משתנה

| מה | generateContent | Interactions | מה לשנות |
| --- | --- | --- | --- |
| Endpoint | `POST …/models/{model}:generateContent`, או `:streamGenerateContent?alt=sse` | `POST …/interactions` (ב־Developer API ‏`v1`; ב־Vertex ‏`v1beta1` ב־`locations/global`) | URL חדש. המודל עובר לגוף הבקשה כ־`model`. סטרימינג הופך ל־`stream: true` |
| השיחה | כל ההיסטוריה ב־`contents`, בכל בקשה | `previous_interaction_id` ורק הקלט החדש | כשמשרשרים, מפסיקים לשלוח את ההיסטוריה |
| קלט | `contents: [{ role, parts: [{ text }] }]` | `input: "text"`, או `input: [{ type: "user_input", content: [{ type: "text", text }] }]` | התפקידים הופכים לצעדים עם סוג (`user_input`, ‏`model_output`) |
| הנחיית מערכת | `systemInstruction: { parts: [{ text }] }` | `system_instruction: "…"` | מחרוזת פשוטה. **שולחים אותה בכל בקשה** |
| הגדרות | `generationConfig: { thinkingConfig: { thinkingLevel }, stopSequences, maxOutputTokens }` | `generation_config: { thinking_level, stop_sequences, max_output_tokens }` | snake_case, ורמת החשיבה שטוחה. **שולחים אותן בכל בקשה** |
| פלט JSON | `generationConfig: { responseMimeType, responseSchema }` | `response_format: { type: "text", mime_type: "application/json", schema }` ברמה העליונה | מוציאים מההגדרות. השדה הישן מתקופת ה־beta, ‏`response_mime_type`, נדחה ב־`v1` |
| הפונקציות שלכם | `tools: [{ functionDeclarations: [{ name, description, parameters }] }]` | `tools: [{ type: "function", name, description, parameters }]` | רשומה שטוחה אחת לכל פונקציה, כל אחת עם `type: "function"`. ‏`parameters` הוא JSON Schema רגיל עם סוגים באותיות קטנות (`OBJECT`/`STRING` באותיות גדולות עדיין התקבלו בבדיקה). **שולחים אותן בכל בקשה**: ה־Developer API מוחק אותן בין תורות, ואילו Vertex ‏`v1beta1` העביר אותן הלאה בבדיקה, אז לא סומכים על אף אחד מהם |
| כלים מובנים | `{ googleSearch: {} }`, `{ urlContext: {} }`, `{ codeExecution: {} }` | `{ type: "google_search" }`, `{ type: "url_context" }`, `{ type: "code_execution" }` | משנים את השמות |
| מצב קריאה | `toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames } }` | `generation_config: { tool_choice: "any" }`, או `tool_choice: { allowed_tools: { mode: "any", tools: ["name"] } }` | מעבירים לתוך `generation_config`. הערכים באותיות קטנות: `auto`, ‏`any`, ‏`none`, ‏`validated` |
| קריאה ממתינה | `finishReason: "STOP"` וחלק `functionCall` | `status: "requires_action"` | מסתעפים לפי `status`, לא לפי ״יש טקסט או אין״ |
| הקריאה | חלק `functionCall: { name, args, id }`, עם `thoughtSignature` על אותו חלק | צעד `{ type: "function_call", id, name, arguments }`, אחרי צעד `thought` שמחזיק את החתימה | קוראים את `steps`. ‏`args` נקרא עכשיו `arguments` |
| שליחת התוצאה | כל ההיסטוריה, התוכן של המודל, ואז `{ role: "user", parts: [{ functionResponse: { name, id, response } }] }` | `previous_interaction_id` ועוד `input: [{ type: "function_result", call_id, name, result }]` | שולחים רק את התוצאה. ‏`call_id` הוא ה־`id` של הקריאה |
| ערך התוצאה | `response` הוא אובייקט | `result` מקבל אובייקט או רשימת חלקי תוכן. מחרוזת רגילה הגיעה למודל ב־Developer API, אבל Vertex קיבל אותה ואז איבד אותה | שולחים אובייקט או `[{ type: "text", text }]`, אף פעם לא מחרוזת לבד |
| כמה קריאות בבת אחת | כמה חלקי `functionCall` | כמה צעדי `function_call` | מחזירים את כל התוצאות בבקשה אחת |
| חתימות מחשבה | חובה להחזיר אותן. השמטה נותנת 400 ברור | עם מצב: ‏Google שומרת אותן. עם `store: false`: מחזירים כל צעד שהתקבל, בלי שינוי | עדיף לעבוד עם מצב, ואז אין מה לעשות |
| קריאה בסטרימינג | חלק ה־`functionCall` מגיע שלם | `step.start` נותן `id` ו־`name` (עם `arguments` ריק), ואז `step.delta` מסוג `arguments_delta` נותן את `arguments` **כמחרוזת JSON** | מחברים את המחרוזת ואז מריצים עליה `JSON.parse` |
| סוף הסטרים | הסטרים נגמר | `interaction.completed` (גם כש־`status` הוא `requires_action`), ואז `[DONE]`. באירוע האחרון אין צעדים | בונים את הקריאה מאירועי הצעדים, לא מהאירוע האחרון |
| טקסט התשובה | `response.text`, או `candidates[0].content.parts` | צעדי `model_output` (ב־SDK יש גם `output_text`) | מחברים את הטקסט של כל צעדי `model_output`: ‏`output_text` מדלג על טקסט שמגיע לפני צעד של כלי |
| שימוש בטוקנים | `usageMetadata.promptTokenCount`, `thoughtsTokenCount` | `usage.total_input_tokens`, `usage.total_thought_tokens`; בסטרימינג רק ב־`interaction.completed`. בתור משורשר ה־Developer API סופר ב־`total_input_tokens` רק את הקלט החדש, ואת ההקשר המלא ב־`initial_input_tokens`; ‏Vertex שם את ההקשר המלא ב־`total_input_tokens` | משנים את שמות המדדים, קוראים את הסטרים עד הסוף כדי לקבל אותם, ולא משווים ספירות טוקנים בין ספקים |
| קריאה אוטומטית לפונקציות (Python SDK) | קיימת | עדיין לא קיימת | כותבים בעצמכם את הלולאה: קריאה ← הרצה ← תוצאה |
| שרתי MCP מרוחקים | — | עדיין לא ל־Gemini 3 | קוראים ל־MCP מהקוד שלכם כמו לפונקציות רגילות |

### לולאת הכלים המינימלית

```js
const settings = { model, tools, system_instruction, generation_config }; // on EVERY request
let it = await create({ ...settings, input: userText });
for (let round = 0; it.status === "requires_action" && round < 5; round++) {
  const calls = it.steps.filter((step) => step.type === "function_call");
  const input = await Promise.all(calls.map(async (call) => ({
    type: "function_result", call_id: call.id, name: call.name,
    result: await runTool(call.name, call.arguments),
  })));
  it = await create({ ...settings, previous_interaction_id: it.id, input });
}
```

---

## 2. השגיאות שמקבלים משדות במבנה הישן

| מה נשלח | מה Google עונה (HTTP 400) |
| --- | --- |
| `tools: [{ googleSearch: {} }]` | `The 'type' parameter is required at 'tools[0]'.` |
| `toolConfig` | `Unknown parameter 'toolConfig'.` |
| `tool_choice` ברמה העליונה | `Unknown parameter 'tool_choice'.` |
| קלט מסוג `type: "function_response"` | `The value 'function_response' is not supported for 'type' at 'input[0]'.` |
| `response_mime_type` ב־Developer API ‏`v1` | `The field 'response_mime_type' is only available in v1beta.` (‏Vertex ‏`v1beta1` עדיין מקבל אותו) |
| היסטוריה עם `store: false` בלי צעד ה־`thought` | `Request contains an invalid argument.` (בלי שום רמז) |

---

## 3. מלכודות בכלים

1. **מתייחסים ל־`requires_action` כשגיאה או כסוף.** תור שמבקש פונקציה נגמר ב־`status: "requires_action"`,
   ובסטרימינג אירוע הסיום הוא עדיין `interaction.completed`. קוד שמקבל רק `completed` נכשל בקריאה
   הראשונה לכלי. קוד ששומר את מזהה ה־interaction רק ב־`completed` מאבד את השרשור.
2. **לא שולחים שוב את הכלים, הנחיית המערכת וההגדרות.** לפי התיעוד של Google רק השיחה עוברת בירושה.
   נבדק בשני הספקים:
   - ‏`system_instruction` מהתור הראשון נעלמת בתור הבא;
   - ‏`stop_sequences` מהתור הראשון כבר לא חלים.

   בכלים יש הבדל בין הספקים. ב־Developer API כלי שהוגדר קודם ולא נעשה בו שימוש לא זמין, אלא אם שולחים
   שוב את `tools`. ב־Vertex ‏`v1beta1` הוא נשאר זמין גם בלי לשלוח שוב, ולכן אפליקציה שנבדקה רק על Vertex
   יכולה להישבר כשעוברים ל־Developer API. שולחים את שלושתם בכל בקשה.

   גם ב־Developer API, בקשה בלי `tools` עדיין יכולה להחזיר קריאה לכלי שהמודל ראה קודם בשיחה. טפלו
   בצעדי `function_call` בכל תשובה.
3. **שולחים את ההיסטוריה יחד עם `previous_interaction_id`.** המודל קורא את ההקשר פעמיים. נבדק: הבקשה
   הכפולה נשאה בערך 270 טוקני קלט נוספים בשני הספקים, בדיוק הגודל של ההיסטוריה שנשלחה שוב.
4. **מחזירים רק חלק מהתוצאות של קריאות מקבילות.** בבדיקות המודל עשה אחד משלושה דברים: קרא שוב לכלי
   שחסר (עוד סבב), ענה רק עם התוצאה שהייתה לו, או המציא את הערך החסר. מחזירים את כל התוצאות בבקשה
   אחת, ומריצים את הקריאות במקביל.
5. **מתאימים תוצאות לקריאות לפי סדר או לפי שם.** ‏Google לא בודקת את `call_id`: מזהה שגוי מתקבל בשקט.
   מתאימים לפי `id`, במיוחד כשיש כמה קריאות מקבילות לאותה פונקציה.
6. **מפרשים ארגומנטים מסטרים כאובייקט.** בסטרים `arguments` מגיע כמחרוזת JSON באירועי `arguments_delta`.
   בתשובה בלי סטרימינג הוא אובייקט.
7. **משאירים `tool_choice: "any"` דלוק.** הוא מכריח קריאה אפילו ל״תגיד שלום״. אם הדלקתם אותו לסבב הראשון,
   החזירו ל־`auto` כששולחים את התוצאות.
8. **סומכים על `tool_choice: "none"`.** כשהכלים עדיין מצורפים והפרומפט מבקש להשתמש בכלי, הבקשה נכשלה
   ב־HTTP 400 ‏`malformed_tool_call` (״Model generated invalid JSON syntax…״) ב־2 מתוך 3 ניסיונות בשני
   הספקים: המודל ניסה לקרוא בכל זאת. תפסו את השגיאה ונסו שוב פעם אחת. כדי באמת לכבות כלים ב־Developer API,
   השמיטו אותם מהבקשה.
9. **שולחים תוצאה כמחרוזת לבד.** ב־Vertex הבקשה הצליחה, אבל המודל ענה שהכלי לא החזיר נתונים. שלחו
   אובייקט או רשימת חלקי תוכן.
10. **‏`store: false` בלי להחזיר הכול.** כל צעד שהתקבל צריך לחזור בלי שינוי, כולל צעד ה־`thought`.
    אחרת מקבלים 400 בלי הסבר.
11. **כלים מובנים בכל תור.** ‏`google_search`, ‏`url_context` ו־`code_execution` רצים בצד של Google.
    הם אף פעם לא גורמים ל־`requires_action`, אבל מוסיפים צעדים (למשל `google_search_call`
    ו־`google_search_result`) לפני שהתשובה מתחילה. הדליקו אותם רק בתורות שצריכים אותם.
12. **יותר מדי כלים.** כל הגדרה נשלחת בכל בקשה ועולה טוקנים. רשימה ארוכה גם הופכת את בחירת הכלי לאיטית
    ופחות מדויקת.
13. **כל קריאה לפונקציה היא סבב מלא נוסף, בשני ה־APIs.** ספרו כמה סבבים יש לכל תשובה. פרומפט שאומר
    ״תמיד תבדוק X קודם״ מוסיף לרוב סבב או שניים.

---

## 4. למה האפליקציה איטית יותר מ־Postman

‏Postman שולח בדרך כלל בקשה אחת קטנה עם חיבור חם. אפליקציה מוסיפה מצב, הגדרות, שרת וממשק.

1. **הקשר שגדל.** היסטוריה שנשלחת שוב יחד עם `previous_interaction_id` (§3, מלכודת 3), שרשורים ארוכים,
   וקבצים שצורפו בהתחלה ונשארים בהקשר לתמיד. השוו באותו מספר תור.
2. **גוף בקשה אחר.** בדקו אם יש כלים דלוקים, ‏`tool_choice: "any"`, חוסר ב־`thinking_level` (ברירת המחדל
   של המודל היא medium או high), וסיכומי מחשבה. בדקו גם את `service_tier`: התשובות מראות
   `"service_tier": "standard"` אם לא ביקשתם priority. רשמו ללוג את הגוף המדויק שהשרת שולח והריצו אותו
   ב־Postman.
3. **סטרימינג שנאגר בדרך.** ‏middleware של דחיסה, ‏nginx ‏(`proxy_buffering`), ‏API gateways ופרוקסי
   ארגוניים יכולים להחזיק את הסטרים עד שהוא נגמר. שלחו `Cache-Control: no-transform`
   ו־`X-Accel-Buffering: no`, שחררו את הכותרות מוקדם, והוציאו את ה־SSE מהדחיסה.
4. **מחכים שהסטרים ייסגר.** אחרי `interaction.completed` הסטרים יכול להישאר פתוח: בין 3 ms ל־1.1 s
   בבדיקות. שחררו את הממשק ב־`interaction.completed`, ותנו לשאר להתרוקן ברקע.
5. **סבבים מיותרים.**
   - ‏GET על ה־interaction אחרי שיצרתם אותו;
   - ‏polling כשמשתמשים ב־`background: true`;
   - התאוששות מ־`previous_interaction_id` שפג תוקפו: בקשה שנכשלת ועוד שליחה מלאה של ההיסטוריה.

   ‏interactions שמורים פגים: ב־Developer API אחרי 55 יום בתוכנית בתשלום (אפשר לקצר עד 7 ימים) ואחרי
   יום אחד בתוכנית החינמית; בגרסת ה־preview של Vertex אחרי 7 ימים.
6. **שרשור שנשבר ושולח הכול בשקט.** החלפת מודל, או תור שנעצר, נכשל או הסתיים כ־`incomplete`, גורמים
   להרבה אפליקציות לחזור לשליחת כל ההיסטוריה. ‏`incomplete` נפוץ כש־`max_output_tokens` נמוך, כי
   החשיבה חולקת את אותו תקציב.
7. **התחברות ל־Vertex בתוך הבקשה (Node).**
   - יצירת `GoogleAuth` חדש בכל בקשה מריצה מחדש את גילוי האישורים ואת החלפת הטוקן.
   - אם לא מעבירים מזהה פרויקט (ו־`GOOGLE_CLOUD_PROJECT` / ‏`GCLOUD_PROJECT` לא מוגדרים), הספרייה מריצה
     את gcloud CLI כדי למצוא אותו. זה לקח 2–13 שניות במחשב פיתוח עם Windows.

   החזיקו לקוח אחד, העבירו `projectId`, רעננו לפני שהטוקן פג, וחממו אותו בעליית השרת.
8. **אין שימוש חוזר בחיבור (Node).** ה־`fetch` המובנה סוגר חיבורים לא פעילים אחרי כ־4 שניות, ולכן כמעט
   כל תור בקצב אנושי משלם על TLS handshake חדש (כ־80–90 ms במדידה). השתמשו ב־`Agent` של undici עם
   `keepAliveTimeout` ארוך יותר.
9. **מסך ריק בזמן שהמודל חושב.** ‏Google לא שולחת אירועים עד שהחשיבה נגמרת. הציגו מצב ״חושב…״ משלכם
   ברגע שהבקשה יוצאת, או הדליקו סיכומי מחשבה.
10. **רינדור בצד הלקוח.** רינדור מחדש של כל ההודעות וניתוח מחדש של כל ה־markdown בכל חתיכה, או שמירת
    כל הצ׳אט ל־storage בכל חתיכה, נעשים איטיים ככל שהתשובות גדלות. ‏Postman לא מרנדר כלום.
11. **מודדים את הדבר הלא נכון.** התחילו את הטיימר לפני ההתחברות ובניית הגוף, ורשמו בנפרד את זמן
    ההתחברות, הזמן עד הטוקן הראשון והזמן עד הסיום.

---

## 5. למה התור הראשון בצ׳אט חדש איטי

- טוקן התחברות קר, חיבור קר, ואולי גם מופע שרת קר (§4, מלכודות 7 ו־8).
- עבודה שהאפליקציה עושה רק לצ׳אט חדש וממתינה לה לפני הקריאה למודל: יצירת סשן, טעינת נתוני משתמש,
  שליפת מידע, או קריאה נוספת למודל שכותבת כותרת לצ׳אט.
- הפרומפט הכבד ביותר: הנחיית המערכת המלאה, הגדרות הכלים והקבצים המצורפים, בלי שום דבר שכבר נשמר.
  שימו את החלק הקבוע של הפרומפט בהתחלה ואת הנתונים של הסשן (שמות, תאריכים, מזהים) בסוף, כדי שההתחלה
  החוזרת תוכל להישמר בקאש.
- חשיבה גבוהה עם מסך ריק (§4, מלכודת 9).

---

## 6. רשימת בדיקה למעבר

- [ ] ‏URL חדש, ‏`model` בגוף הבקשה, ‏`stream: true`.
- [ ] הכלים שוטחו ל־`{ type: "function", … }`; שמות הכלים המובנים שונו ל־`{ type: "…" }`.
- [ ] ‏`tool_choice` בתוך `generation_config`, באותיות קטנות.
- [ ] ‏`tools`, ‏`system_instruction` ו־`generation_config` נשלחים **בכל** בקשה, כולל סבבי התוצאות.
- [ ] תורות המשך שולחים רק `previous_interaction_id` ואת הקלט החדש.
- [ ] ‏`requires_action` מטופל כ״להריץ את הכלים״, לא כשגיאה ולא כסוף.
- [ ] התוצאות מותאמות לפי `call_id`; כל התוצאות המקבילות חוזרות בבקשה אחת.
- [ ] התוצאות נשלחות כאובייקט או כרשימת חלקי תוכן, אף פעם לא כמחרוזת לבד.
- [ ] על 400 מסוג `malformed_tool_call` מנסים שוב פעם אחת.
- [ ] מחרוזות `arguments_delta` מהסטרים מחוברות ורק אז מפוענחות.
- [ ] הממשק משתחרר ב־`interaction.completed`; מזהה ה־interaction נשמר גם אם המשתמש עוצר אחר כך.
- [ ] יש מגבלת סבבים ללולאת הכלים.
- [ ] הזמנים נרשמים מתחילת הבקשה, עם התחברות, טוקן ראשון וסיום בנפרד.

---

## 7. מה לא נבדק בקריאות אמיתיות, או לא יציב

- התמיכה בקריאה אוטומטית לפונקציות וב־MCP מרוחק לקוחה מהתיעוד, לא מבדיקות.
- מה המודל עושה אחרי תוצאות חלקיות (§3, מלכודת 4) וכמה פעמים `tool_choice: "none"` נכשל (מלכודת 8)
  משתנים מהרצה להרצה. בדיקת ה־live מדווחת עליהם בלי להיכשל.
- זה ש־Vertex מעביר כלים הלאה (מלכודת 2) ומאבד תוצאות מחרוזת (מלכודת 9) נראה בגרסת ה־preview
  ‏`v1beta1`, ועשוי להשתנות כשתצא גרסה יציבה.
- בדיקה קודמת במאגר הזה ראתה ש־Vertex דוחה תור המשך מיידי עם
  *"invalid state (current state: IN_PROGRESS)"* אחרי שהסטרים בוטל ב־`interaction.completed`. בדיקה חוזרת
  ב־2026-10-28 (ביטול באירוע הסיום, ואז שליחת תוצאת פונקציה או תור טקסט) לא שחזרה את זה באף ספק. קריאת
  הסטרים עד הסוף היא עדיין ברירת המחדל הבטוחה.
- תקופות השמירה במלכודת 5 לקוחות מתיעוד: הנתונים של Developer API מסקירת Interactions של Google
  ‏(2026-10-28), והנתון של Vertex מ[מדריך ה־Interactions](interactions.en.md) של המאגר הזה.
- ההתנהגות של `output_text` ב־SDK (§1) לקוחה ממדריך המעבר של Google; הבדיקה קוראת ל־REST בלבד.

---

## 8. איך זה נבדק

הריצו `npm run check:interactions-tools` (או הוסיפו `-- gemini` / ‏`-- vertex`). הסקריפט קורא ל־Google
ישירות, עם בקשות קטנות, חשיבה נמוכה ו־`gemini-3.8-flash` (אפשר לשנות עם `CHECK_MODEL`). הוא בודק:

- את קו הבסיס של generateContent (מבנה הקריאה, חובת החתימה);
- את מבנה הקריאה ב־Interactions, את `requires_action` ואת פורמטי התוצאה (תוצאת מחרוזת לפי ספק);
- ש־`call_id` שגוי מתקבל;
- את `tool_choice` ‏(`any`, ‏`none`, ‏`allowed_tools`) ואת הקריאות המקבילות;
- מה עובר בירושה: כלים לפי ספק, הנחיית המערכת, ‏`generation_config`;
- את ספירת הטוקנים כשההקשר נשלח פעמיים, ואיך כל ספק מדווח שימוש בתורות משורשרים;
- את `store: false` עם צעד ה־`thought` ובלעדיו;
- כל שגיאות המבנה הישן ב־§2;
- פלט JSON עם `response_format`, וסוגי סכמה באותיות גדולות;
- את `google_search` ואת מבנה אירועי הסטרימינג.

ב־2026-10-28 הוא עבר גם ב־Gemini Developer API ‏(`v1`) וגם ב־Vertex AI ‏(`v1beta1`, ‏global); בדיקה אחת
של Vertex עברה רק בניסיון חוזר, אחרי שגיאת רשת.

מספרי המהירות ב־§4 מגיעים מסקירת ביצועים של המאגר הזה באותו יום: ‏Node 22.18 על Windows, מול
`aiplatform.googleapis.com` ו־`generativelanguage.googleapis.com`.

## מקורות רשמיים (נבדקו 2026-10-28)

- [Migrating to the Interactions API](https://ai.google.dev/gemini-api/docs/migrate-to-interactions)
- [Interactions overview](https://ai.google.dev/gemini-api/docs/interactions)
- [Function calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [Thought signatures](https://ai.google.dev/gemini-api/docs/thought-signatures)
- [Stable Interactions API reference](https://ai.google.dev/api/interactions-api-v1)
- [Google Cloud Interactions API reference](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api)
