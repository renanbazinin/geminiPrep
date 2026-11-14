import type {
  DraftProgress,
  ManifestChange,
  ManifestChangeOutcome,
  PresentationTemplateDetail,
  PresentationTemplateSummary,
  StudioModelChoice,
  TemplateLayouts,
  VariantOption,
} from "../../shared/presentations";

const API = "/api/presentations";

async function responseError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Request failed (${response.status}).`;
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<T>;
}

function post(body: unknown, signal?: AbortSignal): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...(signal ? { signal } : {}) };
}

export type TemplateList = {
  templates: PresentationTemplateSummary[];
  /** The template the chat uses when this browser has not chosen one. */
  defaultTemplate: string;
  /** Whether decks get generated photos. */
  photos: boolean;
  /** Whether the server draws pictures of slides. Without them, layouts are drawn as boxes. */
  pictures?: boolean;
};

export async function fetchTemplates(signal?: AbortSignal): Promise<TemplateList> {
  return json(await fetch(`${API}/templates`, { signal }));
}

export async function fetchTemplate(id: string, signal?: AbortSignal): Promise<PresentationTemplateDetail> {
  return json(await fetch(`${API}/templates/${encodeURIComponent(id)}`, { signal }));
}

/** Uploads a pptx as a new template. It has no layouts until it is drafted. */
export async function uploadTemplate(file: File, name: string): Promise<PresentationTemplateDetail> {
  return json(await fetch(`${API}/templates`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
      "X-Template-Name": encodeURIComponent(name),
    },
    body: file,
  }));
}

export async function deleteTemplate(id: string): Promise<void> {
  await json(await fetch(`${API}/templates/${encodeURIComponent(id)}`, { method: "DELETE" }));
  layoutCache.delete(id);
}

export async function duplicateTemplate(id: string, name: string): Promise<PresentationTemplateDetail> {
  return json(await fetch(`${API}/templates/${encodeURIComponent(id)}/duplicate`, post({ name })));
}

/**
 * Has a model draft the template's manifest: which slides are layouts and what each shape is
 * for. The server reports each slide as it is done.
 */
export async function draftTemplate(
  id: string,
  choice: StudioModelChoice,
  onProgress: (progress: DraftProgress) => void,
  signal?: AbortSignal,
): Promise<PresentationTemplateDetail> {
  const response = await fetch(`${API}/templates/${encodeURIComponent(id)}/draft`, post(choice, signal));
  if (!response.ok) throw new Error(await responseError(response));
  if (!response.body) throw new Error("The server returned an empty stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: PresentationTemplateDetail | undefined;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      if (done && buffer.trim()) buffer += "\n\n";
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = block.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
        const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (event && data) {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          if (event === "progress") onProgress(parsed as DraftProgress);
          if (event === "result") result = parsed as unknown as PresentationTemplateDetail;
          if (event === "error") throw new Error(typeof parsed.message === "string" ? parsed.message : "The draft failed.");
        }
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!result) throw new Error("The draft ended before it was finished.");
  layoutCache.delete(id);
  return result;
}

export async function changeTemplate(id: string, changes: ManifestChange[]): Promise<ManifestChangeOutcome> {
  const outcome = await json<ManifestChangeOutcome>(await fetch(`${API}/templates/${encodeURIComponent(id)}/changes`, post({ changes })));
  layoutCache.delete(id);
  return outcome;
}

export async function instructTemplate(id: string, instruction: string, choice: StudioModelChoice, signal?: AbortSignal): Promise<ManifestChangeOutcome> {
  const outcome = await json<ManifestChangeOutcome>(await fetch(`${API}/templates/${encodeURIComponent(id)}/instruct`, post({ ...choice, instruction }, signal)));
  layoutCache.delete(id);
  return outcome;
}

export async function saveTemplateFields(id: string, fields: Record<string, string>): Promise<PresentationTemplateDetail> {
  return json(await fetch(`${API}/templates/${encodeURIComponent(id)}/fields`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  }));
}

/** Saves a whole manifest: one edited as JSON, or read from a file. */
export async function saveTemplateManifest(id: string, manifest: unknown): Promise<PresentationTemplateDetail> {
  const saved = await json<PresentationTemplateDetail>(await fetch(`${API}/templates/${encodeURIComponent(id)}/manifest`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(manifest),
  }));
  layoutCache.delete(id);
  return saved;
}

/** Puts another pptx in a template's place; its manifest is kept. */
export async function replaceTemplatePptx(id: string, file: File): Promise<PresentationTemplateDetail> {
  const saved = await json<PresentationTemplateDetail>(await fetch(`${API}/templates/${encodeURIComponent(id)}/pptx`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
    body: file,
  }));
  layoutCache.delete(id);
  return saved;
}

/** The variants the code can derive from a layout, each with what it would do or why it cannot. */
export async function fetchPatternVariants(id: string, pattern: string, signal?: AbortSignal): Promise<VariantOption[]> {
  const result = await json<{ variants: VariantOption[] }>(await fetch(
    `${API}/templates/${encodeURIComponent(id)}/patterns/${encodeURIComponent(pattern)}/variants`,
    { signal },
  ));
  return result.variants;
}

export function templateFileUrl(id: string, file: "manifest.json" | "template.pptx" | "sample.pptx", query = ""): string {
  return `${API}/templates/${encodeURIComponent(id)}/${file}${query}`;
}

/**
 * Where the server's picture of a template slide is. `version` is anything that changes with the
 * template (its last change), so a browser shows the new picture after one.
 */
export function templateSlideUrl(id: string, slide: number, version = ""): string {
  return `${API}/templates/${encodeURIComponent(id)}/slides/${slide}.svg${version ? `?v=${encodeURIComponent(version)}` : ""}`;
}

/** Where the picture of a layout is: the layout with the template's filler words in its slots. */
export function templateLayoutUrl(id: string, pattern: string, version = ""): string {
  return `${API}/templates/${encodeURIComponent(id)}/patterns/${encodeURIComponent(pattern)}.svg${version ? `?v=${encodeURIComponent(version)}` : ""}`;
}

/** Where the picture of a slide of a created deck is, from the address of its file. */
export function deckSlideUrl(file: string, slide: number): string {
  return `${file.replace(/\.pptx$/, "")}/slides/${slide}.svg`;
}

const layoutCache = new Map<string, Promise<TemplateLayouts>>();

/** A template's layouts as boxes, for drawing a plan's slides. Kept for the page's lifetime. */
export function fetchTemplateLayouts(id: string): Promise<TemplateLayouts> {
  let layouts = layoutCache.get(id);
  if (!layouts) {
    layouts = fetch(`${API}/templates/${encodeURIComponent(id)}/layouts`).then((response) => json<TemplateLayouts>(response));
    // A failed load is tried again the next time a card asks.
    layouts.catch(() => layoutCache.delete(id));
    layoutCache.set(id, layouts);
  }
  return layouts;
}
