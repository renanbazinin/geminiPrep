import { ArrowUpRight, Clock3, Globe2, Layers3, MapPinned } from "lucide-react";
import { Link } from "react-router-dom";
import { TestLanguageToggle } from "../components/TestLanguageToggle";
import { useTestLanguage } from "../contexts/TestLanguageContext";

const copy = {
  en: {
    eyebrow: "EXPERIMENT LIBRARY",
    title: "Tests",
    intro: "Focused, repeatable experiments for understanding Vertex AI behavior—not just whether an API call passed.",
    choose: "Choose an experiment",
    regionTitle: "Regions",
    regionDescription: "Map Gemini publisher models across global, multi-region, and regional Vertex endpoints.",
    regionDetails: ["Real generateContent calls", "Availability verdict matrix", "Latency and provider evidence"],
    cacheTitle: "Context cache",
    cacheDescription: "See implicit prefix hits, then create a Gemini 3 explicit cache, control its TTL, use it, and prove the cache hit.",
    cacheDetails: ["Implicit prefix probe", "Gemini 3 explicit caching", "cachedContentTokenCount evidence"],
    live: "Live API",
    guide: "Bilingual guide",
    open: "Open experiment",
    noteTitle: "Tests can consume quota",
    note: "Every experiment clearly marks actions that call Google APIs. Cache storage can continue billing until deletion or expiry.",
  },
  he: {
    eyebrow: "ספריית ניסויים",
    title: "בדיקות",
    intro: "ניסויים ממוקדים וחוזרים להבנת ההתנהגות של Vertex AI — לא רק כדי לראות אם קריאת API הצליחה.",
    choose: "בחירת ניסוי",
    regionTitle: "אזורים",
    regionDescription: "מיפוי מודלי Gemini בין נקודות קצה גלובליות, רב־אזוריות ואזוריות של Vertex.",
    regionDetails: ["קריאות generateContent אמיתיות", "מטריצת זמינות מפורטת", "זמן תגובה וראיות מהספק"],
    cacheTitle: "מטמון הקשר",
    cacheDescription: "צפייה בפגיעות קידומת משתמעות, ואז יצירת מטמון מפורש ל־Gemini 3, שליטה ב־TTL, שימוש והוכחת הפגיעה.",
    cacheDetails: ["בדיקת קידומת משתמע", "מטמון מפורש ב־Gemini 3", "הוכחה באמצעות cachedContentTokenCount"],
    live: "API חי",
    guide: "מדריך דו־לשוני",
    open: "פתיחת הניסוי",
    noteTitle: "בדיקות עשויות לצרוך מכסה",
    note: "כל ניסוי מסמן בבירור פעולות שקוראות ל־Google APIs. אחסון מטמון יכול להמשיך להיות מחויב עד למחיקה או לפקיעה.",
  },
} as const;

export function TestsPage() {
  const { language, direction } = useTestLanguage();
  const t = copy[language];
  return (
    <div className="route-page tests-hub" dir={direction} lang={language}>
      <header className="page-heading tests-heading">
        <div>
          <p className="eyebrow">{t.eyebrow}</p>
          <h1>{t.title}</h1>
          <p>{t.intro}</p>
        </div>
        <TestLanguageToggle />
      </header>

      <div className="tests-section-label">{t.choose}</div>
      <div className="test-card-grid">
        <Link className="test-card" to="/tests/regions">
          <div className="test-card-top">
            <span className="test-card-icon"><MapPinned size={23} /></span>
            <span className="test-card-number">01</span>
          </div>
          <h2>{t.regionTitle}</h2>
          <p>{t.regionDescription}</p>
          <ul>{t.regionDetails.map((detail) => <li key={detail}>{detail}</li>)}</ul>
          <div className="test-card-footer">
            <span><Globe2 size={14} /> {t.live}</span>
            <span><Layers3 size={14} /> {t.guide}</span>
            <strong>{t.open} <ArrowUpRight size={15} /></strong>
          </div>
        </Link>

        <Link className="test-card test-card-cache" to="/tests/cache">
          <div className="test-card-top">
            <span className="test-card-icon"><Layers3 size={23} /></span>
            <span className="test-card-number">02</span>
          </div>
          <h2>{t.cacheTitle}</h2>
          <p>{t.cacheDescription}</p>
          <ul>{t.cacheDetails.map((detail) => <li key={detail}>{detail}</li>)}</ul>
          <div className="test-card-footer">
            <span><Clock3 size={14} /> TTL</span>
            <span><Layers3 size={14} /> {t.guide}</span>
            <strong>{t.open} <ArrowUpRight size={15} /></strong>
          </div>
        </Link>
      </div>

      <div className="tests-quota-note">
        <strong>{t.noteTitle}</strong>
        <p>{t.note}</p>
      </div>
    </div>
  );
}
