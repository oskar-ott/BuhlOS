# Workshop Stock — UI / UX audit (2026-11-01)

**Scope.** Both surfaces of the stock tool (`workshop_stock`, dark): the crew
screens at `/phil/stock` (list, item sheet, Take stock, Add or return, new-item
form, receipts, lost-save recovery) and the office view at `/stock` (list,
filters, item drawer, Add item). Audience: an electrical contractor's crew on a
phone in the workshop, and the office on a desktop.

**Method.** Every component under `src/components/stock`, `src/components/admin/stock`
and `src/components/phil/PhilWorkshopStock.tsx` was read, then the real pages
were rendered under `next dev` (flag on, `phil_sharpened` on) with
`/api/workshop-stock` answered by fixtures (eight realistic items: GPOs,
switches, an MCB, TPS, Cat6, tape, saddles; one archived), on a Pixel 7
viewport and a 1366 px desktop. A fake camera and a stubbed `BarcodeDetector`
exercised the live-read viewfinder, the hit card, the unmatched-code card and the
auto-open confirmation. Not exercised: the real photo reader, the real online
check, iOS Safari. Screenshots are not committed (they are fixture data); the
runner is reproducible from the notes at the end.

**Measured against:** the Phil constitution (P7 no fake numbers, P8 gloved
targets, P10 cognitive budget, P11 site language), the Phil "sharpened"
primitives (`PhilNotice`, `PhilPageIntro`, `PhilStatusBadge`, the 12 px
legibility floor in `legibility-floor.test.ts`) and the office dialect
(`Button`, `Pill`, `Drawer`, `Seg`).

---

## Verdict in one paragraph

The flows are sound: one decision per level, the recorded quantity is the
biggest thing on every row, every write is a named button with a "Saves:" line,
and the lost-save recovery is the best-handled failure state in the app. The
problems are at the edges: a handful of genuine rendering bugs (double clear
buttons, "boxs", overlapping scanner copy, a focus ring fighting an error
border), a stock-only design dialect that drifts from the rest of Phil (its own
notice, button, heading and tag primitives, hard-coded hex colours, sub-12 px
type), phone-sized controls dropped into the office drawer, and a few screens
that carry more than a worker needs (the new-item form, the "What's going in?"
screen, the dark "pretend camera" panel on Add). All of it is fixable without
touching the architecture or the ledger.

---

## A. Bugs and unformatted output (fix first)

