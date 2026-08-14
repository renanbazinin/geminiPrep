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
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  CacheContentMode,
  CacheExpirationMode,
  CacheTestConfig,
  CacheUseResult,
  CachedContentResource,
} from "../../shared/contracts";
import { MarkdownMessage } from "../components/MarkdownMessage";
import { TestLanguageToggle } from "../components/TestLanguageToggle";
import { useTestLanguage } from "../contexts/TestLanguageContext";

const copy = {
  en: {
    back: "All tests", eyebrow: "GEMINI 3 · EXPLICIT CONTEXT CACHE", title: "Context cache lab",
    intro: "Create a real Vertex cache, inspect what the service stores, change its expiration, then use it and verify the cached token count.",
    guide: "Read cache guide", warningTitle: "Explicit cache storage is billable", warning: "Creation and use call Vertex AI. Storage continues until you delete the cache or it expires.",
    config: "Configure the cache", configHelp: "Model, content, instructions, display name, and encryption are immutable after creation.",
    project: "Google Cloud project", model: "Gemini 3 model", location: "Location", displayName: "Display name", immutable: "immutable",
    system: "System instruction", systemPlaceholder: "Optional instruction shared by every request that uses this cache…",
    contentSource: "Cached content source", text: "Inline text", gcs: "Cloud Storage file", cachedText: "Text to cache", gcsUri: "GCS URI", mimeType: "MIME type",
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
  },
  he: {
    back: "כל הבדיקות", eyebrow: "GEMINI 3 · מטמון הקשר מפורש", title: "מעבדת מטמון הקשר",
    intro: "צור מטמון אמיתי ב־Vertex, בדוק מה השירות שומר, שנה את זמן הפקיעה, השתמש בו ואמת את מספר הטוקנים שנקראו מהמטמון.",
    guide: "פתיחת מדריך המטמון", warningTitle: "אחסון מטמון מפורש כרוך בחיוב", warning: "יצירה ושימוש קוראים ל־Vertex AI. האחסון ממשיך עד למחיקה או לפקיעה.",
    config: "הגדרת המטמון", configHelp: "המודל, התוכן, ההוראה, השם וההצפנה אינם ניתנים לשינוי אחרי היצירה.",
    project: "פרויקט Google Cloud", model: "מודל Gemini 3", location: "מיקום", displayName: "שם תצוגה", immutable: "בלתי ניתן לשינוי",
    system: "הוראת מערכת", systemPlaceholder: "הוראה אופציונלית המשותפת לכל בקשה שמשתמשת במטמון…",
    contentSource: "מקור התוכן למטמון", text: "טקסט מוטמע", gcs: "קובץ Cloud Storage", cachedText: "טקסט למטמון", gcsUri: "כתובת GCS", mimeType: "סוג MIME",
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
  },
} as const;

function defaultDisplayName(): string {
  return `gemini-prep-${new Date().toISOString().slice(0, 10)}`;
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
  const sections = Array.from({ length: 105 }, (_, index) => language === "he"
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
  const t = copy[language];
  const [config, setConfig] = useState<CacheTestConfig | null>(null);
  const [project, setProject] = useState("");
  const [model, setModel] = useState("");
  const [region, setRegion] = useState("global");
  const [displayName, setDisplayName] = useState(defaultDisplayName);
  const [systemInstruction, setSystemInstruction] = useState("");
  const [contentMode, setContentMode] = useState<CacheContentMode>("text");
  const [content, setContent] = useState("");
  const [gcsUri, setGcsUri] = useState("");
  const [mimeType, setMimeType] = useState("application/pdf");
  const [expirationMode, setExpirationMode] = useState<CacheExpirationMode>("ttl");
  const [ttlSeconds, setTtlSeconds] = useState(3600);
  const [expireTime, setExpireTime] = useState(() => localDateTime());
  const [kmsKeyName, setKmsKeyName] = useState("");
  const [resource, setResource] = useState<CachedContentResource | null>(null);
  const [caches, setCaches] = useState<CachedContentResource[] | null>(null);
  const [prompt, setPrompt] = useState(language === "he" ? "מהי תדירות בדיקת העלויות?" : "How often must service owners review cost?");
  const [useResult, setUseResult] = useState<CacheUseResult | null>(null);
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
  }, [language]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const estimatedTokens = contentMode === "text" ? Math.ceil(content.length / 4) : null;
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
    contents: contentMode === "text"
      ? [{ role: "user", parts: [{ text: content ? `${content.slice(0, 180)}${content.length > 180 ? "…" : ""}` : "…" }] }]
      : [{ role: "user", parts: [{ fileData: { fileUri: gcsUri || "gs://…", mimeType } }] }],
    ...(expirationMode === "ttl" ? { ttl: `${ttlSeconds}s` } : { expireTime: normalizedExpireTime }),
    ...(kmsKeyName ? { encryptionSpec: { kmsKeyName } } : {}),
  }), [content, contentMode, displayName, expirationMode, gcsUri, kmsKeyName, mimeType, model, normalizedExpireTime, project, region, systemInstruction, ttlSeconds]);

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
        contentMode,
        content,
        gcsUri,
        mimeType,
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
        maxOutputTokens: 512,
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
          <div className="segmented-control">
            <button className={contentMode === "text" ? "active" : ""} onClick={() => setContentMode("text")}>{t.text}</button>
            <button className={contentMode === "gcs" ? "active" : ""} onClick={() => setContentMode("gcs")}>{t.gcs}</button>
          </div>
          {contentMode === "text" ? (
            <>
              <label className="form-field">
                <span>{t.cachedText}</span>
                <textarea className="cache-content-editor" rows={10} value={content} onChange={(event) => setContent(event.target.value)} />
              </label>
              <div className="cache-editor-actions">
                <button className="secondary-button" onClick={() => setContent(sampleContext(language))}><Sparkles size={15} />{t.sample}</button>
                <button className="text-button" onClick={() => setContent("")}>{t.clear}</button>
              </div>
              <div className={`token-meter${estimatedTokens && estimatedTokens >= (config?.limits.minimumTokensGemini3 ?? 4096) ? " token-meter-ready" : ""}`}>
                <div><span>{t.estimate}</span><strong>≈ {estimatedTokens?.toLocaleString()}</strong></div>
                <div><span>{t.minimum}</span><strong>{(config?.limits.minimumTokensGemini3 ?? 4096).toLocaleString()}</strong></div>
                <p>{t.estimateNote}</p>
              </div>
            </>
          ) : (
            <div className="cache-fields-grid">
              <label className="form-field"><span>{t.gcsUri}</span><input value={gcsUri} onChange={(event) => setGcsUri(event.target.value)} placeholder="gs://bucket/path/document.pdf" /></label>
              <label className="form-field"><span>{t.mimeType}</span><input value={mimeType} onChange={(event) => setMimeType(event.target.value)} placeholder="application/pdf" /></label>
            </div>
          )}
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
        <button className="primary-button cache-create-button" onClick={() => void createCache()} disabled={Boolean(busy) || !project || !model || !expirationValid || (contentMode === "text" ? !content : !gcsUri || !mimeType)}>
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
