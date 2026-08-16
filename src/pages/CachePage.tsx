import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronLeft,
  Clipboard,
  Clock3,
  ExternalLink,
  FileText,
  Layers3,
  ListRestart,
  Paperclip,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CacheExpirationMode,
  CacheFilePart,
  CacheTestConfig,
  CacheUseResult,
  CachedContentResource,
  ImplicitCacheProbeResult,
} from "../../shared/contracts";
import { MarkdownMessage } from "../components/MarkdownMessage";
import { TestLanguageToggle } from "../components/TestLanguageToggle";
import { useApp } from "../contexts/AppContext";
import { useTestLanguage } from "../contexts/TestLanguageContext";
import {
  ATTACHMENT_ACCEPT,
  attachmentToRequestPart,
  deleteAttachmentPayloads,
  processAttachment,
} from "../lib/attachments";
import { createId } from "../lib/storage";

const copy = {
  en: {
    back: "All tests", eyebrow: "GEMINI 3 · EXPLICIT CONTEXT CACHE", title: "Context cache lab",
    intro: "Create a real Vertex cache, inspect what the service stores, change its expiration, then use it and verify the cached token count.",
    guide: "Read cache guide", warningTitle: "Explicit cache storage is billable", warning: "Creation and use call Vertex AI. Storage continues until you delete the cache or it expires.",
    config: "Configure the cache", configHelp: "Model, content, instructions, display name, and encryption are immutable after creation.",
    project: "Google Cloud project", model: "Gemini 3 model", location: "Location", displayName: "Display name", immutable: "immutable",
    system: "System instruction", systemPlaceholder: "Optional instruction shared by every request that uses this cache…",
    contentSource: "Cached content source", text: "Inline text", gcs: "Cloud Storage file", cachedText: "Text to cache", gcsUri: "GCS URI", mimeType: "MIME type",
    files: "Cached files", filesHelp: "Every file becomes another part of the same cached content, alongside the text above. Cache text, files, or both.",
    addFiles: "Add files", addGcs: "Add Cloud Storage file", add: "Add", remove: "Remove", noFiles: "No files added.",
    fileKindInline: "inlineData", fileKindGcs: "fileData", fileKindText: "extracted text",
    filesUncounted: "Files also add tokens, which this character-based estimate does not include.",
    fileHint: "PDFs are sent inline as base64. Other formats are extracted to text in the browser. Use a gs:// URI for large files.",
    sample: "Fill ~5K-token learning sample", clear: "Clear", estimate: "Estimated tokens", minimum: "Gemini 3 minimum", estimateNote: "Character-based estimate only; Vertex reports the authoritative token count after creation.",
    expiration: "Expiration", ttl: "TTL (seconds from now)", exact: "Exact expireTime", ttlHelp: "Default is 3,600 seconds. Minimum is 60 seconds; there is no documented maximum.",
    cmek: "CMEK resource name", optional: "optional", cmekHelp: "CMEK is unavailable on the global endpoint. The CryptoKey is immutable after creation.",
    payload: "Request field preview", create: "Create cache", creating: "Creating cache…",
    lifecycle: "Cache lifecycle", lifecycleHelp: "Use the resource name for later get, update, generate, and delete operations.",
    list: "List caches in this location", listing: "Loading caches…", noCaches: "No caches returned for this location.", useThis: "Inspect",
    active: "Active cache", copyName: "Copy name", copied: "Copied", refresh: "Refresh metadata", update: "Update expiration", updating: "Updating…",
    delete: "Delete cache", confirmDelete: "Click again to permanently delete", deleting: "Deleting…", deleted: "The cache was deleted.",
    created: "Created", updated: "Updated", expires: "Expires", remaining: "TTL remaining", storedTokens: "Stored tokens", textChars: "Text characters", modelField: "Model", resource: "Resource name",
    use: "Use the cache", useHelp: "This sends only the new question plus cachedContent. A hit is proven by usageMetadata.cachedContentTokenCount.",
    prompt: "New prompt", promptPlaceholder: "Ask a question that depends on the cached material…", generate: "Generate with cache", generating: "Generating…",
    evidence: "Cache-hit evidence", cachedTokens: "Cached input tokens", promptTokens: "Prompt tokens", outputTokens: "Output tokens", totalTokens: "Total tokens", latency: "Latency", noEvidence: "The provider did not return cachedContentTokenCount. Check model support, minimum tokens, and whether the cache was referenced.",
    response: "Model response", learn: "What this demonstrates", learning: ["The cache content and model are fixed when created.", "TTL or expireTime can be updated while the cache is unexpired.", "cachedContentTokenCount is the authoritative cache-hit signal.", "Deleting early stops future storage time; an expired resource must be recreated."],
    readiness: "Series 3 notes", notes: "The default list follows Google's explicit-cache support table. Gemini 3 caches require at least 4,096 tokens; some preview models have different implicit-cache thresholds.",
    implicitEyebrow: "No cache resource", implicitTitle: "See implicit cache",
    implicitHelp: "Vertex may reuse a matching prefix automatically. This sends four generateContent calls: the large document is the systemInstruction, and the two questions alternate. A hit is proven only by usageMetadata.cachedContentTokenCount — it is best-effort, so a miss is a valid result.",
    implicitModel: "Model for implicit probe", implicitRun: "Send four prefix-matched requests", implicitRunning: "Probing implicit cache…",
    implicitQ1: "First question", implicitQ2: "Second question",
    implicitCall: "Request", implicitMiss: "No cachedContentTokenCount on any of the four calls. Implicit caching did not hit this time.",
    implicitHit: "Implicit cache hit", implicitNote: "Request 1 usually writes the prefix. Later requests can hit. Gemini 3 often needs a third call. There is no CachedContent name and no storage bill.",
  },
  he: {
    back: "כל הבדיקות", eyebrow: "GEMINI 3 · מטמון הקשר מפורש", title: "מעבדת מטמון הקשר",
    intro: "צור מטמון אמיתי ב־Vertex, בדוק מה השירות שומר, שנה את זמן הפקיעה, השתמש בו ואמת את מספר הטוקנים שנקראו מהמטמון.",
    guide: "פתיחת מדריך המטמון", warningTitle: "אחסון מטמון מפורש כרוך בחיוב", warning: "יצירה ושימוש קוראים ל־Vertex AI. האחסון ממשיך עד למחיקה או לפקיעה.",
    config: "הגדרת המטמון", configHelp: "המודל, התוכן, ההוראה, השם וההצפנה אינם ניתנים לשינוי אחרי היצירה.",
    project: "פרויקט Google Cloud", model: "מודל Gemini 3", location: "מיקום", displayName: "שם תצוגה", immutable: "בלתי ניתן לשינוי",
    system: "הוראת מערכת", systemPlaceholder: "הוראה אופציונלית המשותפת לכל בקשה שמשתמשת במטמון…",
    contentSource: "מקור התוכן למטמון", text: "טקסט מוטמע", gcs: "קובץ Cloud Storage", cachedText: "טקסט למטמון", gcsUri: "כתובת GCS", mimeType: "סוג MIME",
    files: "קבצים במטמון", filesHelp: "כל קובץ הופך לחלק (part) נוסף באותו תוכן שמור, לצד הטקסט שלמעלה. אפשר לשמור טקסט, קבצים או שניהם.",
    addFiles: "הוספת קבצים", addGcs: "הוספת קובץ Cloud Storage", add: "הוספה", remove: "הסרה", noFiles: "לא נוספו קבצים.",
    fileKindInline: "inlineData", fileKindGcs: "fileData", fileKindText: "טקסט שחולץ",
    filesUncounted: "גם הקבצים מוסיפים טוקנים, וההערכה לפי תווים אינה כוללת אותם.",
    fileHint: "קובצי PDF נשלחים מוטמעים כ־base64. פורמטים אחרים מחולצים לטקסט בדפדפן. לקבצים גדולים השתמש בכתובת gs://.",
    sample: "מילוי דוגמת לימוד של כ־5K טוקנים", clear: "ניקוי", estimate: "הערכת טוקנים", minimum: "מינימום ל־Gemini 3", estimateNote: "זו הערכה לפי תווים בלבד; Vertex מחזיר את הספירה המוסמכת אחרי היצירה.",
    expiration: "פקיעה", ttl: "TTL (שניות מעכשיו)", exact: "expireTime מדויק", ttlHelp: "ברירת המחדל היא 3,600 שניות. המינימום 60 שניות ואין מקסימום מתועד.",
    cmek: "שם משאב CMEK", optional: "אופציונלי", cmekHelp: "CMEK אינו זמין בנקודת הקצה הגלובלית. מפתח ההצפנה בלתי ניתן לשינוי לאחר היצירה.",
    payload: "תצוגה מקדימה של שדות הבקשה", create: "יצירת מטמון", creating: "יוצרת מטמון…",
    lifecycle: "מחזור חיי המטמון", lifecycleHelp: "שם המשאב משמש לקריאה, עדכון, יצירה ומחיקה בהמשך.",
    list: "הצגת מטמונים במיקום", listing: "טוענת מטמונים…", noCaches: "לא הוחזרו מטמונים עבור המיקום.", useThis: "בדיקה",
    active: "מטמון פעיל", copyName: "העתקת שם", copied: "הועתק", refresh: "רענון מטא־דאטה", update: "עדכון פקיעה", updating: "מעדכנת…",
    delete: "מחיקת מטמון", confirmDelete: "לחץ שוב למחיקה סופית", deleting: "מוחקת…", deleted: "המטמון נמחק.",
    created: "נוצר", updated: "עודכן", expires: "פג", remaining: "TTL שנותר", storedTokens: "טוקנים שמורים", textChars: "תווי טקסט", modelField: "מודל", resource: "שם משאב",
    use: "שימוש במטמון", useHelp: "הבקשה שולחת רק את השאלה החדשה ואת cachedContent. פגיעה מוכחת באמצעות usageMetadata.cachedContentTokenCount.",
    prompt: "פרומפט חדש", promptPlaceholder: "שאל שאלה שתלויה בחומר השמור במטמון…", generate: "יצירה עם המטמון", generating: "יוצרת תשובה…",
    evidence: "הוכחת פגיעה במטמון", cachedTokens: "טוקנים מהמטמון", promptTokens: "טוקנים בפרומפט", outputTokens: "טוקנים בפלט", totalTokens: "סך הכול טוקנים", latency: "זמן תגובה", noEvidence: "הספק לא החזיר cachedContentTokenCount. בדוק תמיכת מודל, מינימום טוקנים והפניה נכונה למטמון.",
    response: "תשובת המודל", learn: "מה הניסוי מדגים", learning: ["תוכן המטמון והמודל נקבעים בזמן היצירה.", "אפשר לעדכן TTL או expireTime כל עוד המטמון לא פג.", "cachedContentTokenCount הוא האות המוסמך לפגיעת מטמון.", "מחיקה מוקדמת מפסיקה אחסון עתידי; משאב שפג צריך ליצור מחדש."],
    readiness: "הערות לסדרה 3", notes: "רשימת ברירת המחדל מבוססת על טבלת התמיכה של Google במטמון מפורש. מטמוני Gemini 3 דורשים לפחות 4,096 טוקנים; לחלק ממודלי התצוגה המקדימה יש סף אחר במטמון משתמע.",
    implicitEyebrow: "בלי משאב מטמון", implicitTitle: "לראות מטמון משתמע",
    implicitHelp: "Vertex עשוי למחזר קידומת תואמת אוטומטית. כאן נשלחות ארבע קריאות generateContent: המסמך הגדול הוא systemInstruction, ושתי השאלות מתחלפות. פגיעה מוכחת רק על ידי usageMetadata.cachedContentTokenCount — זה best-effort, ופספוס הוא תוצאה תקינה.",
    implicitModel: "מודל לבדיקת מטמון משתמע", implicitRun: "שליחת ארבע בקשות עם אותה קידומת", implicitRunning: "בודקת מטמון משתמע…",
    implicitQ1: "שאלה ראשונה", implicitQ2: "שאלה שנייה",
    implicitCall: "בקשה", implicitMiss: "אין cachedContentTokenCount באף אחת מארבע הקריאות. המטמון המשתמע לא פגע הפעם.",
    implicitHit: "פגיעת מטמון משתמע", implicitNote: "בקשה 1 בדרך כלל כותבת את הקידומת. הבקשות הבאות יכולות לפגוע. ב־Gemini 3 לעיתים צריך קריאה שלישית. אין שם CachedContent ואין חיוב אחסון.",
  },
} as const;

