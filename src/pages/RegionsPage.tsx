import { Check, ChevronLeft, Clipboard, ExternalLink, Info, Play, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  ModelOption,
  RegionCell,
  RegionOption,
  RegionRollup,
  RegionSummary,
  RegionTestConfig,
  RegionVerdict,
} from "../../shared/contracts";
import { fetchRegionConfig } from "../lib/api";
import { TestLanguageToggle } from "../components/TestLanguageToggle";
import { useTestLanguage } from "../contexts/TestLanguageContext";

const copy = {
  en: {
    back: "All tests", eyebrow: "LIVE VERTEX AI PROBE", title: "Regions test",
    intro: "Discover which publisher models respond from each Vertex endpoint using real, minimal generation calls.",
    guide: "Read test guide",
    info: "A quota response still proves the model exists in that region. Authentication and project configuration problems are reported separately from model availability.",
    choose: "Choose targets", chooseHelp: "Every selected model is tested against every selected region.", calls: "calls",
    project: "Google Cloud project", projectEnv: "Loaded from the local server environment.", projectMissing: "No project was found in the server environment.",
    regions: "Regions", models: "Models", selected: "selected", run: "Run", running: "Running", probes: "probes",
    results: "Results", resultsHelp: "Click any cell for the endpoint, status, latency, and provider message.",
    copyMarkdown: "Copy Markdown", copied: "Copied", available: "Available", notServed: "Not served", denied: "Denied", timeout: "Timeout", elapsed: "Elapsed",
    rollup: "Available regions per model", none: "None in this selection", http: "HTTP status", latency: "Latency", retried: "Retried", yes: "Yes", no: "No", noResponse: "No response", endpoint: "Endpoint", providerMessage: "Provider message", close: "Close details",
    groups: { global: "Global", eu: "Europe", us: "United States", asia: "Asia Pacific", other: "Other" },
    families: { "3.x": "Gemini 3", "2.5": "Gemini 2.5", image: "Flash Image", other: "Other" },
    verdicts: { available: "Available", quota: "Quota hit — model exists", unavailable: "Not served here", denied: "Permission denied", timeout: "Timed out", error: "Error" },
  },
  he: {
    back: "כל הבדיקות", eyebrow: "בדיקת VERTEX AI חיה", title: "בדיקת אזורים",
    intro: "גלה אילו מודלים מגיבים מכל נקודת קצה של Vertex באמצעות קריאות יצירה אמיתיות ומינימליות.",
    guide: "פתיחת מדריך הבדיקה",
    info: "תגובת מכסה עדיין מוכיחה שהמודל קיים באזור. בעיות אימות והגדרת פרויקט מוצגות בנפרד מזמינות המודל.",
    choose: "בחירת יעדים", chooseHelp: "כל מודל שנבחר נבדק מול כל אזור שנבחר.", calls: "קריאות",
    project: "פרויקט Google Cloud", projectEnv: "נטען מסביבת השרת המקומית.", projectMissing: "לא נמצא פרויקט בסביבת השרת.",
    regions: "אזורים", models: "מודלים", selected: "נבחרו", run: "הרצת", running: "מריצה", probes: "בדיקות",
    results: "תוצאות", resultsHelp: "לחץ על תא כדי לראות נקודת קצה, סטטוס, זמן תגובה והודעת ספק.",
    copyMarkdown: "העתקת Markdown", copied: "הועתק", available: "זמין", notServed: "לא מוגש", denied: "נדחה", timeout: "חריגה מהזמן", elapsed: "משך",
    rollup: "אזורים זמינים לפי מודל", none: "אין באזורי הבחירה", http: "סטטוס HTTP", latency: "זמן תגובה", retried: "ניסיון חוזר", yes: "כן", no: "לא", noResponse: "אין תגובה", endpoint: "נקודת קצה", providerMessage: "הודעת הספק", close: "סגירת פרטים",
    groups: { global: "גלובלי", eu: "אירופה", us: "ארצות הברית", asia: "אסיה והפסיפיק", other: "אחר" },
    families: { "3.x": "Gemini 3", "2.5": "Gemini 2.5", image: "Flash Image", other: "אחר" },
    verdicts: { available: "זמין", quota: "מכסה — המודל קיים", unavailable: "לא מוגש כאן", denied: "הרשאה נדחתה", timeout: "חריגה מהזמן", error: "שגיאה" },
  },
} as const;

const VERDICT_MARK: Record<RegionVerdict, string> = {
  available: "✓",
  quota: "~",
  unavailable: "·",
  denied: "×",
  timeout: "◷",
  error: "!",
};

type RunResult = {
  project: string;
  elapsedMs: number;
  regions: RegionOption[];
  models: ModelOption[];
  cells: RegionCell[];
  rollup: RegionRollup[];
  summary: RegionSummary;
};

