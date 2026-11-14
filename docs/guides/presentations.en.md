# Presentations and PPTX Studio

Gemini Prep makes PowerPoint decks with the [`slotdeck`](https://www.npmjs.com/package/slotdeck)
package (0.2.0). A template is an ordinary .pptx of sample slides. slotdeck clones those slides and
fills the shapes marked as slots, so logo, backgrounds, fonts and decorations are never redrawn. A
model decides what goes on each slide; the code does the drawing.

There are two parts:

- **The presentation tools in the chat** (`/`): plan a deck, create it, change it.
- **PPTX Studio** (`/pptx-studio`): where the templates are kept and the manifest of each is
  controlled.

## Make a deck in the chat

1. Open the composer's tools menu and pick **Make a presentation**. The tool stays on until you
   switch it off. With the Generate Content API and tools on Auto you can also just ask for a deck:
   Gemini hands the turn to the presentation tools by itself. With the Interactions API, pick the
   tool.
2. Say what the deck is about, with every fact, figure and name it should hold. Attached files
   count: their text is part of the conversation.
3. Gemini answers with a **plan**: a card that lists the slides, each with a picture of its layout
   and the point it makes. The picture shows the layout with the template's own filler words:
   nothing is written yet.
4. Press **Create presentation**, or say what to change in the plan ("add a slide that compares
   the three options in a table").
5. The created deck appears as a card with pictures of its slides and a **Download** button. A
   picture opens larger in a tab of its own. Ask for changes in words: "shorten slide 3", "make
   the text larger", "translate it to Hebrew". Only the slides a change touches are rewritten, and
   every change makes a new file; earlier ones stay.

"Text only" as a wish is passed on to the planner (`text_only`), which then uses the template's
plain text layouts and no cards, tables or charts. "No photos" leaves those in.

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

## PPTX Studio

### Put a template in

Choose a .pptx of sample slides, and its manifest if it has one (the `manifest.json` that says
which slides are layouts and which shapes are slots). With a manifest the template is ready. Without
one, **draft** it: the model picked in the chat gets one call about the deck and one per slide. It
reads the shapes as measured from the file — id, kind, position, size, font size, sample text — and
answers whether the slide is a reusable layout and what each shape is for. **No picture of a slide
is sent to the model.** Slides it leaves out are listed with the reason.

### Layouts and slots

The studio shows each slide as a picture, with the shapes laid over it. A slot carries its name as
a tag, coloured by kind. Three views:

| View | Shows |
|---|---|
| Template slide | The slide as its designer left it |
| Sample of this layout | The layout as a deck will show it, with filler words in its slots. A layout derived from another one's slide (a mirror image, say) is drawn as itself |
| Boxes only | No picture: the shapes and what they are |

Click a shape to see what it is in the layout, and:

- make it a slot (title, text, list, number, caption, photo, icon, graphic, chart, table), or a
  decoration that is always removed, or part of the design again;
- set what happens when a deck gives nothing: required, optional, keep the template's own, or
  always removed;
- rename it, or set its limits (characters, paragraphs, table rows and columns).

For a layout:

- its id, the sentence that tells the planner when to use it, and whether it is built around
  numbers;
- how many items a row of cards may hold, and **widen**: how far fewer items may grow to fill a
  line drawn for more (`1.5` lets them grow by half);
- **variants the code lays out by itself**, one click each: the mirror image (the picture and what
  sits beside it change sides), a text-only version (the picture is left out and the text widens),
  and a version without an optional text. The ones a slide does not allow are listed with the
  reason. Give a mirrored layout a description that says where its picture is: the planner chooses
  between a layout and its mirror image by their descriptions.

**Change it in words** when that is quicker: "make the subtitle optional on every layout", "add a
mirrored version of the photo slides", "let two cards fill the row". The model answers with the
same small operations the controls send, and the code checks each against the .pptx. What cannot
work is refused with the reason ("5 cards do not fit side by side … The most is 4").

### Manifest and files

The second tab holds the template's two files.

- **manifest.json**, as the JSON it is: read it, change it by hand, or import one from a file, then
  save. A manifest the library cannot read is refused with the first thing that is wrong (`"cover":
  the shapeId of "title" is the shape's id as text, such as "5"`). One that reads and does not
  match the .pptx is kept, and the mismatch appears under Checks, so a half-finished manifest can
  be saved.
- **template.pptx**: download it, or put a newer one in its place. The manifest is kept. Shape ids
  can change when a deck is edited in PowerPoint, and the checks then say which slots lost theirs.

### Checks, sample deck, deck fields

- **Checks** compare the manifest with the .pptx after every change: slides and shapes exist, slots
  point at the right kind of shape, rows are consistent.
- **Sample deck** downloads a deck with every layout once and every slot filled close to its
  budget, in the template's own filler words. Text that overflows there will overflow in real
  decks: lower that slot's character budget.
- **Deck fields** are texts that are the same on every slide of a deck, such as the line beside the
  logo. Give them a value in the studio; left empty, decks get the template's own text.
- **Body text size** enlarges the body text of every deck from the template (`1.3` is 30% larger).
  Budgets shrink to match, so look at the sample deck afterwards.
- **Use in chat** makes it the template the presentation tools use in this browser.

A shape that takes its position from a layout placeholder, without stating it on the slide, is
measured as empty. It is listed under the slide ("without a position of their own") and can still
be made a slot, but its budget is only as long as its sample text. Decks exported from Google
Slides, and decks built from free-standing text boxes, work as they are.

## Pictures of slides

The pictures in the studio and in the chat's cards are drawn on the server by the
[Pagus](https://www.npmjs.com/package/@pagus-kit/renderer) library, through slotdeck's preview
adapter: one SVG a slide, in about a fifth of a second for a whole deck. They are drawn when first
asked for and kept in memory for the most recent templates and decks; nothing is written to disk.
They go to the browser only. No model is sent one.

- **The text in a picture is real text, set by the browser.** It uses the fonts the viewer has, so
  where a template's fonts are missing, lines can break elsewhere. A picture shows what a slide
  looks like; it does not prove that a text fits. slotdeck's own notes list what Pagus draws
  differently from PowerPoint: text anchored to the bottom of its box, rounded corners of pictures,
  right-to-left tables, the steps of a chart's axis.
- A picture is made from a file somebody uploaded, so it is served as an image and nothing else:
  the response carries `Content-Security-Policy: sandbox`, and the pages show it with `<img>`.
- `PRESENTATIONS_PREVIEWS=0` turns pictures off. The app then draws each layout as boxes, from the
  shapes' positions, as it also does for a picture that cannot be drawn.

## Where things are kept

| What | Where |
|---|---|
| Templates shipped with the app | `presentation-templates/<id>/` in the repository: `template.pptx`, `manifest.json`, optional `meta.json` (name, deck fields) and `icons/` |
| The icon set decks pick from | `presentation-templates/icons/` (`icons.json` and one PNG per icon) |
| Templates put in the studio | `PRESENTATIONS_DIR/templates/<id>/` (default `.data/presentations`) |
| Plans, decks, pictures, files | `PRESENTATIONS_DIR/decks/<template id>/` — `plan/`, `deck/`, `asset/`, `pptx/` |

Shipped templates are read-only in the studio: **Duplicate** one to change it.

On Cloud Run the disk belongs to one instance and is lost when it restarts, so studio templates
and created decks do not survive a deploy. To keep a template, download its two files from the
Manifest and files tab and add a folder to `presentation-templates/` (the .pptx as `template.pptx`,
the manifest as `manifest.json`); it then ships with the image. Cloud Run also limits an upload to
30 MB.

Nothing removes old decks. A deck with photos is a few megabytes; clear
`PRESENTATIONS_DIR/decks` when the disk matters.

## Models

- **Text.** slotdeck's Gemini adapter calls the Interactions API with the chat's provider and
  model (or `PRESENTATIONS_MODEL`). On Vertex AI that API has only the global endpoint, so the
  chat's region does not apply to these calls. The chat model's own tool loop runs on Generate
  Content, whichever chat API is selected, like the large-file tools. Planning calls ask for light
  reasoning unless `PRESENTATIONS_THINKING_LEVEL` says otherwise.
- **Photos.** One call to `gemini-3.1-flash-image` per photo. On the Gemini API this is slotdeck's
  image adapter (Interactions). On Vertex AI the Interactions API does not serve the image model
  (`Model 'gemini-3.1-flash-image' is not supported by the Interactions API`), so the app calls
  Generate Content with `imageConfig: { aspectRatio, imageSize }` instead
  (`server/presentations/models.ts`). `PRESENTATIONS_PHOTOS=0` turns photos off.
- **Icons** are not generated: the planner picks from the registered set by description.

Settings are the `PRESENTATIONS_*` variables in `.env.example`.

## What of slotdeck 0.2.0 is not used

- **Text measured with the template's fonts** (`fontkitMetrics`, `measuredBudgets`, shrinking text
  to fit). It needs the font files of each template on the server, which a Cloud Run image does not
  have. Budgets are therefore the cautious ones a draft works out from box and font size.
- **Design checks and reviews** (`checkDesign`, the planner's `review` option).
- **Other layouts for one slide** (`slideAlternatives`).

## What was run live

13 November 2026, with slotdeck 0.1.0:

| Check | Gemini API | Vertex AI |
|---|---|---|
| Plan, create, change a deck (`gemini-3.8-flash`) | worked | worked |
| Plan with the Gemini 4 switch on (`gemini-4-argon`) | worked | not run |
| Photo in a deck | adapter returned a JPEG in a direct call; not run inside a deck | worked, 1K PNG of about 2 MB |
| Tools on Auto hand the turn over (Generate Content) | not run | worked, for the plan and for the approval |
| Draft a 13-slide template (14 calls, text only) | worked, all 13 slides became layouts | not run |
| Change a manifest by instruction | not run | worked |

14 November 2026, with slotdeck 0.2.0, in Chromium on Windows:

| Check | Result |
|---|---|
| Plan and create a deck in one answer, with one photo (Gemini API, `gemini-3.8-flash`) | worked; the cards showed the layouts and the four slides as pictures |
| Pictures of the demo template's slides and of its 18 layouts in the studio | drawn; the machine has the template's fonts |
| Derive a mirror image of a photo layout with one click | worked; the sample view showed the picture on the left |
| Edit the manifest as JSON and save it | worked |
| Uploading a .pptx together with a manifest, replacing a .pptx | automated tests only |
| Pictures on Vertex AI, or on a machine without the template's fonts | not run |

Decks created on 13 November were opened with PowerPoint on Windows and looked right. Other viewers
were not tried. Automated tests script both models and spend no quota; they draw pictures with the
real Pagus library.

## Code map

| File | What it does |
|---|---|
| `server/presentations/chat.ts` | The chat model's tool loop, and the plan and deck cards sent to the browser |
| `server/presentations/templates.ts` | The template library on disk; reading a manifest that comes in as JSON |
| `server/presentations/previews.ts` | Pictures of slides: the Pagus provider and a small memory of recent sets |
| `server/presentations/models.ts` | The text model and photo source for a provider |
| `server/presentations/routes.ts` | PPTX Studio's API (`/api/presentations/templates…`), deck downloads and pictures |
| `shared/chat-tools.ts` | The `make_presentation` handoff for tools on Auto, and the history note |
| `src/components/PresentationCards.tsx`, `SlidePicture.tsx`, `SlideWireframe.tsx` | The cards in the chat, a slide's picture, and a layout as boxes |
| `src/pptx-studio/` | The studio pages |
