# Workshop Stock (`workshop_stock`)

> **Status (2026-11-01): built, in real use; database complete in dev and
> production.** What was checked, and how:
>
> - **Migrations — verified against each project's migration history on
>   2026-11-01:** `workshop_stock` (dev and production 2026-10-13),
>   `workshop_stock_location_photo` (dev 2026-10-26, production 2026-10-29) and
>   `workshop_stock_types_and_lists` (dev and production 2026-11-01) are
>   applied to **Buhlos-dev** (`frovgpywsopbeuekijmo`) and
>   **Buhlos-Production** (`wetctlrhsycfwhuxlarv`). After the last one,
>   production showed the new columns and both list tables with RLS on and no
>   policies (the house pattern), and its existing 5 items and 5 movements
>   unchanged — real records from the first week of use (the owner launched it
>   the week of 2026-10-26).
> - **Effectively enabled:** still read at `/owner` — not stamped in
>   [runbooks/production-flag-verification.md](runbooks/production-flag-verification.md)
>   (nobody has checked it there for this doc).
> - **Not verified from here:** photo reading and the online check in
>   production (`ANTHROPIC_API_KEY`, web search enabled for the organisation,
>   Vercel reaching the allowlisted sites).
>
> **Status (2026-10-09, when it first shipped): built, dark, not operational.**
> The five states are defined in [feature-flags.md](feature-flags.md) ("What a
> flag proves").
>
> - **Built:** the slice below, behind `workshop_stock` (launch-gate, default
>   off, global target).
> - **Registry default:** off. While off, nothing of it exists for anyone:
>   `/phil/stock` and `/stock` 404, every `/api/workshop-stock` path 404s right
>   after the session check, the office nav item and the More-screen card are
>   not rendered.
> - **Effectively enabled:** read it at `/owner` — not provable from the repo.
> - **Externally configured:** **no.** The migration
>   `20261009100000_workshop_stock.sql` has been applied only to a local test
>   database. Photo reading and the online check reuse the existing
>   `ANTHROPIC_API_KEY`; web search must also be enabled for the organisation in
>   the Claude Console, and Vercel must be able to reach the allowlisted sites —
>   neither is verified. See [Activation](#activation-operator-steps--none-performed-by-the-pr).
> - **Operationally proven:** no. The photo reader, the web search and the page
>   fetch were exercised only against fixtures (the build sandbox has no product
>   API key and no egress to the supplier sites). Everything else — ledger,
>   locking, idempotency, undo, matching, verification logic, both surfaces — was
>   exercised end to end against real Postgres in a browser
>   ([Testing](#testing)).
>
> **Pull:** owner pull, 2026-10-09. **Hypothesis:** if workers can identify
> stock from a photo and confirm a quantity with minimal effort, they will keep
> the workshop stock list useful enough to check before buying more materials.
> Not part of the ratified lean core
> ([product/02-lean-reset.md](product/02-lean-reset.md)); it earns its place, or
> not, through the loop in [product/03-lean-startup-loop.md](product/03-lean-startup-loop.md).
>
> **Tweak after the first week of real use (owner pull, 2026-11-01)** — the
> loop's *tweak* outcome, inside the same flag: [item types with their own
> fields](#item-types-and-their-fields) and [browsing by type](#browsing-by-type),
> [shopping lists](#shopping-lists), and the [photo of where it lives as a step
> of putting stock away](#a-photo-of-where-it-lives). Owner's words: "a Clipsal
> Iconic 2 gang plate is not a Classic one — but it's all shoved in the name";
> "someone opens stock when they already know what they need"; "a list they can
> go back to — what we have in the workshop, what to get from the wholesaler";
> "a photo of the general location — the shelf text might be wrong". They need
> migration `20261101100000_workshop_stock_types_and_lists.sql`; before it is
> applied nothing changes and nothing breaks (see [Data](#data)).
> **Hypothesis:** if items carry their type's fields and the phone opens on
> types, workers find what they need without scrolling or searching names, and
> they use a list for a job's pick-up instead of a text message.

## What it does

Electrical materials and consumables kept in the workshop — GPOs, switches,
breakers, conduit, cable, fittings, fixings: what we have, how many are
recorded, and where they live.

**Workers (phone, `/phil/stock`)**

- The list is read **by shelf** (the shelf is the group header, the bin sits
  on the row) and the **recorded quantity is the largest thing on a row**;
  search by name, code, barcode or shelf — in trade names too ("power point"
  finds the GPO, "twin and earth" the TPS). Level one is one decision, two
  doors pinned at the bottom: **Take stock** (out) or **Add or return** (in).
  Return lives behind "Add or return"; per-item actions sit one tap down.
- **Take stock** — one screen with three ways in: **live code reading** (the
  phone's camera looks for a barcode on its own, about 1–2 s, no shutter —
  the browser's built-in detector, matched against the list already on the
  phone, so it works with no signal), **search**, and **"You often take"**
  (the items this worker has taken most, remembered per worker on the phone;
  shown only when there is something to show). The label photo is the backup
  when there is no code. Several items share a code → "Is it one of these?";
  not on the list → search, a closer photo, or add it as new stock
  (explicitly). After the receipt: **Take another item** (the round so far
  stays visible, each save already saved) or **Done**.
- **Add or return** — photograph the item or its box, or search: if it is
  already in the workshop, **"What's going in?"** — add to it, return to it,
  or it's a different product; if not, one short form pre-filled from the
  label (name, unit, shelf — the last shelf used is filled in — how many),
  with brand, codes, colour, size and the online check folded under
  "Details read from the label — check them", and the **"Saves as"** code
  status pinned above Save. "Save and add another" shows the receipt and the
  shelf filling up and goes straight back to the camera (setting up the
  workshop); "Done for now" ends it with nothing waiting.
- Note a job on a movement if they like (optional, informational — **never a
  job cost**, said every time).
- Undo their own movement for 30 minutes, from the receipt it sits on (the
  office can undo from the same screens, with a reason).

**Office (`/stock`, desktop and phone)**

- One toolbar — search and type on the left; Camera table, Location matrix,
  Categories and **Add item** on the right — then the views as tabs on the
  list (All · None recorded · Estimates · Code not confirmed · Not sorted ·
  Archived, each with its count; no count when the list didn't load). The
  list is read by shelf: what's recorded (right-aligned, "≈" for an
  estimate), when each item last moved and was last counted, and a short
  product-code status (Matched · Possible match · Not checked) whose tooltip
  carries the reason ("Possible match — colour not confirmed"). The Bin column
  shows only when something in view has a bin. "Recorded, not a guarantee"
  is one line under the list. No KPI row, no gauges.
- **Three views and a grouping** (office pull 2026-11-03: "give me
  different views not just the table view"), all over the same filtered,
  grouped items (`src/domains/workshop-stock/views.ts`), all opening the same
  drawer: **Table** (read across; rows on a phone), **Cards** (a photo grid,
  to recognise items by sight), **Board** (one column per group — the
  workshop as you'd walk it, scrolling sideways). **Group by** Shelf (default),
  Type (once the server has types) or nothing (A–Z); grouped by anything but
  shelf, the full location shows instead of just the bin. The chosen view and
  grouping are remembered in this browser only (a convenience; the page
  works without it). No view adds a number the list doesn't already hold.
- **Each view, sharpened** (office pull 2026-11-03: "improve the individual
  views"). One toolbar row says how you're looking — search, type, **Group**,
  **Sort**, the view, then Add item; the filter tabs sit under it with the
  workshop tools (Camera table, Location matrix, Categories) as quiet links
  on the right. **Sort** works within each group in every view: name A–Z,
  lowest recorded first, last moved newest first, or longest since counted
  (never-counted first — a count round); remembered with the view. Every
  group header counts its own rows with nothing recorded ("3 items · 1 none
  recorded").
  - **Table**: click a column head to sort by it (again to reverse); the heads
    stay pinned while the page scrolls; groups fold.
  - **Cards**: "None recorded" / "Estimate" on the photo, the last count and
    where it lives in the footer, a "No photo" tile instead of a blank icon;
    groups fold.
  - **Board**: each column scrolls on its own so the board fits the screen; a
    fade and arrow buttons when there are more columns off to the side; an
    empty item carries a warning edge.
- Per item, a drawer with three tabs (office pull 2026-11-03: "the web view
  is clunky" — one long scroll became three views):
  - **Stock** (opens first): what's recorded, the shelf, last count and code
    status; **correct the count** (counting starts when the drawer opens; a
    stale-count guard shows what moved meanwhile); the full movement history
    with **Undo** (any movement, a reason required, written into the history).
  - **Details**: the catalogue — details with a compare-and-set conflict
    block, codes / barcodes / pack sizes, the online code check, the photos,
    the item's own history — and **archive last and apart** (confirmed;
    read-only after; restore says which codes come back).
  - **Label**: the NIIMBOT barcode label.
- Add items the same way the crew does, by hand or with a photo.

**Types, browsing, lists (2026-11-01)**

- Every item can have a **type** — Switches & GPOs, LED strip, LED drivers,
  Lights & downlights, Cable, Breakers & RCDs, Conduit & fittings, Fixings &
  consumables, Other — and **that type's fields**: a switch's brand, range
  (Iconic, Classic, Saturn…), what it is (switch, GPO, dimmer…), gang and
  colour; an LED strip's colour temperature, voltage, width, length, watts per
  metre and IP rating; cable's type, size, cores and sheath colour; and so on.
- The phone opens on **one tile per type** (with how many items and a sample —
  "Iconic · Classic"); a type opens with its fields as **filter chips** built
  from what is actually in stock, each with its count.
- **Shopping lists**: a list for a job (shared with the crew) split into **In
  the workshop** (shelf by shelf) and **Get from the wholesaler** (copy or send
  it), ticked off by taking it.

**Camera table and location matrix (2026-11-02)**

- **Camera table** (`/stock/intake`): log a large number of items with a webcam
  above a table. **Location matrix** (`/stock/locations`): say what goes in each
  bin. Both [below](#camera-table-and-location-matrix).

**Not gear.** Gear (tools and equipment) has custody, serials, test-and-tag and
"who has it". Workshop stock has none of that: an item is a quantity on a shelf
and stock leaving is a quantity movement, not a loan. The two share nothing but
a nav group; the Gear workflow is untouched.

## Camera table and location matrix

Owner pull, 2026-11-02: "its for web and only for logging a large number of
items. i set up a webcam above a table and a live feed runs ocr i place items
underneath and it identifies, highlights it red until its logged and then turns
to green, it adds it to the total and automatically assigns location. i also want
to be able to create a matrix of where everything [goes], eg iconic switches go
rack c shelf 2 bin 4."

**Hypothesis:** if the office can put stock under a camera instead of photographing
each item, setting up the workshop list stops being the reason nobody starts it.
Reasoning only: it has never been used with a real webcam, real lighting or real
labels (see Testing).

**Office only, on a computer**, behind the same `workshop_stock` flag. Chrome reads
barcodes free and instantly; a browser without a detector reads labels only and
says so.

### Where it runs

Everything live runs **in the browser on the computer at the table**: the video,
the boxes, spotting objects and reading barcodes. Video never leaves the computer.
The server sees one still crop per object, and only when no barcode identified it.
Streaming video to Vercel would add lag and cost for no better read; a model running
on the computer itself would be a second system to install and keep running, for
accuracy nobody has measured.

### How an object goes from red to green

1. **Start** takes a picture of the empty table. A frame about 320 px wide is
   compared with it a few times a second (`intake-tracker.ts`); anything new gets
   a dashed red box. *What counts as new* (2026-11-03, after the first real
   webcam boxed the light band, the vignetting and the shadows as dozens of
   objects and missed a white bag on a white table): the table's light is first
   matched region by region as a **gain** (auto-exposure scales brightness), then
   a spot is new when its **edges** changed (an object brings an outline and
   print; a light change is smooth) or its colour changed a lot. Both thresholds
   rise with the camera's own noise, measured on each frame.
2. It counts once it has sat still for 0.8 s. A blob touching the edge of the
   picture is an arm: it never counts, and whatever it covers stays on the table
   while it does. A nudged object is the same object. Objects pushed together turn
   amber ("Touching: move them apart") and any that split off count then.
3. A sharp crop of the full-size frame is taken. **A barcode** in it is matched
   against the list right there — or, if the crop has none, a barcode anywhere in
   the full picture whose centre is on or just beside the object (a box spotted a
   little small no longer cuts its barcode off); otherwise the crop goes to the
   **label reader** (the same one as the phone, two at a time).
4. **An exact barcode or code match logs by itself** and the box turns green.
   Words alone never do, because two GPOs look alike: "Is it one of these?" stays
   red until someone picks, and a pick teaches the item that barcode.
5. **Not on the list:** stays red with one card, already filled in: name from the
   label, amount, location from the matrix. One tap adds it. Anything else waiting
   with the same code then logs by itself, and so does every later one.

**Amount.** A loose item adds 1. A box printed "Pack of 10" of something counted
each adds 10, and the row says the size came from the label. An item counted in
boxes adds 1 box. A length is never guessed: without a printed length it asks.
Any logged amount can be changed afterwards, which undoes that movement and records
a new one, both in the item's history. Each placement is its own ledger movement
with the note "Camera table" and its own idempotency key, so a lost answer retried
is never counted twice, and Undo takes back that one placement.

**"All the same"** on a logged row: everything placed from then on logs as that item
and amount with no read at all, until Stop. For a run of identical items, and for
loose items with no readable label.

This is the one place stock is written without a person confirming the quantity.
The reader still doesn't count (no field for it): the count is one per object the
tracker found, plus a pack size only when it is printed.

### How it looks and feels

Owner pull, 2026-11-02: "i want it to feel high tech". Both screens use a dark
console theme (`[data-theme="console"]` in `tokens.css`), scoped to them: the office
and the field stay light. Yellow marks the reticle and the primary action; red and
green only ever mean status, and every tag also has a glyph (`!`, `✓`) so it doesn't
rely on colour.

- **The reticle says what's really happening:** red corners closing in as an object
  settles, a scan line while it's read, solid pulsing red when it needs you, a green
  lock and flash when it's logged. Amber means two objects are touching. The yellow
  corners mark the working area: anything touching the picture's edge counts as an arm.
- **"Goes to"** under the feed is the largest thing on screen, because where to put
  the item is what the person at the table needs next. It can be read from a metre
  away. The same text is announced to screen readers.
- **Sound**, so nobody has to look up: a rising pair when logged, a low pair when it
  needs you. Mute with the speaker button or `M`.
- **Keyboard:** `Space` pause, `U` undo the last one, `F` full screen, `M` sound.
- **The status bar only shows measured values:** the camera's real resolution (flagged
  low under 1920 wide), the real analysis rate, what's on the table now, whether this
  browser reads barcodes, and how many bin rules exist.
- **Start** averages several frames of the empty table, so sensor noise isn't taken
  for an object. Motion is turned off under `prefers-reduced-motion`.

A logged item no rule placed can be given a location from its row. New items get their
**type** guessed from the label, for a person to check on the card, so they file with
their kind on the phone.

### The location matrix

`/stock/locations`: each rack is a grid of shelves and bins. Click a bin and write
the words for what lives there ("iconic switch"). A product goes to a bin when
**all** of a rule's words are on its label or name, compared the way the list search
compares (plurals and trade names folded). The rule with the most words wins, so
"iconic switch" beats "iconic". "Test a label" shows where a label would go.

A location is written as `Rack C Shelf 2, Bin 4`, which the existing by-shelf list
already reads as shelf "Rack C Shelf 2", bin "Bin 4". The matrix **only fills a blank
location**: a new item's, or an existing item with none. An item that has a location
keeps it, and changing the matrix never moves recorded stock.

Stored as one JSON document per company with a compare-and-set revision
(`workshop_stock_location_matrix`, migration
`20261102100000_workshop_stock_location_matrix.sql`). Until that is applied both
screens say so and nothing else changes.

### Limits on what the camera can do

- **Picture quality decides what can be read.** A 1080p webcam over an 80 cm table
  gets about 2.4 pixels per mm: box labels should read, barcodes and small print on
  loose items won't. Barcodes need about 6 pixels per mm: a 4K camera, or a field
  30 to 40 cm wide. Reasoning from the geometry, not measured.
- A plain mat that contrasts with the stock matters. White items on a white table
  won't be seen; the difference threshold is fixed.
- An object lifted away and put back counts again. Stacking on a logged object isn't
  seen as new. Undo and "Change amount" are the way out.
- The session list lives on the page: a reload clears the list, not the stock.

## Flows

### Add stock: photo → read → find/verify → confirm quantity + location → save

1. The phone downscales the photo (1600 px, JPEG) and sends it once. Every
   phone photo button (label, several products, where it lives) has **Use a
   photo from your camera roll** under it as a full button, so a photo taken
   earlier works the same as a new one (owner pull 2026-11-01).
2. The server validates it, stores it as a **pending** photo, and reads the
   label (photo reading below). Reading never writes stock.
3. The reading is matched against the catalogue ([Identification](#identification)).
   An exact match → **Matched in workshop**: add to that item (no duplicate).
   Weaker evidence → "Is it one of these?" with "None of these — it's new".
4. A new item opens one form. Fields read from the photo are labelled **read
   from photo**; when the label showed a manufacturer code, the online check
   runs once by itself and its result shows as evidence with its source link.
   "Use these details" fills only **empty** fields from the listing (labelled
   **from the listing**) — never the name the crew gave it, which is what
   people search for. Before saving, the form says the code status the item
   will be saved with — and if the code, brand, colour or size is changed after
   the check so it no longer describes this item, it says so and offers to
   check again.
5. Name, unit, location and the quantity going on the shelf (or a number of
   full packs × the pack size) → **Save**. The item, its codes, its photo and
   its opening movement are created in **one transaction** — or nothing is.
   A code another live item already carries is refused with "Add to "X"
   instead". Choosing a container unit (Boxes, Packs, Bags, Rolls) says what
   it means first: stock then only goes out a whole container at a time.
   If the photo couldn't be uploaded the item still saves, and the result says
   the photo isn't attached.

### Several items from one photo

Owner pull, 2026-11-01: "i want to be able to take one photo of multiple items
and be able to add them". When the photo reader finds several products in one
add-stock photo (it lists at most four), the "which one?" screen leads with
**Add all N from this photo**:

- The products are walked **one at a time** with the photo kept — no retake.
  Each goes through the normal path for what it is: already listed → "What's
  going in?" → add or return; not listed → the new-item form, prefilled from
  that product's part of the label (the shelf carries over from the one before).
- A "From your photo · 2 of 3" banner names the product on screen, with
  **Skip**. Back returns to the photo's list, which shows each product as
  Added / Skipped; tapping one jumps to it; a skipped one can be added after all.
- **Nothing is saved until each product's own Save / Confirm**, exactly as for
  a single item. At the end, a summary lists what was added from the photo,
  each with its Undo while the server allows it, then "Take photo of the next
  lot" or Done.
- The photo's stored row is claimed by the first NEW item from it; later new
  items from the same photo upload their own copy of the photo, so every new
  item keeps one. Progress lives on the phone only (`flow.ts` `startBatch` /
  `settleBatch`) — no server change.

### A photo of where it lives

For stock that isn't in an obvious place (owner pull, 2026-10-26: "an option
to take a photo for the location if it isnt in a general place and when
someone wants to check it out they look at the photo to help find it") — and,
after the first week, as a **step of putting stock away** (owner pull,
2026-11-01: "when someone is putting an item into stock, they take a photo of
the general location — there's not always a clear location, someone might log
it wrong, but the photo is the reference"):

- **Adding a new item**: its own step, "Photo of where it's going", right under
  the shelf — "Photograph where it's going" (no longer a "Hard to find?" link).
  It is **prompted, not required**: with none, the Save area says "No photo of
  where it lives — the next person only gets the shelf text" and the item still
  saves (P6 — a failed upload or no camera never blocks putting stock away; the
  owner can make it required with one change if the prompt isn't enough).
- **Setting up a shelf** ("Save and add another"): the next item on the **same
  shelf** is offered the last item's photo — "Same spot as the last item ·
  Different spot" — so a shelf of twenty items is one photo, not twenty. Both
  items point at the one photo (`locationPhotoFromItemId`); a photo another
  item still shows is never retired when one of them changes.
- **Putting stock away on an item that has none** (Add or Return, and the item
  sheet): "No photo of where it lives yet — Photograph where it's going". It is
  saved to the item on its own, straight away — never part of the movement, so
  the add never waits on it or fails because of it. The crew can only **fill a
  missing** photo with one they took; replacing or removing one stays the
  office's, like the shelf text (the server refuses anything else).
- **Whoever comes to take it** sees "Where to find it" — the photo beside the
  shelf text — on the take/return/add confirmation and on the item sheet; one
  tap opens it full screen. A list row with one carries a small camera mark.
- **The office** sees it in the item drawer and can add, replace or remove it
  (the Details tab → "Photo of where it lives").
- It is the item's second photo, stored and served exactly like the product
  photo (`items.location_photo_id`, migration
  `20261026100000_workshop_stock_location_photo.sql`). The option appears only
  once that migration is applied — before then nothing breaks and nothing is
  offered (reads go through `to_jsonb`, writes wait for the column).

### Item types and their fields

Owner pull, 2026-11-01: "Switches aren't interchangeable — Clipsal Iconic tells
me the style, two gang what it is, the colour the colour; at the moment it's
all shoved in the name. Each type of item needs different fields: LED strip is
the colour temperature, the width, the length, the brand, the voltage."

- An item has a **type** (`category`) and **that type's fields** (`specs`, short
  texts). The catalogue of types and fields lives in the app
  (`src/domains/workshop-stock/types.ts`); the database keeps only the shape (a
  lower-case key; an object of strings ≤ 60 characters, ≤ 16 fields). **Brand
  and colour stay in their own columns** — matching and the online check use
  them — and a type simply names them among its fields.
- Values are kept the way a sparky writes them — "2 gang", "4000K", "24V",
  "10mm", "2.5mm²", "2C+E", "IP65" — and what was typed is tidied into that form
  when the field is left ("2g" → "2 gang", "4000k" → "4000K"; "iconic" takes the
  option's spelling), so filters don't split on spelling.
- **Adding an item**: "What is it?" chips, then the type's fields, each with
  one-tap chips — the shop's own values first, then the common ones — and free
  typing. A **label photo fills them** where the label says (deterministic
  reading of the label text, not a second AI call: "ICONIC 2 GANG SWITCH" →
  Switches & GPOs · Iconic · Switch · 2 gang; "4000K 24VDC 10MM 5M" → the LED
  strip's fields), each tagged "Read from photo" to check. The **name follows
  the fields** ("Clipsal Iconic 2 gang switch") while it is empty or still the
  last suggestion — never over a name someone typed or the label gave. Choosing
  a type sets the usual unit (cable: metres) until the unit is picked by hand.
- **Existing items** start **not sorted** (no type) — nothing is sorted by
  guesswork. The office sorts them: the list's **Not sorted** filter, then
  the item's **Details** tab → **Type**; an unsorted item says what it looks like
  ("Looks like LED strip — Use it"), and picking a type fills its fields from
  the name and details, marked "check them before saving". Type edits are
  compare-and-set with the rest of the catalogue and written to the item's
  history.
- Everywhere an item is described (rows, sheets, the office table) its
  identity line reads in its type's fields: "Clipsal · Iconic · Switch · 2 gang
  · White · 3042WE". Search covers the type and its fields ("iconic 2 gang",
  "led strip 24v").

### Categories the office makes

Owner pull, 2026-11-03: "i want to be able to create new catagories when the
need comes up". Owner decisions: **office only** (the crew pick from the list;
Other stays for anything that doesn't fit), and each category gets **a name and
its own fields**.

- **/stock → Categories** (shown once the table exists and types are on): the
  office's own categories — fields, what they're counted in, how many items use
  each — then the built-in ones, read-only. **New category**: a name ("Solar
  inverters"), what new items of it are counted in, and up to 8 fields (Power,
  Phase…). Brand is always there. **Change**: rename it, rename a field, add
  fields — a saved field is never removed or re-keyed, so values already on
  items stay readable. One live category per name (case-insensitive), and a
  name a built-in one has is refused in the form.
- An office category is a type like the built-in ones: its key is `c_<slug>`
  (made on the server from the name; can't collide with a built-in key), its
  fields' values live in `specs` under keys made from their names, each field
  is a **filter** when the crew browse it, values are typed and the shop's own
  become one-tap chips, and the name follows the fields ("Fronius 5kW Single").
  Label photos don't guess office categories — the person picks it.
- How the screens get them: every stock list carries `customTypes`;
  `fetchStockList` puts them into the shared catalogue
  (`types.ts setCustomTypes`, after the built-in ones, before Other), so every
  picker, filter and description sees them. A key not (yet) known reads as
  Other — never lost.
- API: `POST ?action=type { key?, label, unit, fields: [{ key?, label }] }`,
  OFFICE; no key = new (201), a key = change (200; 404 if unknown); 409
  `type_name_taken`; 400 `field_name_invalid` / `field_name_repeated` /
  `type_name_invalid`; 503 `types_unavailable` before the migration. Journaled
  as `workshop_stock.type_created` / `type_changed`.

### Browsing by type

"Someone opens stock when they already know what they need" — so once anything
has a type, level one is the search and **one tile per type** (count, and the
commonest values of its first field: "Iconic · Classic · Saturn"), then **Not
sorted yet** while any are, and **Everything, by shelf** (the old list, one tap
down). Until any item has a type the shelf list stays level one, as before.

A tile opens the type as a sheet: its fields as **filter chips** with counts —
a field is a filter once its items differ on it, and counts follow the other
chosen filters, so a chip never promises items that aren't there (a chip that
would leave nothing is greyed) — then the rows (recorded quantity, where it
lives). An item opened from there has **Back** to the type with its filters
kept; the phone's back gesture closes the sheet.

### Shopping lists

Owner pull, 2026-11-01: "On a job or in the workshop, add a bunch of things —
see what we need to get from the wholesaler and what we have in the workshop —
a list they can go back to and use to go through and find everything."

- **Start a list** (a name, optionally a job — informational, never a job cost)
  from the row under the title ("Shopping lists", or "Your list: Smith reno ·
  5 to get" to resume your latest in one tap), or **Add to a shopping list**
  from any item (your latest open list is picked; or start one there).
- Add **workshop items** (search, then how many you need) or **plain text** for
  something we don't stock ("Clipsal 2000 series blank plate · 3 each").
- The list reads against recorded stock, worked out fresh every time — a view,
  never a record (P7: "6 each recorded", not "in stock"):
  - **In the workshop** — items with stock recorded, in **shelf order** (one walk
    round the workshop), each with how many are needed, how many are recorded,
    the shelf and its photo mark. **Take** opens the ordinary take confirmation
    starting at what the list needs and the list's job; the take **ticks the
    line in the same transaction**, and undoing the take un-ticks it. A take of
    **less** than the line needs (the shelf ran short) collects what it took and
    leaves **the rest on the list as its own line** — nothing needed is lost.
    "Got it another way" ticks it by hand.
  - **Get from the wholesaler** — text lines, items with none recorded,
    archived items, and the **rest of a short one** ("only 2 recorded — get 4
    more"). Tick each as you get it. **Copy or send the wholesaler list** puts it
    in the phone's share sheet (or the clipboard) as plain text with quantities
    and codes, for the counter or a text/email.
  - **Got** — ticked lines, by whom and when; untick by hand (unticking never
    undoes a take — that stays in the ledger).
- Lists are **shared with the crew**: anyone can add to or tick any open list
  (a leading hand can make one for an apprentice). Only its owner or the office
  can **delete** one — apart from everything else, confirmed first (P12).
  **Finished with this list** keeps it a week under "Finished this week"; it
  can be reopened.
- Every change waits for the server and says so when it didn't save. Lists and
  lines carry ids made on the phone, so a retried save is the same row.

### Loose items — out of the box

Owner pull, 2026-11-03: "some items aren't always in packaging" — for taking,
adding and counting.

- **Full boxes + loose in one count.** In box mode (Take / Add / Return, and a
  new item's opening count) a second stepper, **Plus loose — out of the box**,
  adds the singles: "3 boxes + 4 loose = 34". The ledger keeps a pack on a
  movement only when the quantity is exactly count × size (a database rule),
  so a mixed count saves the plain total with no pack, and the server writes
  how it was made up into the movement's note: "3 boxes of 10 + 4 loose". The
  box size the screen showed is still checked (`pack_changed`), and a new
  item still remembers its box size. API: `looseQuantity` beside
  `packCount`+`pack` (move) or `packCount`+`packUnit`+`packSize` (create);
  0 or absent = exactly as before.
- **Pick it by sight.** Take → **Not in its box? Pick it by sight**: the item
  photos, big, in a grid (photos first), narrowed by category chips and by
  typing ("white", "2 gang"). Tapping one opens the same confirmation as every
  other way in ("Picked by sight"); nothing is taken on the grid.
- **What it looks like.** The photo reader still only transcribes what is
  printed; for a loose item with nothing printed it now also says what it
  looks like, in a separate `appearance` field ("white 2 gang switch plate").
  That is never matched on (match.js doesn't read it) and never copied into
  the transcribed fields. On Take, a photo like that leads with **Pick it by
  sight**, narrowed to the category it looks like; on Add, it starts the new
  item's name and type guess, tagged **From how it looks · check** (provenance
  stays "typed", not "photo").

### Barcode scanner and NIIMBOT labels

Owner, 2026-11-03: "i bought a barcode scanner" (a keyboard-style one — it
types the code and presses Enter) and "i have a niimbot printer i want to be
able to create barcodes for items if there's no packaging easily … make sure
it all works easily together".

- **Scanning** (`src/domains/workshop-stock/scanner.ts`,
  `components/stock/useBarcodeScanner.ts`): a scan is told apart from typing by
  its timing (every key within ~50 ms, ≥ 6 characters, then Enter). It works on
  the phone (Bluetooth) and the office computer (USB):
  - **phone stock list** — a listed code opens the item (Take / Return / Add
    from there); several items with it narrow the list; an unknown code starts
    a new item with the barcode kept ("Scanned … · not on the list yet");
  - **Take** — straight to the confirmation (no hold-steady wait; the read is
    certain); several or none as with the camera;
  - **Add or return** — a listed code goes to "What's going in?"; an unknown
    one to the new-item form with it kept;
  - **office /stock** — opens the item's drawer, or Add item with the barcode.
  A scan into a focused text field types into it (the search finds codes). On
  every other stock screen the Enter a scan ends with is swallowed, so a scan
  can never press a focused "Confirm take".
- **Our own barcodes**: an item with no barcode can get one — EAN-13 in the
  GS1 in-store range (prefix 21; 20–29 is reserved for a shop's own codes, so
  never a real product's), made on the SERVER (`codes.inStoreBarcode`). Anyone
  on the crew: `POST ?action=label { itemId }` only ever adds such a code to an
  item with none (an item that has one gets it back); `create` takes
  `makeBarcode: true` for a new item with no barcode. Journaled.
- **The label** (`domains/workshop-stock/label.ts`, `components/stock/BarcodeLabel.tsx`):
  drawn at the NIIMBOT's 203 dpi (8 dots/mm, whole-dot bars, ≥ 2 dots per
  module), the item's name, its shelf on taller labels, the bars and digits.
  Sizes: 40 × 12 and 30 × 15 mm (D11/D110), 40 × 30 and 50 × 30 mm (B1/B21);
  the choice is remembered on the device. **Share to NIIMBOT** (the phone's
  share sheet) or **Save image**, then print it as a picture in the NIIMBOT app.
- **Where**: the phone item sheet (**Print / Make a barcode label**), the
  office drawer (**Label** tab), and the new-item form (**Make a
  barcode label for it** — ticked by itself for a loose item the photo could
  only describe); after saving, the label comes up before the next item.
- **Together**: a loose item → photo ("looks like …") or pick by sight → its
  own barcode → label on the NIIMBOT → from then on the scanner (or the phone
  camera) finds it like any boxed product. Boxes + loose counts and the
  office's categories work the same on it.

### Take stock: photo → identify → confirm → deduct

The photo is read for identification only and **not stored**. Only an exact
catalogue match goes straight to the confirmation; the confirmation shows the
item, brand · code · colour · rating, supplier SKU, the shelf, the recorded
quantity and what matched (e.g. "Matched in workshop · barcode
9300704010017"). The confirmation **re-reads the item** when it opens, so the
recorded quantity and pack sizes are the server's current ones, not the list's
from earlier. Nothing changes until **Confirm take**. A take larger than
what is recorded is refused on the phone and by the database, with the
recorded quantity said plainly ("Only 2 each recorded. If there's more on the
shelf, ask the office to correct the count.").

### Return, count, undo

- **Return** adds back what wasn't used (a separate movement kind from add).
- **Count** (office): "Start a count" pins the ledger version; if anything moved
  while counting, the save is refused and the movements since are listed — the
  counter confirms ("My count is right — save it") or counts again. A count
  records the counted quantity and the difference, and is the item's new
  "last counted".
- **Undo** writes a compensating reversal; nothing is edited or deleted
  ([Permissions and the undo policy](#permissions-and-the-undo-policy)).

### No signal, lost answers

A save is only "saved" when the server says so. Every write carries one
**operation key** for its whole life (retries reuse it), and the phone keeps
each pending save in local storage under its key (several can wait at once),
stamped with the worker's id. If the answer is lost (no signal, 5xx, the phone
killed the app), the form locks with **Try again** (same key — the server
replays the first result, never a second movement) and **Check if it saved**
(asks the server about that key; "not yet" keeps the form locked and the key,
because the first request may still be on its way). The server answers a used
key **before** it reads anything that can change, so a retry replays even if
the item was archived, its pack changed or the job closed in between.
Reopening the screen, closing a sheet, or coming back to the app does the
check by itself and says "Your save went through" — or offers to try again /
discard it (it only calls a save lost once it is older than 90 seconds). A
pending save is only ever read back for the person who made it, expires after
a day, and is cleared on Phil sign-out. A **"Workshop stock can't save right
now"** answer (503 `store_unavailable` / `store_unprovisioned`: the server
refused before trying) is definite — nothing was saved and the form unlocks.
Offline, nothing is queued silently; the screen says it didn't save.

## Identification

`api/_lib/workshop-stock/match.js` — pure, over the live catalogue:

| Evidence | Strength | Notes |
| --- | --- | --- |
| Barcode (GTIN, check digit valid) | 100 | compared as GTIN-14 |
| Manufacturer code, same brand | 90 | 60 when the photo's brand clashes |
| Supplier SKU, same supplier | 85 | 50 when the supplier clashes |
| Code differs only by punctuation | 55 / 50 | "check it" |
| A code matches a different kind | 45 | "check which one" |
| Description words | ≤ 40 | never exact; a colour conflict lowers it |

**Exact** (straight to confirmation) only when exactly one item has clean
evidence of strength ≥ 85 and nothing else competes; otherwise up to five
candidates for the worker to pick from, each with its conflicts named ("colour
differs"). Codes keep their punctuation and leading zeroes for display; the
exact key uppercases and removes spaces. Several products in one reading → the
worker picks the product first. One item per transaction, always.

Description words are compared with **trade names folded** (`trade-terms.js`,
mirrored for the list search in `src/domains/workshop-stock/trade-terms.ts`):
power point / socket outlet / switched socket outlet → GPO, safety switch →
RCD, circuit breaker → MCB, twin and earth / T&E → TPS, junction box → JB,
"twin" → double, plurals singular. Folding only compares — nothing stored or
shown is rewritten.

## Photo reading

`api/_lib/workshop-stock/vision.js` — the same provider and call shape as the
supplier-invoice reader (`invoices/vision-extract.js`): Anthropic Messages API
with a strict JSON schema (structured output), the invoice reader's model
(`INVOICE_VISION_MODEL`) unless `STOCK_VISION_MODEL` is set, 30 s timeout, no
retries.

- **Reads only what is printed.** Per product: brand, manufacturer code,
  supplier SKU and supplier, description, colour/finish, size/rating details,
  barcode digits, pack quantity + unit **only when printed**, the label lines,
  and where it sits in the frame. Missing stays null. There is no count field —
  the model is told not to count items.
- **Untrusted.** Text in the photo is data, never instructions (said in the
  prompt; and nothing it returns is acted on without the worker's
  confirmation). The output is re-validated: codes must fit a strict alphabet,
  barcodes need a valid check digit, pack sizes must be explicit, at most four
  products. A refusal, a truncated or malformed answer, or an outage is a
  status ("Photo reading isn't working right now"), never a 500, and the flow
  continues by search or by hand.

## Online code check

Search the catalogue first (above); only a NEW item's code is checked online.
The pipeline, each piece replaceable:

1. **Search** (`search.js`) — Anthropic's server-side web search tool
   (`web_search_20250305`, `STOCK_LOOKUP_SEARCH_TOOL` to change it) on the
   existing `ANTHROPIC_API_KEY`: no new vendor, no scraping a search engine.
   `allowed_domains` = the allowlist, at most 2 searches, Australian location.
   The query contains only the validated code and brand. We keep only the
   search-result URLs/titles and verbatim cited snippets — **the model's prose
   is ignored**.
2. **Allowlist** (`sources.js`) — manufacturers: clipsal.com, se.com,
   hpm.com.au, legrand.com.au, nhp.com.au, hager.com.au, abb.com, olex.com.au,
   pierlite.com, sal.net.au; wholesalers: rexel.com.au, jrt.com.au, lh.com.au,
   ebranch.online, middys.com.au, haymans.com.au, cnw.com.au,
   idealelectrical.com.au, sparkydirect.com.au. `STOCK_LOOKUP_DOMAINS`
   replaces it. The brand's own sites are searched/opened first.
3. **Fetch** (`safe-fetch.js`) — our own request, SSRF-safe: https only, port
   443, no credentials or IP hosts, allowlisted host; every DNS answer checked
   at connect time against private/reserved ranges (incl. IPv4-mapped/NAT64);
   redirects re-validated (max 3); HTML only; 1.5 MB cap counted after
   decompression; 8 s wall clock. At most 3 pages in a 20 s budget.
4. **Extract + verify** (`page-extract.js`, `verify.js`) — deterministic code,
   no model: the page's JSON-LD Product (name, brand, sku/mpn/gtin, colour),
   title and h1. Statuses:

| Status | When |
| --- | --- |
| **Manufacturer code matched** | the exact code is the page's own code (structured data or title/h1 — a wholesaler's bare `sku` field doesn't count), the brand is confirmed (the maker's own domain, the page's brand, or the brand in the title), no colour/rating conflict, and the code isn't too generic to mean anything |
| **Possible match** | some of that, not all — every missing part is listed as a reason |
| No listing found / Couldn't check online / Online check not set up | said plainly; the item can still be saved |

A worker accepting a listing saves the item as **Manufacturer code matched** or
**Possible match** — the phone names the check it accepted (`lookupCheck`,
exactly what was asked), and the server takes the status from **its own cached
result** for that check, never from the phone — and only while the check
still describes the item: the same code, and the brand / colour / size it was
made for (or that the listing itself showed). Anything else saves as **Saved
without external verification**. A match is evidence that a public listing
uses this code, **not a certification** or a check that it suits the job (said
on the card). Checks are cached per brand + code + colour/size details
(matched 30 days, possible 7, none 3) — a check for the white one is not a
check for the black one. "Couldn't check" is never cached, and neither is a
no-match that couldn't open every page it found; listings found but impossible
to open are "Couldn't check online", not "No listing found". The office can
re-check and record the result on an item; changing an item's maker's code or
brand clears a verification that was for the old one.

## Information kept apart

- **From the photo** — the reading is stored with the photo row (`reading`),
  and the item's `provenance` records which fields came from it.
- **From a listing** — the item's `verification` holds the source URL, title,
  domain, status, reasons and when it was checked; fields filled from it are
  marked `lookup` in `provenance`.
- **Confirmed by a person** — every saved field is what the worker confirmed;
  typed fields are marked `typed`. The listing's name/photo never overwrite what
  a person typed.

## Quantities, units, packs, estimates

- Units: each, metre (to 0.1 m), length, bag, box, roll, pack. Quantities are
  exact integers in thousandths (bigint) — parsed from decimal strings, never
  floating point; a quantity that doesn't fit the unit's precision is refused.
- Packs are an **explicit conversion**: "2 boxes × 10 each = 20 each", shown
  before saving and stored on the movement. A printed pack size is offered,
  never applied silently; a pack size can be remembered as the item's default,
  and a pack barcode can carry its own size.
- **Estimated** — a part-used roll or a rough count is saved as an estimate
  and shown as "≈ 40 m (estimate)" until a real count.
- The unit **locks** once real stock has moved (the database refuses the
  change); archive and re-add instead.
- Zero is "None recorded" — the list is a record, not a promise of what's on
  the shelf.

## Integrity

- **One transaction per write** with the item row locked (`FOR UPDATE`): the
  movement insert and the cached balance change in the same statement (BEFORE
  INSERT trigger) — they cannot drift, and a direct balance update raises.
- **Append-only ledger** (update/delete raise); server-stamped time; actor
  from the session.
- **No negative stock** — refused in the database; the refusal carries the real
  recorded balance.
- **Idempotency keys** unique per company; the request hash (of the request as
  sent) beside each key makes a reused key with a different payload a refusal,
  and an identical retry a replay — answered before anything else is read.
  Concurrent duplicates are resolved by the unique index (proven with 10
  parallel connections); two creates racing with one key queue on a
  transaction lock on the key, so the second replays the first item.
- **Pack sizes as shown** — a pack movement carries the size the screen showed;
  if the office changed it meanwhile the save is refused (`pack_changed`) with
  the new size, never recorded at a size the worker didn't see.
- **Stale-count guard** — a count is pinned to the version counting started
  from.
- **Undo** — one reversal per movement (partial unique index); a reversal can't
  be reversed; it can't take stock below zero; and a movement a later count has
  absorbed can't be undone at all (the count already corrected it — undo the
  count first, or count again). Checked by the API, under the item lock, and
  by the ledger trigger. Each movement keeps the item's estimate flag and
  last-count stamp from just before it, so undoing a count (or an estimated
  add) puts those back too.
- **Server time** — a movement's timestamp is the clock when it was applied
  (after the item lock), so one item's history sorts the way it happened.
- **Catalogue edits** are compare-and-set on a revision that only catalogue
  changes move (details, and a code added/removed that changes a code field) —
  a photo change, an online check or an archive never invalidates an open edit
  form. Archived items can't be edited until restored.
- **Codes follow the item's fields** — removing the code an item shows moves
  its field to the next live code of that kind (or empties it), and a first
  code fills it. Archiving retires the codes (freed for a replacement item);
  **restore** brings back exactly those — never one removed or replaced before
  — and where another item took a code meanwhile, that item keeps it and the
  restore says so.
- **Tenant scope** from the server; composite `(tenant_id, id)` foreign keys.

## Permissions and the undo policy

`api/_lib/workshop-stock/policy.js` — role tiers only, server-side:

| | Field tier & leading hands | Office (admin tier) |
| --- | --- | --- |
| See the list, history of an item | ✓ | ✓ (+ archived, catalogue history) |
| Take / add / return, create an item via Add stock | ✓ | ✓ |
| Photo reading, online check | ✓ | ✓ (+ re-check, record on an item) |
| Undo | own opening/add/take/return, within **30 minutes** | any movement, any time, **reason required** |
| Photo of where it lives | **fill a missing one** with a photo they took | add, replace, remove |
| Shopping lists: read, start, add to, tick (any list) | ✓ | ✓ |
| Delete a shopping list | their own | any |
| Count, edit (incl. type and fields), codes/packs, product photo, archive/restore | — | ✓ |

Clients and unknown roles get 403; signed-out 401. The actor, role and company
always come from the session; bodies are validated (Zod). Office actions —
counts, undos, catalogue changes and the office's own item creation — are
journalled (`workshop_stock.*` audit verbs). The crew's item creation is in the
item's own history (`workshop_stock_item_events`), not the shared audit journal
(one Blob, read-modify-write), so a workshop set-up session can't contend on it.

## Photos: validation, storage, retention

- **On the phone:** orientation applied, downscaled to 1600 px, re-encoded as
  JPEG (which also drops EXIF metadata such as location); a dark photo gets a
  non-blocking hint. A ≤ 320 px copy is made alongside for lists.
- **On the server:** at most 3 MiB; the type is sniffed from the bytes (JPEG,
  PNG, WebP — never trusted from the client), the dimensions are read from the
  header (64–10,000 px).
- **Storage:** Vercel Blob under `workshop-stock/<company>/photos/` with a
  random suffix; the URL never leaves the server — photos are served only
  through the authenticated `?action=photo` proxy (`nosniff`, private cache).
  Lists ask for `&size=thumb` (the small copy, ≤ 200 KB JPEG; the photo itself
  when there isn't one), so a long list never downloads every label shot.
- **Retention:** take photos are not stored. An add photo is **pending** for a
  day — claimed by the item it becomes, otherwise deleted. A replaced item photo
  is retired and deleted a day later. An expired photo can't be claimed, and a
  deletion marks the row first and removes the blobs second (a failed blob
  delete is retried), so a save and a clean-up can never both win. Clean-up
  runs alongside the next photo upload's own work (capped at 4 s), not in
  front of it; nothing else is kept.

## Limits and cost

| Control | Value |
| --- | --- |
| Photo reads per person | 30 per 10 minutes (per warm instance) |
| Camera table reads per person | 300 per 10 minutes (per warm instance) |
| Online checks per person | 20 per hour (per warm instance) |
| Daily ceiling per company | `STOCK_DAILY_PHOTO_READS` (300), `STOCK_DAILY_LOOKUPS` (60), `STOCK_DAILY_INTAKE_READS` (2000, the camera table's own, so a big session can't use up the crew's reads) — durable, in Postgres |
| Per check | ≤ 2 searches, ≤ 3 pages, 20 s page budget; cached per brand + code + colour/size |
| Function duration | 60 s (`vercel.json`) |

Costs are Anthropic API usage on the existing key: tokens for each photo read
and check, plus the web search tool's per-search price. Measured cost is not
known until real use — watch the usage counters (`workshop_stock_usage`).

## Configuration

| Env | Purpose |
| --- | --- |
| `FLAG_WORKSHOP_STOCK` | optional env pin for the flag (normally flipped at `/owner`) |
| `ANTHROPIC_API_KEY` | existing key (receipts/invoices) — photo reading + search |
| `STOCK_VISION_MODEL`, `STOCK_LOOKUP_MODEL` | override the model for photo reading / the search turn (default: the invoice reader's model) |
| `STOCK_LOOKUP_SEARCH_TOOL` | the web search tool version |
| `STOCK_LOOKUP_DOMAINS` | replace the source allowlist, e.g. `clipsal.com=manufacturer:clipsal,rexel.com.au=supplier` (see `sources.js`) |
| `STOCK_PHOTO_READ_DISABLED=1` / `STOCK_LOOKUP_DISABLED=1` | turn photo reading / online checks off; the flows fall back to search and by hand |
| `STOCK_DAILY_PHOTO_READS`, `STOCK_DAILY_LOOKUPS`, `STOCK_DAILY_INTAKE_READS` | daily ceilings |
| `BLOB_READ_WRITE_TOKEN` | existing Blob store (photos) |

## Data

Migrations (additive): `supabase/migrations/20261009100000_workshop_stock.sql`,
then `20261026100000_workshop_stock_location_photo.sql` (one nullable column,
`workshop_stock_items.location_photo_id`, re-runnable), then
`20261101100000_workshop_stock_types_and_lists.sql` (re-runnable):
`workshop_stock_items.category` (a lower-case key or null) and `.specs` (a jsonb
object, default `{}`), and the tables `workshop_stock_lists` and
`workshop_stock_list_lines` (ids from the phone; composite tenant foreign keys
to items and movements; a list's lines go when it is deleted). Tables from the
first: `workshop_stock_items`, `_identifiers`, `_movements`, `_item_events`,
`_photos`, `_lookup_cache`, `_usage`.
`20261102100000_workshop_stock_location_matrix.sql` (re-runnable) adds
`workshop_stock_location_matrix` and the camera table's `intake_read` counter.
`20261103100000_workshop_stock_custom_types.sql` (re-runnable) adds
`workshop_stock_types` — the office's categories (key `c_<slug>`, label, unit,
fields jsonb ≤ 8; one live label per tenant, case-insensitive); the store finds
it as `schemaFeatures.customTypes` and the list says `capabilities.customTypes`.

**Deploy order is free** for both later migrations: the store reads the new
columns through `to_jsonb(i)` (absent → null / `{}`) and finds what the database
has once per warm instance (`schemaFeatures`, re-checked every minute while
anything is missing). The list says what exists (`capabilities.locationPhoto`,
`.types`, `.lists`); the screens offer an option only once it does; writes wait
for their column; every list path answers 503 `lists_unavailable` until the
tables exist. RLS on, no policies (service-role only — the house
pattern; see [architecture/supabase-rls-access-matrix.md](architecture/supabase-rls-access-matrix.md)).
The integrity rules above live in its triggers and indexes. The down path is in
the file's header (drops, in order — only for abandoning the feature, after an
export).

## Surfaces and navigation

- Phone: a **Workshop stock tile on Today** (`/phil/my-day` — in the Quick
  grid of the redesigned Today, as a card under "Log my hours" on the default
  one; owner pull, 2026-10-26: "a tile on the today page, not hidden behind
  profile"), plus the card in the More screen's reference group (`/v2/phil`).
  Both show only while the flag is on. **No tab** — the tile enters Today's
  existing Quick slot, the way Log a receipt did (P10). Level one of
  `/phil/stock` is one decision: Take stock or Add or return, two doors pinned
  at the bottom; Return and per-item actions are one tap down. The type tiles
  **replace** the shelf list in the same reading slot (adding requires
  removing — the shelf list is one tap down), and shopping lists enter as one
  resume row under the title and as context on an item (P10 slots: the ranked
  next action, context on a record) — no new door, no new tab. Quantities are
  labelled as recorded (P7); copy is site language (P11); undo sits on the
  receipt it undoes, never by the doors, and archive sits apart from
  everything (P12); the phone's back gesture closes an open sheet instead of
  leaving the page (P8). Every state is a designed slot in the flow — a
  waiting save, a refused take, a photo reader that is off — never an error
  page; several waiting saves collapse into one card so the doors never move.
- Live code reading runs in the browser (`BarcodeDetector`, Chrome on Android
  today); where it isn't available the viewfinder says so in one sentence and
  search, "You often take" and the label photo carry on. "You often take" and
  the pending-save memory live in the phone's storage per worker and are
  cleared on sign-out.
- Office: "Workshop stock" in the People & gear nav group, flag-gated.
- Routes: [route-ownership.md](route-ownership.md) §4/§8/§9.

## Activation (operator steps — none performed by the PR)

1. Merge the PR (squashed, `main` only).
2. Apply `20261009100000_workshop_stock.sql` — and, for the photo of where an
   item lives, `20261026100000_workshop_stock_location_photo.sql`, and for item
   types and shopping lists, `20261101100000_workshop_stock_types_and_lists.sql`,
   and for the camera table and location matrix,
   `20261102100000_workshop_stock_location_matrix.sql`
   (each safe to apply before or after the code ships; its options appear
   within a minute of it) — to the **dev** project, then to
   **production** as an operator release step (Supabase migration process —
   never from an agent session **unless the owner explicitly approves it for
   that release**). Confirm the nine tables exist with RLS on (the seven from
   the first migration, plus `workshop_stock_lists` and
   `workshop_stock_list_lines`).

   *Record, 2026-11-01:* `20261101100000_workshop_stock_types_and_lists.sql`
   was applied from an agent session **with the owner's explicit go-ahead for
   this release** — to dev first (verified), then to production (migration
   history name `workshop_stock_types_and_lists`). It was verified afterwards:
   new columns and both tables present, RLS on with no policies, the 5
   existing items and 5 movements unchanged. The exception covers that release
   only; the default above stands.

   *Record, 2026-11-02:* `20261102100000_workshop_stock_location_matrix.sql` was
   applied from an agent session **with the owner's explicit go-ahead for this
   release**, while its PR was still open (deploy order is free) — to dev first
   (verified with a rolled-back write), then to production (migration history name
   `workshop_stock_location_matrix`). It was verified afterwards: the table present
   and empty, RLS on with no policies, `intake_read` allowed by the usage counter,
   the 5 existing items, 5 movements and 2 usage rows unchanged. The exception covers
   that release only; the default above stands.
3. **Production writes are opt-in for every Supabase-backed feature**: the env
   guard (`api/_lib/supabase-env.js`) refuses a write connection to production
   unless `SUPABASE_ALLOW_PRODUCTION_WRITES="true"` is set in Production (see
   [supabase-environment.md](supabase-environment.md) and [supabase-foundation-runbook.md](supabase-foundation-runbook.md)).
   Without it every stock save answers 503 `store_unavailable` and the phone
   says "Workshop stock can't save right now — nothing was saved"; reads still
   work. Confirm it is set (an operator decision, not this PR's) before the
   flag goes on.
4. Confirm `ANTHROPIC_API_KEY` is set in Production and that **web search is
   enabled for the organisation** in the Claude Console; leave the stock env
   vars unset to take the defaults.
5. On a preview with the migration applied: flip the flag for the preview
   only, photograph two or three real products, take one, undo it, return
   one, and count one from the office. Check the source links the online
   check shows and that nothing from the preview remains (archive the test
   items).
6. Flip `workshop_stock` on at `/owner` (audited). Record the effective state
   in [runbooks/production-flag-verification.md](runbooks/production-flag-verification.md).
7. Set up the workshop with real stock as a deliberate job (Add stock → Save
   and add another).

## Rollback

- **Flag off** at `/owner` → every surface and API path 404s at once; the data
  stays (nothing is deleted when the flag goes off) and comes back as it was.
- Photo reading or online checks misbehaving alone →
  `STOCK_PHOTO_READ_DISABLED=1` / `STOCK_LOOKUP_DISABLED=1`.
- A wrong movement → Undo; a wrong balance → Correct the count. No job cost is
  ever written, so jobs need no repair.
- Removing the tables is a separate, deliberate decision (export first; the
  down path is in the migration header).
- [runbooks/rollback-and-incident.md](runbooks/rollback-and-incident.md) has the row.

## Testing

| Layer | What | Run |
| --- | --- | --- |
| Unit | quantities, codes, barcodes, matching, trade names, variants, extraction, verification, SSRF guards, client decisions, pending saves (several, per person, the 90 s "lost" rule), the phone's copies of server rules (parity); the type catalogue, value tidying, guessing a type and its fields from label text, filters and their counts, suggested names (`types.test.ts`); a list read against stock — workshop in shelf order, short lines in both, the wholesaler text (`lists.test.ts`) | `npx vitest run src/domains/workshop-stock src/components/stock` |
| API | the real handler with mocked store/AI: auth, flag 404, office-only, actor from session, idempotency keys answered first, pack size as shown, the accepted check re-validated, uploads + list copies, photo clean-up order, cache keys, statuses; types and fields (validated, dropped before the migration, office-only edits); the crew filling a missing photo of where it lives; lists (503 before the migration, owner from the session, jobs resolved, quantities in the item's unit, delete rights), a take ticking its line | (same; `workshop-stock-api.test.ts`) |
| Postgres | the store + triggers against a real local Postgres: atomic ledger, no negatives, concurrent takes (10 connections), idempotent replays/conflicts (incl. two creates racing with one key), replay after archive, stale counts, one-time undo, counted-since, undoing a count restores its estimate/last-count, server time order, atomic create, tenants, archive/restore codes, code fields following codes, verification cleared on a code change, edit revision, photo claim vs clean-up, cost ceiling, cache per colour; types saved/read/edited compare-and-set; one shelf photo shared by two items and never retired while either shows it; the crew filling (never replacing) a photo with their own; lists started once per id, lines once, other tenants' ids refused, delete rights; a take ticking its line in the same transaction, once, a failed take ticking nothing, the undo un-ticking it. Also run against a database WITHOUT `20261101100000`: everything but the three types/lists tests passes (deploy order) | `WORKSHOP_STOCK_PG_TEST=1 SUPABASE_ENV=local SUPABASE_PROJECT_REF=localstack SUPABASE_DB_URL=postgres://…@localhost:5432/<db> npx vitest run src/domains/workshop-stock/workshop-stock-store.pg.test.ts` (migrations applied to `<db>`) |
| Browser E2E | phone (Pixel 7) + desktop, real pages + real handler + real local Postgres; the photo reader's model answer, the search response and the listing pages are **fixtures** (`scripts/qa/workshop-stock-e2e/harness.js`) | below |

Browser E2E, locally (never against a hosted database — the harness refuses a
non-localhost URL):

```bash
# 1. a local Postgres with every migration applied and a 'buhl' tenant row
# 2. the harness: the real /api/workshop-stock on :3101
WORKSHOP_STOCK_E2E_DB_URL=postgres://…@localhost:5432/<db> SESSION_SECRET=<16+ chars> \
  node scripts/qa/workshop-stock-e2e/harness.js
# 3. the app, flag on, same secret
SESSION_SECRET=<same> FLAG_WORKSHOP_STOCK=1 npx next dev -p 3000
# 4. the spec (optionally WORKSHOP_STOCK_E2E_CHROMIUM=<path> for a preinstalled browser)
WORKSHOP_STOCK_E2E_API=http://localhost:3101 npx playwright test tests/workshop-stock --project=desktop-chrome
```

`tests/workshop-stock/camera-table.e2e.spec.ts` runs the same way. Its webcam is a
canvas the spec draws on, so the real tracker finds real objects in real frames, but
the barcode detector and the label reader's answers are fixtures: **real webcams,
lighting and labels are not proven**, and neither is the speed or cost of real reads.

The spec covers: More → Workshop stock; add by photo with the online check and
packs (the listing never renames it; a changed brand makes the check stale);
search by trade name; list photos as small copies; photograph again and take;
Undo; take from the list; return; a lost answer recovered by Try again (one
movement) and by reopening (reconciled); several products → which one; unknown
product → add as new; reader and check both down → by hand (container-unit
hint); the office list, filters, history, the stale-count path, an audited
undo, the counted-since refusal; the worker seeing the office's count; the
office list at phone width. And, from the review: the confirm screen's fresh
read stopping a take a stale list would allow; a pack re-sized mid-confirm;
"Check if it saved" keeping the key; two unanswered saves reconciled after a
reopen; "can't save right now" unlocking with nothing pending; the office
undoing from the phone with a reason; an abandoned photo cleaned up; restore
reporting a code another item took; an edit in progress surviving a reload and
flagging someone else's edit. It fails on any page error, console error or
failed request that isn't named as environment noise in the spec.

## Deliberately out of scope

Tool custody, vans and transfers, reservations, purchase orders and
reordering (a shopping list is a plan someone carries, not an order — nothing
is sent to a supplier), supplier integrations, custom types defined in the app
(the type catalogue is code; a new type or field is a small change), valuation, invoice-to-stock posting, job
costing, mandatory job selection, analytics, a general assistant.

## Known limitations

- Live provider behaviour is unproven: real label photos, real search results
  and real supplier pages may read or verify worse than the fixtures. Expect to
  tune the allowlist and verification rules from the first real checks.
- Per-person rate limits are per warm serverless instance (the daily ceilings
  are durable).
- Offline means "not saved, said plainly": there is no background queue that
  sends later — the pending save is reconciled when the worker comes back.
- Photos are validated and re-encoded on the phone; a client that bypasses the
  app could store a photo with its original metadata (the server sniffs type
  and size only).