export function RegionsPage() {
  const { language, direction } = useTestLanguage();
  const t = copy[language];
  const [config, setConfig] = useState<RegionTestConfig | null>(null);
  const [project, setProject] = useState("");
  const [regionIds, setRegionIds] = useState<Set<string>>(new Set());
  const [modelIds, setModelIds] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<RunResult | null>(null);
  const [selectedCell, setSelectedCell] = useState<RegionCell | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetchRegionConfig(controller.signal)
      .then((value) => {
        setConfig(value);
        setRegionIds(new Set(value.defaultRegionIds));
        setModelIds(new Set(value.models.map((model) => model.id)));
        setProject(value.project ?? "");
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingConfig(false);
      });
    return () => controller.abort();
  }, []);

  const groupedRegions = useMemo(() => {
    const groups = new Map<string, RegionOption[]>();
    for (const region of config?.regions ?? []) {
      groups.set(region.group, [...(groups.get(region.group) ?? []), region]);
    }
    return [...groups.entries()];
  }, [config]);
  const groupedModels = useMemo(() => {
    const groups = new Map<string, ModelOption[]>();
    for (const model of config?.models ?? []) {
      groups.set(model.family, [...(groups.get(model.family) ?? []), model]);
    }
    return [...groups.entries()];
  }, [config]);

  const shownRegions = useMemo(
    () => (result?.regions ?? config?.regions ?? []).filter((region) => regionIds.has(region.id)),
    [config, regionIds, result],
  );
  const shownModels = useMemo(
    () => (result?.models ?? config?.models ?? []).filter((model) => modelIds.has(model.id)),
    [config, modelIds, result],
  );
  const cellIndex = useMemo(
    () => new Map((result?.cells ?? []).map((cell) => [`${cell.modelId}|${cell.regionId}`, cell])),
    [result],
  );
  const pairCount = regionIds.size * modelIds.size;

  function toggle(current: Set<string>, setCurrent: (value: Set<string>) => void, id: string) {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    setCurrent(next);
    setResult(null);
  }

  async function runTest() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/tests/regions/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: project.trim(), regions: [...regionIds], models: [...modelIds] }),
      });
      const data = await response.json() as RunResult & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `Test failed (${response.status}).`);
      setResult(data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunning(false);
    }
  }

  async function copyMarkdown() {
    const header = `| Model | ${shownRegions.map((region) => region.id).join(" | ")} |`;
    const divider = `| --- | ${shownRegions.map(() => "---").join(" | ")} |`;
    const rows = shownModels.map((model) => {
      const marks = shownRegions.map((region) => {
        const cell = cellIndex.get(`${model.id}|${region.id}`);
        return cell && (cell.verdict === "available" || cell.verdict === "quota") ? "✓" : "";
      });
      return `| \`${model.id}\` | ${marks.join(" | ")} |`;
    });
    await navigator.clipboard.writeText([header, divider, ...rows].join("\n"));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <div className="route-page regions-page" dir={direction} lang={language}>
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
        <a className="secondary-button" href={`/docs/tests/regions.${language}.md`} target="_blank" rel="noreferrer">
          {t.guide} <ExternalLink size={15} />
        </a>
      </header>

      <div className="info-banner">
        <Info size={18} />
        <p>
          {t.info}
        </p>
      </div>

      <section className="test-panel">
        <div className="test-panel-heading">
          <div><span className="step-number">1</span><div><h2>{t.choose}</h2><p>{t.chooseHelp}</p></div></div>
          <span className="pair-count">{pairCount} {t.calls}</span>
        </div>

        <label className="form-field project-field">
          <span>{t.project}</span>
          <input
            value={project}
            onChange={(event) => setProject(event.target.value)}
            placeholder="my-project-id"
            disabled={running || Boolean(config?.project)}
          />
          <small>{config?.project ? t.projectEnv : t.projectMissing}</small>
        </label>

        <div className="picker-columns">
          <div>
            <div className="picker-title"><span>{t.regions}</span><small>{regionIds.size} {t.selected}</small></div>
            <div className="region-groups">
              {groupedRegions.map(([group, regions]) => (
                <div className="region-group" key={group}>
                  <span>{t.groups[group as keyof typeof t.groups] ?? group}</span>
                  <div className="chip-list">
                    {regions.map((region) => (
                      <label className={`select-chip${regionIds.has(region.id) ? " select-chip-on" : ""}`} key={region.id}>
                        <input
                          type="checkbox"
                          checked={regionIds.has(region.id)}
                          onChange={() => toggle(regionIds, setRegionIds, region.id)}
                          disabled={running}
                        />
                        {region.id}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="picker-title"><span>{t.models}</span><small>{modelIds.size} {t.selected}</small></div>
            <div className="model-picker">
              {groupedModels.map(([family, models]) => (
                <div className="region-group" key={family}>
                  <span>{t.families[family as keyof typeof t.families] ?? family}</span>
                  {models.map((model) => (
                    <label className={`model-check${modelIds.has(model.id) ? " model-check-on" : ""}`} key={model.id}>
                      <input
                        type="checkbox"
                        checked={modelIds.has(model.id)}
                        onChange={() => toggle(modelIds, setModelIds, model.id)}
                        disabled={running}
                      />
                      <span><strong>{model.label}</strong><small>{model.id}</small></span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>

        <button
          className="primary-button run-test-button"
          onClick={() => void runTest()}
          disabled={loadingConfig || running || pairCount === 0 || !project.trim()}
        >
          <Play size={17} fill="currentColor" />
          {running ? `${t.running} ${pairCount} ${t.probes}…` : `${t.run} ${pairCount} ${t.probes}`}
        </button>
      </section>

      {error ? <div className="panel-error" role="alert">{error}</div> : null}

      {result ? (
        <section className="test-panel results-panel">
          <div className="test-panel-heading">
            <div><span className="step-number">2</span><div><h2>{t.results}</h2><p>{t.resultsHelp}</p></div></div>
            <button className="secondary-button" onClick={() => void copyMarkdown()}>
              {copied ? <Check size={15} /> : <Clipboard size={15} />}{copied ? t.copied : t.copyMarkdown}
            </button>
          </div>

          <div className="result-stats">
            <div><strong>{result.summary.available}</strong><span>{t.available}</span></div>
            <div><strong>{result.summary.unavailable}</strong><span>{t.notServed}</span></div>
            <div><strong>{result.summary.denied}</strong><span>{t.denied}</span></div>
            <div><strong>{result.summary.timeout}</strong><span>{t.timeout}</span></div>
            <div><strong>{(result.elapsedMs / 1000).toFixed(1)}s</strong><span>{t.elapsed}</span></div>
          </div>

          <div className="matrix-scroll">
            <table className="region-matrix">
              <thead><tr><th className="matrix-sticky">Model</th>{shownRegions.map((region) => <th key={region.id} title={region.label}>{region.id}</th>)}</tr></thead>
              <tbody>
                {shownModels.map((model) => (
                  <tr key={model.id}>
                    <th className="matrix-sticky" title={model.label}>{model.id}</th>
                    {shownRegions.map((region) => {
                      const cell = cellIndex.get(`${model.id}|${region.id}`);
                      return (
                        <td key={region.id}>
                          {cell ? (
                            <button
                              className={`matrix-cell cell-${cell.verdict}`}
                              onClick={() => setSelectedCell(cell)}
                              aria-label={`${model.id} · ${region.id}: ${t.verdicts[cell.verdict]}`}
                            >
                              {VERDICT_MARK[cell.verdict]}
                            </button>
                          ) : "—"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="matrix-legend">
            {(Object.keys(t.verdicts) as RegionVerdict[]).map((verdict) => (
              <span key={verdict}><i className={`cell-${verdict}`}>{VERDICT_MARK[verdict]}</i>{t.verdicts[verdict]}</span>
            ))}
          </div>

          <div className="rollup-grid">
            <h3>{t.rollup}</h3>
            {result.rollup.map((row) => (
              <div className="rollup-row" key={row.modelId}>
                <code>{row.modelId}</code>
                <span>{row.available.length > 0 ? row.available.join(", ") : t.none}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {selectedCell ? (
        <div className="cell-dialog-backdrop" role="presentation" onMouseDown={() => setSelectedCell(null)}>
          <section className="cell-dialog" role="dialog" aria-modal="true" aria-labelledby="cell-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="icon-button dialog-close" onClick={() => setSelectedCell(null)} aria-label={t.close}><X size={18} /></button>
            <span className={`verdict-badge cell-${selectedCell.verdict}`}>{VERDICT_MARK[selectedCell.verdict]} {t.verdicts[selectedCell.verdict]}</span>
            <h2 id="cell-dialog-title">{selectedCell.modelId}</h2>
            <p className="dialog-region">{selectedCell.regionId}</p>
            <dl className="cell-facts">
              <div><dt>{t.http}</dt><dd>{selectedCell.status || t.noResponse}</dd></div>
              <div><dt>{t.latency}</dt><dd>{selectedCell.latencyMs.toLocaleString()} ms</dd></div>
              <div><dt>{t.retried}</dt><dd>{selectedCell.retried ? t.yes : t.no}</dd></div>
            </dl>
            <label className="detail-label">{t.endpoint}</label>
            <code className="detail-code">{selectedCell.url}</code>
            {selectedCell.message ? <><label className="detail-label">{t.providerMessage}</label><pre className="detail-message">{selectedCell.message}</pre></> : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}