| # | What you see | Where | Fix |
| --- | --- | --- | --- |
| A1 | **"2 boxs of 10 each"** on the item sheet's movement row — hand-rolled plural. The line also repeats the pack that the summary line already says ("Added 20 each (2 boxes)" then "2 boxs of 10 each"). | `src/components/stock/StockItemSheet.tsx:119` | Use `packLabel(m.pack.unit, m.pack.count)` from `format.ts` (it already knows boxes/packs/bags). Drop the second line, or say only the pack size: "10 each per box". |
| A2 | **Two clear buttons** in every search box: the browser's native `type="search"` ✕ draws on top of the custom "Clear ×" (list) or the custom ✕ (pickers). On the main list it renders as "✕Clear ×". | `PhilWorkshopStock.tsx:242`, `ItemPicker.tsx:44`, `JobPicker.tsx:57`, `StockAdminClient.tsx:117` | Add `[&::-webkit-search-cancel-button]:appearance-none` (or use `type="text"` with `inputMode="search"`), and use ONE clear affordance everywhere — the icon-only ✕ the pickers use. |
| A3 | **Scanner status line overlaps the aiming frame** once something sits under the viewfinder (a "Taken this round" card, an unmatched-code card): the viewfinder shrinks to its 220 px minimum and "Looking for a code — no need to press anything" is painted across the dashed frame. | `LiveCodeScanner.tsx:176–205`, `TakeFlow.tsx:231` | Either reserve space for the status line (put it in flow under the frame, not `absolute bottom-3`), or hide the frame text when the viewfinder height is below ~260 px. |
| A4 | **Error border and focus ring collide** on the quantity box: typing more than is recorded paints a red 2 px border while the global yellow focus ring draws inside it, so the number sits in a red-and-yellow double frame. | `QuantityStepper.tsx:85` | Give the stepper its own `focus-within` treatment (navy ring, like `BigButton`'s `focus-visible:outline-brand-navy`) and let the invalid state own the border. |
| A5 | **Last-movement cell wraps to four lines** in the item sheet's three-column stat strip ("Taken 2 each · You · 7:33am · note: IV1240 Mascot fit-off") while "Recorded" sits in a column too narrow for "≈ 40 m (estimate)", which breaks mid-value. | `StockItemSheet.tsx:89–101` | Two rows: Recorded on its own line (large), then "Last counted · Last movement" as a two-column line. Shorten the movement to "Taken 2 each · 7:33am" and keep the job note in the history list below. |
| A6 | **Orphan tile** in "You often take": a three-column grid with one or two entries leaves two blank columns. | `TakeFlow.tsx:183` | `grid-cols-[repeat(auto-fit,minmax(120px,1fr))]` or a horizontal chip row. |
| A7 | **"Camera paused."** flashes in the viewfinder the moment a code is matched, under the hit card, because the camera is stopped while the card shows. Reads like something went wrong during the one second the worker is told to "hold steady". | `TakeFlow.tsx:231` | Keep the stream running (just stop detecting) while `hit` is set, or replace the paused copy with nothing when a hit card is overlaid. |

## B. Design mismatches with the rest of BuhlOS

| # | Mismatch | Where | Fix |
| --- | --- | --- | --- |
| B1 | **A private design dialect.** Stock ships its own `Slot`, `BigButton`, `MiniButton`, `LinkButton`, `Kicker`, `Tag`, `FoldButton` while Phil already has `PhilNotice`, `PhilActionButton`, `PhilPageIntro`, `PhilStatusBadge`. The two notice styles differ visibly: `PhilNotice` is a raised card with a 4 px tone rail; stock's `Slot` is a tinted box with a tinted border. A worker moving from Hours to Stock sees two "warning" shapes. | `src/components/stock/ui.tsx` | Either adopt the Phil primitives, or (if the stock shapes are the intended direction — the two-line "what it records" button is genuinely better) promote them to `components/phil/ui` and migrate the other screens. Decide once; don't keep both. |
| B2 | **Page heading drifts** from every other Phil screen: 26 px bold navy here; sharpened Gear/Jobs use `text-2xl font-extrabold tracking-[-0.02em] text-text`, and `PhilPageIntro` is the ratified intro. | `PhilWorkshopStock.tsx:194` | Use `PhilPageIntro` with the count in its `meta` slot ("8 items") instead of appending "8 items." to the description sentence. |
| B3 | **Hard-coded hex colours** (`#e6b800` button border, `#dfe6ee` / `#eef2f7` viewfinder text), against the tokens rule ("components should NEVER hardcode hex values"). | `ui.tsx:73`, `PhotoCapture.tsx:69,103`, `AddFlow.tsx:150–151,327`, `LiveCodeScanner.tsx:180–202` | Border: `border-accent-yellow` with `brightness-95`, or add a `--accent-yellow-strong` token. Viewfinder text: `text-text-inverse` / `text-text-inverse/80`. |
| B4 | **Sub-12 px type** on field screens, below the legibility floor the repo pins for Phil: 11 px stat labels on the item sheet, 11.5 px shelf line on "often" tiles, 10.5 px provenance tags, 11 px "Online check" kicker. `legibility-floor.test.ts` only scans `components/phil`, so `components/stock` escapes it. | `StockItemSheet.tsx:91–99`, `TakeFlow.tsx:189`, `ui.tsx:195`, `LookupCard.tsx:58` | Raise to 12 px and extend the floor test to `src/components/stock`. |
| B5 | **Three primary-button colours for the same job.** Yellow = Confirm take / Return / Save and add another; navy (`variant="nav"`) = "Add to this item", "Add or return to this one", "Add to that item instead", "Count in Each, add full boxes". Phil reserves yellow for the single primary field action per screen and never uses navy as a primary. | `AddFlow.tsx:224,435`, `NewItemForm.tsx:349,371` | One rule: the write/continue button is yellow, alternatives are outlined. Keep navy only for the direction pill. |
| B6 | **Chip case flips within one form**: "Counted in" chips are Title Case (Each, Boxes), the pack-type chips 80 px below are lower case (boxes, packs, cartons). | `NewItemForm.tsx:360` vs `:419` | Capitalise `packLabel` output for chips, or add a `chip` field to `PACK_PLURAL`. |
| B7 | **Phone controls inside the office drawer.** "Add item" and the Catalogue → Photo sections drop the 56 px yellow `BigButton`/`PhotoCapture` and 48 px `FIELD` inputs into a drawer whose own forms use 36 px `INPUT` and 32 px `Button size="sm"`. "Choose photo" / "Replace photo" / "From library" wrap to two lines at the drawer width. The result is two densities in one panel. | `StockAdminAdd.tsx:103`, `StockItemDrawer.tsx:275,286` | Give `NewItemForm` and `PhotoCapture` a `density="office"` prop (office `INPUT`/`Button`), or wrap the office photo controls in plain `Button size="sm"` + hidden file inputs. |
| B8 | **Office filter chips** are square 32 px tabs with a mono count, while the office already has `Seg` (rounded-pill tabs in a bordered container) used by the exceptions inbox and hours filters. The square chips do match the newer Jobs/Invoices dialect, so this is a "pick one" note, not a defect. | `StockAdminClient.tsx:97–108` | Use `Seg` with `count`, or leave as-is if Jobs/Invoices is the direction. |
| B9 | **Receipt layout** crams a 44 px "Undo take" mini-button beside a two-line heading, so "Taken 2 each · Clipsal double GPO white" wraps and "40 each recorded now · Shelf A2, Bin 4" breaks after the dot. | `StockReceipt.tsx:51` | Put Undo on its own row under the text (`below`), full width on phones. The undo-until line can sit beside it. |

## C. Simplicity and cognitive load (the field screens)

| # | Observation | Where | Suggestion |
| --- | --- | --- | --- |
| C1 | **The Add screen opens on a dark panel that looks like a dead camera.** It fills the screen with the same shape and colour the Take screen uses for the live viewfinder, but it is only a paragraph of instructions. A worker who just used Take will think the camera failed. | `AddFlow.tsx:149–152` | Replace with a plain empty-state (camera glyph, one line: "Photograph the label, or search above"), and let the yellow "Take photo" button do the work. If live reading is supported, consider reusing the real viewfinder here too — a barcode read on Add would match an existing item faster than the paid photo read. |
| C2 | **"What's going in?" is a heading stranded mid-screen**, 600 px above the three buttons it introduces, with "Found in the list" / "Already listed — add to the existing item, no need for a new one" / "Recorded on the shelf" stacked above it saying nearly the same thing three ways. | `AddFlow.tsx:233–249` | Pin the question to the footer as the buttons' label, or move the buttons into the body under it. Collapse the three confirmations to one line: "✓ Already listed · 42 each recorded on Shelf A2, Bin 4". |
| C3 | **The new-item form is not the "one short form" it claims to be.** On a Pixel 7 the pinned footer (Saves-as line + Saves line + two 56 px buttons) covers ~40 % of the screen; the body carries 7 unit chips (two rows), 6 shelf chips (three rows), a 56 px "Hard to find? Photograph where it lives" button plus a library link, the stepper, a pack prompt, an estimate checkbox and the details fold. The first thing clipped under the footer is "How many going on the shelf" — the one field the worker actually came to fill. | `NewItemForm.tsx:300–520`, footer at `:490` | (a) Fold the location photo behind a text link ("Hard to find? Add a photo of where it lives"). (b) Show 3 shelf chips + "more". (c) One footer line, not two (see C4). (d) Make "Save and go to the list" a text link under the primary, not a second 56 px button. (e) Put "How many" directly under the name — it is the point of the form. |
| C4 | **Two "Saves" lines with different meanings**: "● Saves as: Saved without external verification" then "Saves: Opening count 10 each (1 box × 10 each) · Shelf A2, Bin 5". "External verification" is office/vendor language, not site language (P11), and it is the only line on the whole phone surface a tradie cannot act on. | `NewItemForm.tsx:497–505`, `format.ts:125` | Drop the status line from the phone form unless a check actually ran (then: "Code checked online ✓" / "Code not confirmed online"). Keep one "Saves:" line. Office keeps the full wording. |
| C5 | **The box-unit warning repeats its own title**: "Counted in whole boxes" / "Counted in whole boxes: stock can only go out a full box at a time…". | `format.ts:54`, `NewItemForm.tsx:368` | Title "Whole boxes only", body "Stock will only go out a full box at a time. Taking singles out of the box? Count in Each and add full boxes." |
| C6 | **"can't run: more than is recorded"** under a disabled button is program-speak. | `MoveConfirm.tsx:319`; also `NewItemForm.tsx:325,328` ("can't run: code already listed") | "More than the 42 recorded" / "Code already on another item". |
| C7 | **The office is named 11 times on the phone surface** ("ask the office", "tell the office", "the office can…", "waiting for the office to say saved"). Each one is right on its own; together they make the tool feel like it belongs to someone else. | grep `office` in `src/components/stock` | Keep it where it names the fix ("ask the office to correct the count"); cut it from status copy ("Saving…", "Couldn't load the list — no signal"). |
| C8 | **Date formats change shape within a list**: "7:33am", "Sat 31 Oct", "Tue 27 Oct", "25 Oct" in the same movement list; the office table mixes "7:36am" and "Sun 1 Nov" in one column. Deliberate (`whenLabel`), but a reader scanning a column has to parse three formats. | `format.ts:321` | Consider "Today 7:33am" / "Yesterday" so the time-only form is self-explaining, and always include the weekday inside seven days. |
| C9 | **Item-sheet footer buttons misalign**: "Take / out", "Return / back from a job", "Add / new stock" at three widths produce three different label baselines, and "back from a job" wraps to three lines. | `StockItemSheet.tsx:66–70` | Two buttons (Take · Add or return) matching the list's doors; the Return choice already exists one tap in. Or shorten subs to one word each ("out", "back", "in"). |

## D. The office view

| # | Observation | Where | Suggestion |
| --- | --- | --- | --- |
| D1 | **"Saved without external verification" on seven of eight rows** dominates the Product code column and repeats as an orange hint line on every phone-width row. The *confirmed* items are the exception worth marking, not the unconfirmed majority. | `StockAdminClient.tsx:168,245` | Show the pill only for `possible_match` (with its reason) and `manufacturer_code_matched`; render `unverified` as a quiet "—" or "Not checked". Keep the "Code not confirmed" filter as the way to see them all. |
| D2 | **Bin column wraps** ("rack / 2") and shows "—" for one-part locations, which reads as missing data when the item simply has no bin. | `StockAdminClient.tsx:230` | `whitespace-nowrap`; blank instead of a dash when there is no bin (the shelf header already says where it is). |
| D3 | **"Correct the count" sits above the history** and is the first interactive thing in the drawer, with a greyed "Save count" that stays disabled until both a number and a reason are typed, and no hint that the reason is required. | `StockAdminForms.tsx:95–126` | Mark the reason field required ("Reason — required"), or enable Save and ask for the reason on submit like the undo form does. |
| D4 | **Catalogue fold label** "Catalogue · details, codes and packs, online check, photo, history" wraps to two lines at drawer width; the leading middle dot is passed in as part of the sub text. | `StockItemDrawer.tsx:218` | Pass the sub without the dot and let `Fold` add the separator; shorten to "details, codes, check, photo". |
| D5 | **Phone-width office list** stacks the "Add item" button on its own line below the search, which is fine, but the whole filter row + explanation + search + button pushes the first row below the fold. | `StockAdminClient.tsx:93–117` | On `sm:hidden`, collapse filters into a single `select` or move "Add item" into the page header beside the title. |

## E. What is working and should not be touched

- Level one is one decision (Take / Add or return); the doors never move; the
  receipt sits at the top with its own Undo. This is P10 done properly.
- The recorded quantity is the largest thing on every row; zero reads "None
  recorded"; estimates read "≈ 40 m · estimate". No fake numbers (P7).
- Every write is a named button that says what it records ("Confirm take ·
  2 each", "Saves: Taken 2 each · 40 each recorded after this").
- The over-take stop is clear and offers the one fix ("Change to 42 each").
- The lost-save card ("A save didn't go through — Save it now / Discard it",
  with "Save it now records Taken 2 each. Discard it records nothing.") is the
  clearest failure state in BuhlOS.
- The live barcode read with "Matched in workshop · barcode …" and "Opening…
  hold steady. Nothing is taken yet." is the right speed and the right promise.
- 56 px targets on every field control (P8).

## Suggested order of work

1. **Quick fixes, one PR:** A1, A2, A4, A6, B3, B6, C5, C6, D2, D4 — all
   one-line or copy changes; include extending the legibility-floor test to
   `src/components/stock` (B4).
2. **Field polish, one PR:** A3, A5, A7, B9, C1, C2, C9 — layout only, no
   behaviour change, so no governance amendment is needed.
3. **Form slimming (C3, C4):** worth a short field check first (does the crew
   set the location photo often enough to deserve a 56 px button?) — that is a
   P15 question, so run it through the weekly closeout.
4. **Dialect decision (B1, B2, B5):** one owner decision — stock primitives
   into Phil, or Phil primitives into stock — then a mechanical migration.
5. **Office density (B7, D1, D3):** independent of the field work.

## Follow-up — office view rebuilt (same day)

The owner's first reaction to the audit was the office view ("the table, the
drawer, the noise"), so that surface was rebuilt on the same branch:

- **List (B8, D1, D2, D5, A2):** the six-column table is gone. One card per
  shelf, the crew's `StockItemRow` inside it with "Moved … · counted …" as the
  office line; `Seg` for the filters; the code pill only on possible matches;
  the native search clear suppressed.
- **Drawer (D3, D4, B7):** opens on the quantity and the two facts, then
  Correct the count (reason marked required, lock note under the inputs, Save
  on the same row as the estimate box), History, an "Edit details" fold, and
  Archive as a quiet action at the bottom. Photo controls are office-sized
  (`PhotoCapture density="office"`).
- **Add item (B7):** `NewItemForm density="office"` — drawer-sized inputs,
  chips and buttons, footer in flow. The phone form is unchanged.
- **Wording:** page intro cut to one sentence; "Not verified" instead of "Saved
  without external verification" in the drawer's check section (the phone's
  "Saves as" line is untouched — the e2e spec asserts it).

The e2e selectors the office tests use (`stock-admin-table`, `stock-admin-row`,
the tab names, every drawer and form test id) are kept. The field findings in
sections A–C are still open.

## Reproducing the screenshots

```bash
npm ci
SESSION_SECRET=<16+ chars> FLAG_WORKSHOP_STOCK=1 FLAG_PHIL_SHARPENED=1 npx next dev -p 3000
```

Then a Playwright script that (a) sets a `buhl_session` cookie whose body is a
base64url JSON `{ userId, role, name, username, exp }` (the page only decodes
it; the API is mocked), (b) routes `**/api/workshop-stock*` to fixture JSON
matching `src/domains/workshop-stock/schema.ts` and every other `/api/**` to a
404, (c) launches Chromium with `--use-fake-device-for-media-stream
--use-fake-ui-for-media-stream` and an init script that defines a
`BarcodeDetector` stub returning a chosen EAN-13 (valid check digit — the
matcher rejects anything else). The "1 Issue" badge in the office captures is
`next dev` reporting the missing Blob token and the mocked 404s, not a product
error.