type CacheFileEntry = CacheFilePart & { id: string };

type FileKindLabels = { fileKindGcs: string; fileKindInline: string; fileKindText: string };

function fileEntrySummary(file: CacheFileEntry, t: FileKindLabels): string {
  if (file.kind === "gcs") return `${t.fileKindGcs} · ${file.fileUri}`;
  if (file.kind === "inlineData") {
    return `${t.fileKindInline} · ${Math.max(1, Math.round(file.data.length * 3 / 4 / 1024)).toLocaleString()} KB`;
  }
  return `${t.fileKindText} · ${file.text.length.toLocaleString()} chars`;
}

function defaultDisplayName(): string {
  return `gemini-prep-${new Date().toISOString().slice(0, 10)}`;
}

function implicitQuestions(language: "en" | "he"): [string, string] {
  return language === "he"
    ? ["צטט את סעיף 1 במשפט אחד.", "צטט את סעיף 2 במשפט אחד."]
    : ["Cite section 1 in one sentence.", "Cite section 2 in one sentence."];
}

function localDateTime(hoursFromNow = 1): string {
  const date = new Date(Date.now() + hoursFromNow * 3_600_000);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function sampleContext(language: "en" | "he"): string {
  const intro = language === "he"
    ? "מסמך לימוד פנימי: מדיניות הפעלה של עוזר ארגוני. יש לענות רק לפי העובדות במסמך ולציין את מספר הסעיף."
    : "Internal learning document: enterprise assistant operating policy. Answer only from this document and cite the section number.";
  const sections = Array.from({ length: 140 }, (_, index) => language === "he"
    ? `סעיף ${index + 1}: כל בקשת מודל חייבת לתעד מודל, אזור, מזהה תגובה וזמן תגובה. מידע רגיש נשאר בגבולות הפרויקט. שינויי תצורה נבדקים בסביבת הכנה לפני הפעלה. בעלי השירות בודקים שגיאות, מכסה ועלויות פעם ביום.`
    : `Section ${index + 1}: Every model request must record its model, region, response identifier, and latency. Sensitive information remains inside the project boundary. Configuration changes are tested in a preparation environment before activation. Service owners review errors, quota, and cost once per day.`);
  return [intro, ...sections].join("\n\n");
}

function formatTime(value: string | undefined, language: "en" | "he"): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(language === "he" ? "he-IL" : "en-US", { dateStyle: "medium", timeStyle: "medium" });
}

