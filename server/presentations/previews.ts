// Pictures of slides, for a person to look at: a template's own slides, each layout filled
// with sample words, and the slides of a deck the chat made. slotdeck draws nothing itself; it
// calls a PreviewProvider, and the one used here is its adapter for the Pagus library, which
// gives one SVG a slide. The pictures go to the browser only. No model is sent one.
import { createHash } from "node:crypto";
import { pagusPreviews, patternPreviews, type PreviewProvider, type SlidePreview } from "slotdeck";
import { resolvePresentationSettings } from "./config.js";
import type { StoredTemplate, TemplateLibrary } from "./templates.js";

export type Picture = { mimeType: string; data: Buffer };

let pagus: Promise<PreviewProvider | undefined> | undefined;

/**
 * The Pagus provider, loaded when the first picture is asked for, so a server that never shows
 * one does not load the renderer. Undefined when it cannot be loaded: the app then draws boxes.
 */
export function pagusProvider(): Promise<PreviewProvider | undefined> {
  pagus ??= (async () => {
    try {
      const [core, renderer] = await Promise.all([import("@pagus-kit/core"), import("@pagus-kit/renderer")]);
      return pagusPreviews(core as never, renderer as never);
    } catch (error) {
      console.warn("Slide pictures are off: the Pagus renderer could not be loaded.", error instanceof Error ? error.message : error);
      return undefined;
    }
  })();
  return pagus;
}

function picture(preview: SlidePreview | undefined): Picture | undefined {
  return preview ? { mimeType: preview.mimeType, data: Buffer.from(preview.data) } : undefined;
}

/**
 * Draws pictures and keeps the most recent sets: all slides of a pptx are drawn in one go
 * (a fifth of a second for fifteen slides), and a screen then asks for them one by one.
 */
export class SlidePictures {
  private readonly sets = new Map<string, Promise<Map<string, SlidePreview>>>();

  constructor(
    private readonly provider: () => Promise<PreviewProvider | undefined> = () => (resolvePresentationSettings().previews ? pagusProvider() : Promise.resolve(undefined)),
    private readonly limit = 6,
  ) {}

  /** Whether pictures can be drawn at all. */
  async available(): Promise<boolean> {
    return Boolean(await this.provider());
  }

  private async from(key: string, draw: (provider: PreviewProvider) => Promise<Map<string, SlidePreview>>, name: string): Promise<Picture | undefined> {
    let set = this.sets.get(key);
    if (set) {
      // Asked for again: it becomes the newest.
      this.sets.delete(key);
      this.sets.set(key, set);
    } else {
      const provider = await this.provider();
      if (!provider) return undefined;
      set = draw(provider);
      this.sets.set(key, set);
      // A failed drawing is not remembered: the next request tries again.
      set.catch(() => this.sets.delete(key));
      for (const oldest of this.sets.keys()) {
        if (this.sets.size <= this.limit) break;
        this.sets.delete(oldest);
      }
    }
    return picture((await set).get(name));
  }

  /** A slide of the template as its designer left it. */
  templateSlide(library: TemplateLibrary, stored: StoredTemplate, slide: number): Promise<Picture | undefined> {
    return this.from(`slides:${stored.id}:${stored.stamp}`, async (provider) => {
      const previews = await provider.renderSlides({ pptx: await library.pptx(stored) });
      return new Map(previews.map((preview) => [String(preview.slide), preview]));
    }, String(slide));
  }

  /**
   * A layout as a deck will show it, with the template's own filler words in its slots. A
   * layout derived from another one's slide (a mirror image, say) is drawn as itself.
   */
  layout(stored: StoredTemplate, pattern: string): Promise<Picture | undefined> {
    const manifest = createHash("sha1").update(JSON.stringify(stored.template.manifest)).digest("hex");
    return this.from(`layouts:${stored.id}:${stored.stamp}:${manifest}`, async (provider) => (
      new Map(Object.entries(await patternPreviews(stored.template, provider)))
    ), pattern);
  }

  /** A slide of a deck the chat made. A deck's file never changes, so its id is the key. */
  deckSlide(key: string, pptx: Uint8Array, slide: number): Promise<Picture | undefined> {
    return this.from(`deck:${key}`, async (provider) => {
      const previews = await provider.renderSlides({ pptx });
      return new Map(previews.map((preview) => [String(preview.slide), preview]));
    }, String(slide));
  }
}
