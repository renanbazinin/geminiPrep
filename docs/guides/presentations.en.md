# Presentations and Template Studio

Gemini Prep makes PowerPoint decks with the [`slotdeck`](https://www.npmjs.com/package/slotdeck)
package. A template is an ordinary .pptx of sample slides. slotdeck clones those slides and fills
the shapes marked as slots, so logo, backgrounds, fonts and decorations are never redrawn. A model
decides what goes on each slide; the code does the drawing.

There are two parts:

- **The presentation tools in the chat** (`/`): plan a deck, create it, change it.
- **Template Studio** (`/templates`): turn a .pptx into a template.

## Make a deck in the chat

1. Open the composer's tools menu and pick **Make a presentation**. The tool stays on until you
   switch it off. With the Generate Content API and tools on Auto you can also just ask for a deck:
   Gemini hands the turn to the presentation tools by itself. With the Interactions API, pick the
   tool.
2. Say what the deck is about, with every fact, figure and name it should hold. Attached files
   count: their text is part of the conversation.
3. Gemini answers with a **plan**: a card that lists the slides, each with its layout drawn as
   boxes and the point it makes. Nothing is written yet.
4. Press **Create presentation**, or say what to change in the plan ("add a slide that compares
   the three options in a table").
5. The created deck appears as a card with a **Download** button. Ask for changes in words:
   "shorten slide 3", "make the text larger", "translate it to Hebrew". Only the slides a change
   touches are rewritten, and every change makes a new file; earlier ones stay.

What Gemini is told and what it is not:

| | Goes to a model | Stays on the server |
|---|---|---|
| Chat model | The conversation, and for each tool call a small result: an id, the title, one line per slide | Deck JSON, pictures, the pptx |
| slotdeck's planning model | The brief, the template's layouts with their slot limits, descriptions of the icons | Pictures, the pptx |
| Image model | One description per photo | Everything else |

A plan or deck from an earlier turn reaches the chat model again as a note after that turn's text
(`[presentation tool result] {…}`), which is how it knows the id to create or change. The browser
keeps that note with the message; it is not shown.

Numbers the brief does not state do not get onto slides: layouts built around figures are offered
only when the brief has figures. Names and contact details are not guarded, so read the closing
slide.

## Make a template in Template Studio

1. **Upload** a .pptx of sample slides and give it a name.
2. **Draft** its layouts. The model picked in the chat gets one call about the deck and one per
   slide. It reads the shapes as measured from the file — id, kind, position, size, font size,
   sample text — and answers whether the slide is a reusable layout and what each shape is for.
   **No picture of a slide is sent.** Slides it leaves out are listed with the reason.
3. **Review** each slide. The slide is drawn as boxes: what a deck fills is coloured by kind, the
   rest of the design is grey. This is not a picture of the slide (the app has no renderer for
   PowerPoint); it shows where things go. Click a shape to see what it is in the layout, and:
   - make it a slot (title, text, list, number, caption, photo, icon, graphic, chart, table), or
     a decoration that is always removed, or part of the design again;
   - set what happens when a deck gives nothing: required, optional, keep the template's own, or
     always removed;
   - rename it, or set its limits (characters, paragraphs, table rows and columns).
   For a layout: its id, the sentence that tells the planner when to use it, whether it is built
   around numbers, and how many items a row of cards may hold.
4. **Change it in words** when that is quicker: "make the subtitle optional on every layout",
   "let the cards take two to five". The model answers with the same small operations the
   controls send, and the code checks each against the .pptx. What cannot work is refused with
   the reason ("5 cards do not fit side by side … The most is 4").
5. **Sample deck** downloads a deck with every layout once and every slot filled close to its
   budget, in the template's own filler words. Text that overflows there will overflow in real
   decks: lower that slot's character budget.
6. **Use in chat** makes it the template the presentation tools use in this browser.

**Deck fields** are texts that are the same on every slide of a deck, such as the line beside the
logo. Give them a value in the studio; left empty, decks get the template's own text.

A shape that takes its position from a layout placeholder, without stating it on the slide, is
measured as empty. It is listed under the slide ("without a position of their own") and can still
be made a slot, but its budget is only as long as its sample text. Decks exported from Google
Slides, and decks built from free-standing text boxes, work as they are.

## Where things are kept

| What | Where |
|---|---|
| Templates shipped with the app | `presentation-templates/<id>/` in the repository: `template.pptx`, `manifest.json`, optional `meta.json` (name, deck fields) and `icons/` |
| The icon set decks pick from | `presentation-templates/icons/` (`icons.json` and one PNG per icon) |
| Templates made in the studio | `PRESENTATIONS_DIR/templates/<id>/` (default `.data/presentations`) |
| Plans, decks, pictures, files | `PRESENTATIONS_DIR/decks/<template id>/` — `plan/`, `deck/`, `asset/`, `pptx/` |

Shipped templates are read-only in the studio: **Duplicate** one to change it.

On Cloud Run the disk belongs to one instance and is lost when it restarts, so studio templates
and created decks do not survive a deploy. To keep a template, download its manifest and add the
folder to `presentation-templates/` (the .pptx as `template.pptx`, the manifest as
`manifest.json`); it then ships with the image. Cloud Run also limits an upload to 30 MB.

Nothing removes old decks. A deck with photos is a few megabytes; clear
`PRESENTATIONS_DIR/decks` when the disk matters.

## Models

- **Text.** slotdeck's Gemini adapter calls the Interactions API with the chat's provider and
  model (or `PRESENTATIONS_MODEL`). On Vertex AI that API has only the global endpoint, so the
  chat's region does not apply to these calls. The chat model's own tool loop runs on Generate
  Content, whichever chat API is selected, like the large-file tools.
- **Photos.** One call to `gemini-3.1-flash-image` per photo. On the Gemini API this is slotdeck's
  image adapter (Interactions). On Vertex AI the Interactions API does not serve the image model
  (`Model 'gemini-3.1-flash-image' is not supported by the Interactions API`), so the app calls
  Generate Content with `imageConfig: { aspectRatio, imageSize }` instead
  (`server/presentations/models.ts`). `PRESENTATIONS_PHOTOS=0` turns photos off.
- **Icons** are not generated: the planner picks from the registered set by description.

Settings are the `PRESENTATIONS_*` variables in `.env.example`.

## What was run live (13 November 2026)

| Check | Gemini API | Vertex AI |
|---|---|---|
| Plan, create, change a deck (`gemini-3.8-flash`) | worked | worked |
| Plan with the Gemini 4 switch on (`gemini-4-argon`) | worked | not run |
| Photo in a deck | adapter returned a JPEG in a direct call; not run inside a deck | worked, 1K PNG of about 2 MB |
| Tools on Auto hand the turn over (Generate Content) | not run | worked, for the plan and for the approval |
| Draft a 13-slide template (14 calls, text only) | worked, all 13 slides became layouts | not run |
| Change a manifest by instruction | not run | worked |

Created decks were opened with PowerPoint on Windows and looked right. Other viewers were not
tried. Automated tests script both models and spend no quota.

## Code map

| File | What it does |
|---|---|
| `server/presentations/chat.ts` | The chat model's tool loop, and the plan and deck cards sent to the browser |
| `server/presentations/templates.ts` | The template library on disk |
| `server/presentations/models.ts` | The text model and photo source for a provider |
| `server/presentations/routes.ts` | Template Studio's API (`/api/presentations/templates…`) and deck downloads |
| `shared/chat-tools.ts` | The `make_presentation` handoff for tools on Auto, and the history note |
| `src/components/PresentationCards.tsx`, `SlideWireframe.tsx` | The cards in the chat and the layout drawings |
| `src/template-studio/` | The studio pages |