function remainingTime(expireTime: string | undefined, now: number): string {
  if (!expireTime) return "—";
  const seconds = Math.max(0, Math.floor((Date.parse(expireTime) - now) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${hours}h ${minutes}m ${remainder}s`;
}

async function cachePost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/api/tests/cache/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json() as T & { error?: string };
  if (!response.ok || value.error) throw new Error(value.error ?? `Request failed (${response.status}).`);
  return value;
}

export function CachePage() {
  const { language, direction } = useTestLanguage();
  const { settings } = useApp();
  const t = copy[language];
  const [config, setConfig] = useState<CacheTestConfig | null>(null);
  const [project, setProject] = useState("");
  const [model, setModel] = useState("");
  const [implicitModel, setImplicitModel] = useState("");
  const [region, setRegion] = useState("global");
  const [displayName, setDisplayName] = useState(defaultDisplayName);
  const [systemInstruction, setSystemInstruction] = useState("");
  const [content, setContent] = useState("");
  const [files, setFiles] = useState<CacheFileEntry[]>([]);
  const [gcsUri, setGcsUri] = useState("");
  const [mimeType, setMimeType] = useState("application/pdf");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [expirationMode, setExpirationMode] = useState<CacheExpirationMode>("ttl");
  const [ttlSeconds, setTtlSeconds] = useState(3600);
  const [expireTime, setExpireTime] = useState(() => localDateTime());
  const [kmsKeyName, setKmsKeyName] = useState("");
  const [resource, setResource] = useState<CachedContentResource | null>(null);
  const [caches, setCaches] = useState<CachedContentResource[] | null>(null);
  const [prompt, setPrompt] = useState(language === "he" ? "מהי תדירות בדיקת העלויות?" : "How often must service owners review cost?");
  const [questionOne, setQuestionOne] = useState(() => implicitQuestions(language)[0]);
  const [questionTwo, setQuestionTwo] = useState(() => implicitQuestions(language)[1]);
  const [useResult, setUseResult] = useState<CacheUseResult | null>(null);
  const [implicitResult, setImplicitResult] = useState<ImplicitCacheProbeResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/tests/cache/config", { signal: controller.signal })
      .then(async (response) => {
        const value = await response.json() as CacheTestConfig & { error?: string };
        if (!response.ok || value.error) throw new Error(value.error ?? "Could not load cache configuration.");
        setConfig(value);
        setProject(value.project ?? "");
        setModel(value.defaults.model);
        setImplicitModel(value.defaults.implicitModel);
        setRegion(value.defaults.region);
        setTtlSeconds(value.defaults.ttlSeconds);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    setPrompt(language === "he" ? "מהי תדירות בדיקת העלויות?" : "How often must service owners review cost?");
    const [first, second] = implicitQuestions(language);
    setQuestionOne(first);
    setQuestionTwo(second);
  }, [language]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const estimatedTokens = Math.ceil(
    (content.length + files.reduce((total, file) => total + (file.kind === "text" ? file.text.length : 0), 0)) / 4,
  );
  const hasUncountedFiles = files.some((file) => file.kind !== "text");
  const normalizedExpireTime = expireTime && Number.isFinite(Date.parse(expireTime))
    ? new Date(expireTime).toISOString()
    : "";
  const expirationValid = expirationMode === "ttl"
    ? Number.isFinite(ttlSeconds) && ttlSeconds >= (config?.limits.minimumTtlSeconds ?? 60)
    : Boolean(normalizedExpireTime) && Date.parse(normalizedExpireTime) > Date.now();
  const fieldPreview = useMemo(() => ({
    model: `projects/${project || "PROJECT"}/locations/${region}/publishers/google/models/${model || "MODEL"}`,
    ...(displayName ? { displayName } : {}),
    ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
    contents: [{
      role: "user",
      parts: [
        ...(content ? [{ text: `${content.slice(0, 180)}${content.length > 180 ? "…" : ""}` }] : []),
        ...files.map((file) => {
          if (file.kind === "gcs") return { fileData: { fileUri: file.fileUri, mimeType: file.mimeType } };
          if (file.kind === "inlineData") return { inlineData: { mimeType: file.mimeType, data: "…" } };
          return { text: `--- Cached file: ${file.name} (${file.mimeType}) ---…` };
        }),
        ...(content || files.length ? [] : [{ text: "…" }]),
      ],
    }],
    ...(expirationMode === "ttl" ? { ttl: `${ttlSeconds}s` } : { expireTime: normalizedExpireTime }),
    ...(kmsKeyName ? { encryptionSpec: { kmsKeyName } } : {}),
  }), [content, displayName, expirationMode, files, kmsKeyName, model, normalizedExpireTime, project, region, systemInstruction, ttlSeconds]);

  async function addLocalFiles(selected: FileList | null) {
    if (!selected?.length) return;
    prepareAction("files");
    const added: CacheFileEntry[] = [];
    try {
      for (const file of Array.from(selected)) {
        const attachment = await processAttachment(file);
        try {
          const part = await attachmentToRequestPart(attachment);
          added.push({ ...part, id: createId() });
        } finally {
          await deleteAttachmentPayloads([attachment]);
        }
      }
      setFiles((current) => [...current, ...added]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function addGcsFile() {
    const uri = gcsUri.trim();
    if (!uri || !mimeType.trim()) return;
    setFiles((current) => [...current, {
      kind: "gcs",
      id: createId(),
      name: uri.split("/").at(-1) || uri,
      mimeType: mimeType.trim(),
      fileUri: uri,
    }]);
    setGcsUri("");
  }

  function prepareAction(action: string) {
    setBusy(action);
    setError(null);
    setNotice(null);
    setDeleteArmed(false);
  }

  async function createCache() {
    prepareAction("create");
    try {
      const created = await cachePost<CachedContentResource>("create", {
        project,
        model,
        region,
        displayName,
        systemInstruction,
        content,
        files: files.map(({ id: _id, ...part }) => part),
        expirationMode,
        ttlSeconds,
        expireTime: expirationMode === "expireTime" ? normalizedExpireTime : undefined,
        kmsKeyName,
      });
      setResource(created);
      setUseResult(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  async function listCaches() {
    prepareAction("list");
    try {
      const value = await cachePost<{ cachedContents?: CachedContentResource[] }>("list", { project, region });
      setCaches(value.cachedContents ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  async function refreshCache() {
    if (!resource) return;
    prepareAction("refresh");
    try {
      setResource(await cachePost<CachedContentResource>("get", { name: resource.name }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  async function updateExpiration() {
    if (!resource) return;
    prepareAction("update");
    try {
      setResource(await cachePost<CachedContentResource>("update", {
        name: resource.name,
        expirationMode,
        ttlSeconds,
        expireTime: expirationMode === "expireTime" ? normalizedExpireTime : undefined,
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  async function probeImplicit() {
    const prefix = content.trim() || sampleContext(language);
    if (!content.trim()) setContent(prefix);
    prepareAction("implicit");
    try {
      setImplicitResult(await cachePost<ImplicitCacheProbeResult>("implicit", {
        project,
        model: implicitModel,
        region,
        prefix,
        questionOne,
        questionTwo,
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  async function generateWithCache() {
    if (!resource) return;
    prepareAction("use");
    try {
      setUseResult(await cachePost<CacheUseResult>("use", {
        project,
        name: resource.name,
        model: resource.model.split("/").at(-1) ?? model,
        region: resource.name.split("/")[3] ?? region,
        prompt,
        temperature: 0.2,
        maxOutputTokens: 2048,
        thinkingLevel: settings.thinkingLevel,
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  async function deleteCache() {
    if (!resource) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    prepareAction("delete");
    try {
      await cachePost<{ deleted: true }>("delete", { name: resource.name });
      setResource(null);
      setUseResult(null);
      setNotice(t.deleted);
      setCaches((current) => current?.filter((entry) => entry.name !== resource.name) ?? null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  function inspectListedCache(cache: CachedContentResource) {
    setResource(cache);
    setModel(cache.model.split("/").at(-1) ?? model);
    setRegion(cache.name.split("/")[3] ?? region);
    setUseResult(null);
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }

  const cachedTokenCount = Number(useResult?.usageMetadata?.cachedContentTokenCount ?? 0);

  return (
    <div className="route-page cache-page" dir={direction} lang={language}>
      <div className="test-page-tools">
        <a href="/tests" className="back-link"><ChevronLeft size={15} />{t.back}</a>
        <TestLanguageToggle />
      </div>
      <header className="page-heading">
        <div>
          <p className="eyebrow">{t.eyebrow}</p>
          <h1>{t.title}</h1>
          <p>{t.intro}</p>
        </div>
        <a className="secondary-button" href={`/docs/tests/cache.${language}.md`} target="_blank" rel="noreferrer">
          {t.guide} <ExternalLink size={15} />
        </a>
      </header>

      <div className="cache-billing-warning"><AlertTriangle size={19} /><div><strong>{t.warningTitle}</strong><p>{t.warning}</p></div></div>

      <section className="test-panel">
        <div className="test-panel-heading">
          <div><span className="step-number">0</span><div><h2>{t.implicitTitle}</h2><p>{t.implicitEyebrow}</p></div></div>
          <span className="series-badge">Implicit</span>
        </div>
        <p className="implicit-help">{t.implicitHelp}</p>
        <div className="cache-fields-grid">
          <label className="form-field">
            <span>{t.implicitModel}</span>
            <select value={implicitModel} onChange={(event) => setImplicitModel(event.target.value)}>
              {(config?.implicitModels ?? config?.models ?? []).map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.label} · {entry.id}</option>
              ))}
            </select>
          </label>
          <label className="form-field"><span>{t.implicitQ1}</span><input value={questionOne} onChange={(event) => setQuestionOne(event.target.value)} /></label>
          <label className="form-field"><span>{t.implicitQ2}</span><input value={questionTwo} onChange={(event) => setQuestionTwo(event.target.value)} /></label>
        </div>
        <p className="implicit-help">{t.implicitNote} {language === "he" ? "הקידומת נלקחת מתיבת הטקסט למטה. אם היא ריקה, תמולא דוגמת הלימוד." : "The shared prefix comes from the text box below. If it is empty, the learning sample is filled in."}</p>
        <button className="primary-button" onClick={() => void probeImplicit()} disabled={Boolean(busy) || !project || !implicitModel || !questionOne.trim() || !questionTwo.trim()}>
          <Play size={16} fill="currentColor" />{busy === "implicit" ? t.implicitRunning : t.implicitRun}
        </button>
        {implicitResult ? (
          <>
            <div className={`cache-hit-banner${implicitResult.hit ? " cache-hit-success" : ""}`} style={{ marginTop: 16 }}>
              {implicitResult.hit ? <ShieldCheck size={24} /> : <AlertTriangle size={24} />}
              <div>
                <strong>{implicitResult.hit ? `${implicitResult.cachedTokens.toLocaleString()} ${t.cachedTokens}` : t.implicitMiss}</strong>
                <span>{implicitResult.hit ? t.implicitHit : "NO CACHE-HIT FIELD"}</span>
              </div>
            </div>
            <div className="implicit-compare">
              {implicitResult.calls.map((call, index) => (
                <article className="implicit-call" key={`${call.question}-${index}`}>
                  <h3>{t.implicitCall} {index + 1}</h3>
                  <dl>
                    <div><dt>{t.cachedTokens}</dt><dd>{Number(call.usageMetadata?.cachedContentTokenCount ?? 0).toLocaleString()}</dd></div>
                    <div><dt>{t.promptTokens}</dt><dd>{Number(call.usageMetadata?.promptTokenCount ?? 0).toLocaleString()}</dd></div>
                    <div><dt>{t.outputTokens}</dt><dd>{Number(call.usageMetadata?.candidatesTokenCount ?? 0).toLocaleString()}</dd></div>
                    <div><dt>{t.latency}</dt><dd>{call.latencyMs.toLocaleString()} ms</dd></div>
                  </dl>
                </article>
              ))}
            </div>
          </>
        ) : null}
      </section>

      <section className="test-panel cache-config-panel">
        <div className="test-panel-heading">
          <div><span className="step-number">1</span><div><h2>{t.config}</h2><p>{t.configHelp}</p></div></div>
          <span className="series-badge">Gemini 3</span>
        </div>

        <div className="cache-fields-grid">
          <label className="form-field">
            <span>{t.project}</span>
            <input value={project} onChange={(event) => setProject(event.target.value)} disabled={Boolean(config?.project)} placeholder="project-id" />
          </label>
          <label className="form-field">
            <span>{t.model} <small className="inline-badge">{t.immutable}</small></span>
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              {(config?.models ?? []).map((entry) => <option key={entry.id} value={entry.id}>{entry.label} · {entry.id}</option>)}
            </select>
          </label>
          <label className="form-field">
            <span>{t.location} <small className="inline-badge">{t.immutable}</small></span>
            <select value={region} onChange={(event) => { setRegion(event.target.value); setCaches(null); }}>
              {(config?.regions ?? []).map((entry) => <option key={entry.id} value={entry.id}>{entry.label} · {entry.id}</option>)}
            </select>
          </label>
          <label className="form-field">
            <span>{t.displayName} <small className="inline-badge">{t.immutable}</small></span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={128} />
          </label>
          <label className="form-field form-field-wide">
            <span>{t.system} <small className="inline-badge">{t.immutable}</small></span>
            <textarea rows={3} value={systemInstruction} onChange={(event) => setSystemInstruction(event.target.value)} placeholder={t.systemPlaceholder} />
          </label>
        </div>

        <div className="cache-subsection">
          <div className="cache-subsection-title"><FileText size={17} /><strong>{t.contentSource}</strong><span className="inline-badge">{t.immutable}</span></div>
          <p className="cache-subsection-help">{t.filesHelp}</p>
          <label className="form-field">
            <span>{t.cachedText}</span>
            <textarea className="cache-content-editor" rows={10} value={content} onChange={(event) => setContent(event.target.value)} />
          </label>
          <div className="cache-editor-actions">
            <button className="secondary-button" onClick={() => setContent(sampleContext(language))}><Sparkles size={15} />{t.sample}</button>
            <button className="text-button" onClick={() => setContent("")}>{t.clear}</button>
          </div>

          <div className="cache-files">
            <div className="cache-files-header">
              <strong>{t.files}</strong>
              <button className="secondary-button" onClick={() => fileInputRef.current?.click()} disabled={busy === "files"}>
                <Paperclip size={15} />{t.addFiles}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ATTACHMENT_ACCEPT}
                hidden
                onChange={(event) => void addLocalFiles(event.target.files)}
              />
            </div>
            {files.length === 0 ? (
              <p className="cache-files-empty">{t.noFiles}</p>
            ) : (
              <ul className="cache-files-list">
                {files.map((file) => (
                  <li key={file.id}>
                    <FileText size={15} />
                    <span className="cache-file-name">{file.name}</span>
                    <span className="cache-file-meta">{fileEntrySummary(file, t)}</span>
                    <button
                      className="text-button"
                      onClick={() => setFiles((current) => current.filter((entry) => entry.id !== file.id))}
                    >
                      {t.remove}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="cache-fields-grid">
              <label className="form-field"><span>{t.gcsUri}</span><input value={gcsUri} onChange={(event) => setGcsUri(event.target.value)} placeholder="gs://bucket/path/document.pdf" /></label>
              <label className="form-field"><span>{t.mimeType}</span><input value={mimeType} onChange={(event) => setMimeType(event.target.value)} placeholder="application/pdf" /></label>
            </div>
            <button className="secondary-button" onClick={addGcsFile} disabled={!gcsUri.trim() || !mimeType.trim()}>
              <Plus size={15} />{t.addGcs}
            </button>
            <small>{t.fileHint}</small>
          </div>

          <div className={`token-meter${estimatedTokens >= (config?.limits.minimumTokensGemini3 ?? 4096) ? " token-meter-ready" : ""}`}>
            <div><span>{t.estimate}</span><strong>≈ {estimatedTokens.toLocaleString()}</strong></div>
            <div><span>{t.minimum}</span><strong>{(config?.limits.minimumTokensGemini3 ?? 4096).toLocaleString()}</strong></div>
            <p>{t.estimateNote}{hasUncountedFiles ? ` ${t.filesUncounted}` : ""}</p>
          </div>
        </div>

        <div className="cache-subsection cache-expiration-section">
          <div className="cache-subsection-title"><Clock3 size={17} /><strong>{t.expiration}</strong><span className="mutable-badge">mutable</span></div>
          <div className="segmented-control">
            <button className={expirationMode === "ttl" ? "active" : ""} onClick={() => setExpirationMode("ttl")}>TTL</button>
            <button className={expirationMode === "expireTime" ? "active" : ""} onClick={() => setExpirationMode("expireTime")}>expireTime</button>
          </div>
          <div className="cache-fields-grid">
            {expirationMode === "ttl" ? (
              <label className="form-field"><span>{t.ttl}</span><input type="number" min={60} step={60} value={ttlSeconds} onChange={(event) => setTtlSeconds(Number(event.target.value))} /><small>{t.ttlHelp}</small></label>
            ) : (
              <label className="form-field"><span>{t.exact}</span><input type="datetime-local" value={expireTime} onChange={(event) => setExpireTime(event.target.value)} /></label>
            )}
            <label className="form-field"><span>{t.cmek} <small className="inline-badge">{t.optional}</small></span><input value={kmsKeyName} onChange={(event) => setKmsKeyName(event.target.value)} placeholder="projects/…/cryptoKeys/…" /><small>{t.cmekHelp}</small></label>
          </div>
        </div>

        <details className="payload-preview"><summary>{t.payload}</summary><pre>{JSON.stringify(fieldPreview, null, 2)}</pre></details>
        <button className="primary-button cache-create-button" onClick={() => void createCache()} disabled={Boolean(busy) || !project || !model || !expirationValid || (!content && files.length === 0)}>
          <Layers3 size={17} />{busy === "create" ? t.creating : t.create}
        </button>
      </section>

      {error ? <div className="panel-error" role="alert">{error}</div> : null}
      {notice ? <div className="panel-notice"><Check size={16} />{notice}</div> : null}

      <section className="test-panel cache-lifecycle-panel">
        <div className="test-panel-heading">
          <div><span className="step-number">2</span><div><h2>{t.lifecycle}</h2><p>{t.lifecycleHelp}</p></div></div>
          <button className="secondary-button" onClick={() => void listCaches()} disabled={Boolean(busy)}><ListRestart size={15} />{busy === "list" ? t.listing : t.list}</button>
        </div>

        {caches ? (
          <div className="cache-list">
            {caches.length === 0 ? <p className="empty-list">{t.noCaches}</p> : caches.map((cache) => (
              <div className="cache-list-row" key={cache.name}>
                <span><strong>{cache.displayName || cache.name.split("/").at(-1)}</strong><small>{cache.model.split("/").at(-1)} · {formatTime(cache.expireTime, language)}</small></span>
                <button className="secondary-button" onClick={() => inspectListedCache(cache)}>{t.useThis}</button>
              </div>
            ))}
          </div>
        ) : null}

        {resource ? (
          <div className="active-cache">
            <div className="active-cache-heading">
              <span className="cache-live-dot" />
              <div><span>{t.active}</span><strong>{resource.displayName || resource.name.split("/").at(-1)}</strong></div>
              <div className="active-cache-actions">
                <button className="secondary-button" onClick={async () => { await navigator.clipboard.writeText(resource.name); setCopied(true); window.setTimeout(() => setCopied(false), 1400); }}><Clipboard size={14} />{copied ? t.copied : t.copyName}</button>
                <button className="secondary-button" onClick={() => void refreshCache()} disabled={Boolean(busy)}><RefreshCw size={14} />{t.refresh}</button>
              </div>
            </div>
            <div className="cache-metadata-grid">
              <div><span>{t.created}</span><strong>{formatTime(resource.createTime, language)}</strong></div>
              <div><span>{t.updated}</span><strong>{formatTime(resource.updateTime, language)}</strong></div>
              <div><span>{t.expires}</span><strong>{formatTime(resource.expireTime, language)}</strong></div>
              <div><span>{t.remaining}</span><strong className="ttl-clock">{remainingTime(resource.expireTime, now)}</strong></div>
              <div><span>{t.storedTokens}</span><strong>{resource.usageMetadata?.totalTokenCount?.toLocaleString() ?? "—"}</strong></div>
              <div><span>{t.textChars}</span><strong>{resource.usageMetadata?.textCount?.toLocaleString() ?? "—"}</strong></div>
            </div>
            <dl className="cache-resource-details">
              <div><dt>{t.modelField}</dt><dd>{resource.model}</dd></div>
              <div><dt>{t.resource}</dt><dd>{resource.name}</dd></div>
            </dl>
            <div className="cache-resource-controls">
              <button className="secondary-button" onClick={() => void updateExpiration()} disabled={Boolean(busy) || !expirationValid}><Clock3 size={14} />{busy === "update" ? t.updating : t.update}</button>
              <button className={`danger-button${deleteArmed ? " danger-button-armed" : ""}`} onClick={() => void deleteCache()} disabled={Boolean(busy)}><Trash2 size={14} />{busy === "delete" ? t.deleting : deleteArmed ? t.confirmDelete : t.delete}</button>
            </div>

            <div className="cache-use-section">
              <div className="test-panel-heading">
                <div><span className="step-number">3</span><div><h2>{t.use}</h2><p>{t.useHelp}</p></div></div>
              </div>
              <label className="form-field"><span>{t.prompt}</span><textarea rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t.promptPlaceholder} /></label>
              <button className="primary-button" onClick={() => void generateWithCache()} disabled={Boolean(busy) || !prompt.trim()}><Play size={16} fill="currentColor" />{busy === "use" ? t.generating : t.generate}</button>
            </div>
          </div>
        ) : (
          <div className="cache-empty-state"><Layers3 size={24} /><p>{language === "he" ? "צור מטמון חדש או בחר מטמון קיים כדי לבדוק את מחזור החיים." : "Create a cache or inspect an existing one to begin the lifecycle."}</p></div>
        )}
      </section>

      {useResult ? (
        <section className="test-panel cache-evidence-panel">
          <div className="test-panel-heading"><div><span className="step-number">4</span><div><h2>{t.evidence}</h2><p><code>usageMetadata.cachedContentTokenCount</code></p></div></div></div>
          <div className={`cache-hit-banner${cachedTokenCount > 0 ? " cache-hit-success" : ""}`}>
            {cachedTokenCount > 0 ? <ShieldCheck size={24} /> : <AlertTriangle size={24} />}
            <div><strong>{cachedTokenCount > 0 ? `${cachedTokenCount.toLocaleString()} ${t.cachedTokens}` : t.noEvidence}</strong><span>{cachedTokenCount > 0 ? "CACHE HIT" : "NO CACHE-HIT FIELD"}</span></div>
          </div>
          <div className="result-stats cache-usage-stats">
            <div><strong>{cachedTokenCount.toLocaleString()}</strong><span>{t.cachedTokens}</span></div>
            <div><strong>{Number(useResult.usageMetadata?.promptTokenCount ?? 0).toLocaleString()}</strong><span>{t.promptTokens}</span></div>
            <div><strong>{Number(useResult.usageMetadata?.candidatesTokenCount ?? 0).toLocaleString()}</strong><span>{t.outputTokens}</span></div>
            <div><strong>{Number(useResult.usageMetadata?.totalTokenCount ?? 0).toLocaleString()}</strong><span>{t.totalTokens}</span></div>
            <div><strong>{useResult.latencyMs.toLocaleString()} ms</strong><span>{t.latency}</span></div>
          </div>
          <h3>{t.response}</h3>
          <div className="cache-response"><MarkdownMessage>{useResult.text || "—"}</MarkdownMessage></div>
        </section>
      ) : null}

      <section className="cache-learning-grid">
        <div><span className="learning-icon"><ShieldCheck size={18} /></span><h3>{t.readiness}</h3><p>{t.notes}</p></div>
        <div><span className="learning-icon"><ArrowLeft size={18} /></span><h3>{t.learn}</h3><ol>{t.learning.map((item) => <li key={item}>{item}</li>)}</ol></div>
      </section>
    </div>
  );
}
