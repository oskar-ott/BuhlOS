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

- The full list read by shelf with filters (None recorded · Estimates · Code
  not confirmed · Archived — counts read "—" when the list didn't load), when
  each item last moved and was last counted, and the product-code status with
  its reason ("Possible match — colour not confirmed"). No KPI row, no gauges.
- Per item, ordered by use: what's recorded and **correct the count** (counting
  starts when the drawer opens; a stale-count guard shows what moved
  meanwhile), the full movement history with **Undo** (any movement, a reason
  required, written into the history), the **catalogue folded** (details with
  a compare-and-set conflict block, codes / barcodes / pack sizes, the online
  code check, the photo, the item's own history), and **archive last and
  apart** (confirmed; read-only after; restore says which codes come back).
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
  bin, see what's in each bin, and place stock that has no bin. The Add form uses it
  too. All [below](#camera-table-and-location-matrix).

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
   a dashed red box.
2. It counts once it has sat still for 0.8 s. A blob touching the edge of the
   table area is an arm: it never counts, and only what it actually lies on counts
   as covered, so an arm resting across the table doesn't hold up the rest of it. A
   nudged object is the same object. Objects pushed together turn amber ("Touching:
   move them apart") and any that split off count then. A difference with no hard
   edge of its own is a shadow, never an object. Pieces within about 2 cells of each other
   are one thing, because a clear bag shows only its label, product and glare. Something
   already counted keeps to its own box, so the next thing put down beside it stays
   separate; two things put down together that close are one.
3. **Nothing arrives without a hand near it or a sudden jump in the picture,** so glare
   creeping in or a patch the focus has shifted never counts: it gets no box and after 3 s
   is taken as table. Three or more new things at once with no hand in shot is the picture
   itself jumping: "The picture isn't steady" shows and nothing new counts for 1.5 s.
   **Nothing leaves the table unless a hand was over it.** A shadow crossing an
   object or the light changing can't make it count twice. A spot a hand has emptied
   is free again in about half a second, and a different-looking object found where a
   hand has just been is a new one, so a pile can be worked through one spot.
4. A crop of the full-size frame is taken. **A barcode** in it is matched against the
   list right there, trying up to three frames, because barcodes are free and a webcam
   often refocuses just after a hand leaves. Otherwise the sharpest frame goes to the
   **label reader** (the same one as the phone, four at a time, retried once by itself
   if it fails in passing).
5. **An exact barcode or code match logs by itself** and the box turns green.
   Words alone never do, because two GPOs look alike: "Is it one of these?" stays
   red until someone picks, and a pick teaches the item every code printed on it, so
   the next one logs itself. An exact code match also keeps a barcode it saw, so the
   next one is free and instant.
6. **Not on the list:** stays red with one card, already filled in: name from the
   label, amount, location from the matrix, or a suggested free bin with its reason.
   One tap adds it. Anything else waiting with the same code shares that card and logs
   with it, and so does every later one.
7. **No label it can read:** the card says to turn it label up, and turning it over
   reads it again. Taken away unread, it stays in the log as "Not logged", with its
   picture and a way to read it again, so a missed item can't vanish silently.

**Amount.** A loose item adds 1. A box printed "Pack of 10" of something counted
each adds 10, and the row says the size came from the label. An item counted in
boxes adds 1 box. A length is never guessed: without a printed length it asks.
A pack size of 100 or more, or one that differs from what that item's label said
earlier in the session, is checked with a person once, then trusted: a misread "1000"
would otherwise go straight on the record. Any logged amount can be changed afterwards, which undoes that movement and records
a new one, both in the item's history. Each placement is its own ledger movement
with the note "Camera table" and its own idempotency key, so a lost answer retried
is never counted twice, and Undo takes back that one placement.

**The first-session routine.** With an empty list every product is new, so the screen is built
for: put one down, wait for the box, type how many, Enter. Digits typed with no field in use
go to a new card's count, or to the amount of what just logged; letters go to a new card's
name and never run a shortcut there (`typedInto`). A count already in a box is replaced, not
added to. A blank name gets the cursor. Esc is "not stock" on a new card. Waiting cards and what
was typed in them survive a reload, without their photos (`intake-session.ts`).

**Talking instead of typing (owner pull, 2026-11-04).** `Talk` (or `V`) opens the microphone until
it's turned off or someone says "stop listening", for when both hands are full. Say what it is and
how many, then "add it", in one breath or over several: "Iconic single switch, forty, add it",
"100 metres of TPS", "rack 3 shelf B bin 4". A strip under the button shows what can be said for the
card that's open. `parseSpoken` (`spoken.ts`) splits the words:

- A number on the end, or "forty of…", is how many. A number that belongs to the product stays in
  the name ("cat 6", "IP 65"); "cat 6 times 10" says otherwise. A wrong split shows in the box.
- The first name said replaces what the label gave; later phrases add to it, because a recogniser
  ends a phrase at any short pause. "Scratch that" puts the card back to before anyone spoke.
- **Saving by voice** is "add it", "log it" or "save it" (also "add that" and so on) on the end of a
  phrase or alone, or "done" alone. Enter still works. A spoken save goes through the same checks as
  Enter, so a card with no name stays open and says so. "Undo" takes back the last one logged, once
  nothing is still on its way to the record. Only these fixed phrases act, so talk nearby can
  fill a box, which shows, but can't save unless it says one of them.
- Said while a label is being read, the words are held and land on the card when it opens. With
  more than one being read it asks you to wait, since it can't tell which one you mean. If the read
  logs by itself, a count that was said changes that amount.
- A number alone fills a new card's or amount card's count, or opens the amount on what just logged;
  "log it" lands it, "sixty log it" does both.
- A list on a card is picked with "number 2", "pick two" or "the second one". Search results carry
  on the card's numbering. A bare number never picks, because "to" and "for" get heard as numbers.
  The words search the list on a pick or problem card. "Not stock" and "read it again" do what those
  buttons do.
- The cursor in "Goes to" takes the words as they are, for a bin with no rack and shelf in its name.

It uses the browser's own speech recognition (`useSpeech.ts`, `en-AU`): no BuhlOS server or cost, but
Chrome sends the audio to Google to turn into words, so it needs the internet. A browser without
it (Firefox) shows no button. Proven only against a stand-in recogniser in
`camera-table-flows.e2e.spec.ts`; accuracy on trade words, on the save phrases, a real microphone and
workshop noise are unproven. The phone and office Add forms aren't changed: a phone keyboard already
has a microphone.

**"All the same"** on a logged row, offered by itself after three in a row: everything
placed from then on logs as that item and amount with no read at all, until Stop. For a
run of identical items, and for loose items with no readable label.

**A hand scanner** (USB or Bluetooth, the kind that types like a keyboard) works on this
screen with no setup. A scan goes to the oldest waiting card with no barcode of its own,
and never replaces a barcode a card already has (`cardForScan`). Otherwise, with the table
running, it names the next thing placed, which then logs without a read, unless that
barcode is already waiting on the table; with the table stopped, each scan is +1 by
itself, and a barcode the list doesn't know gets its own card, repeats sharing one. Keys
arriving faster than anyone types, then Enter, are taken as a scan (`feedScan`), even with
the cursor in a field: the field goes back to what it held and nothing saves.

**Setting up.** "Table area" draws the part of the picture the table fills; anything
outside it is ignored and its edge counts as the picture's edge. Reading the empty table
restarts if something moves, sets its sensitivity from the sensor noise it measures, and
says if the table is too dark, blown out, grainy or busy. Where a webcam allows it,
exposure and white balance are held while counting ("Exposure: Held"; not every webcam
does, and whether a real one does is unproven). Pale stock vanishes on a white mat and
dark stock on a black one, so use a plain mid-coloured mat. Small print needs pixels:
at 1920 wide across a 1 m table that's under 2 px per mm, so bring the camera as close
as the table allows, or use a 4K one.

**Light.** Exposure and white balance are allowed for per brightness and per channel,
because exposure moves bright pixels further than dark ones (`toneCurve`). Frames are shrunk
with averaging (`imageSmoothingQuality`): the canvas default only samples the big picture,
which keeps three times the noise, measured in Chromium.

**When things go wrong.** A webcam that stops or freezes shows "Camera lost", counting
pauses, and it reconnects by itself and waits for "Carry on". The log survives a reload,
Undo included, for 12 hours, on that computer only. A reload with reads or cards still
open asks first.

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
- **Keyboard:** `Space` pause, `U` undo the last one, `Enter` add the open card, `1`–`9`
  pick a choice, `X` ignore, `R` read again, `F` full screen, `M` sound, `V` talk.
- **Cards queue oldest first** with the same number as the box on the picture, and only
  one is open, so what's being typed into never moves. Hover a card to find its box.
- **The status bar only shows measured values:** the camera's real resolution and frame
  rate, what's on the table now, barcodes read, label reads and their median time,
  whether exposure is held, and how many bin rules exist. The analysis rate appears only
  when it falls behind.
- **An arm gets a faint wash**, so it's plain it has been seen and isn't being counted.
  Something still at the edge gets "AT THE EDGE · NOT COUNTED", because a thing half out
  of shot would otherwise be ignored in silence.
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

**The Add form** (phone and office) uses the same matrix, which is why anyone adding
stock can read it; only the office changes it. Until someone types or picks a location,
a rule that fits fills it in, following the name and codes as they change, and it takes
priority over "Same as last item". With no rule, the form offers a one-tap suggestion,
and Rack → Shelf → Bin buttons pick any bin. Typing still works, and a typed location is
never overwritten. If the matrix can't load, the form is the same as before.

**The shelf map** is the same grid, showing what the recorded stock says is in each bin
(read from each item's location text). Click a bin to see what's in it and Move any of
it. "Needs a place" lists stock with no location, a location that isn't a bin on the map,
or a bin different from its rule. "Put it here" takes the suggestion; "Choose a bin" lets
you click another. Stock only moves from those taps, each one an ordinary item edit.
Renaming a rack or making it smaller doesn't rewrite items: anything left behind appears
under "Needs a place".

**A suggestion is a stated reason, not a score** (`location-map.ts`): a rule that fits,
even if that bin is in use; then the free bin closest to the same type; then the same
brand; then the first free bin. A free bin holds no stock and no rule. It doesn't know
how often an item is taken or how big anything is, so it never claims a "fastest" or
"best fit" spot.

**A recommended layout** ("Recommend a layout" on the same screen, `location-layout.ts`)
keeps related stock together once the racks exist: GPOs beside switches, patch leads beside
data jacks. It sorts stock into groups by the words on its name, in the same way a rule
matches, then runs the groups along the racks in one path that turns back at the end of
each shelf, so neighbours stay neighbours over the turn. A group with several ranges (or,
with no range on the label, several brands) gets a bin for each, plus one for the group.

- It's shown on the racks first. "Use this layout" saves ordinary rules, so new stock goes
  there. Recorded stock doesn't move: it appears under "Needs a place" for a tap each.
  Undo puts the rules back, but anything already moved stays where it was moved to.
- Rules already set are kept, and that family grows out from them, unless "Keep the rules
  already set" is unticked, which replaces them.
- Bins holding stock that no group covers are left alone. That stock is listed as "Not in
  any group", because a rule can't catch a name that doesn't say what it is.
- With room for every usual group, or with no stock at all, it readies them all, including
  groups with no stock yet. Otherwise it only places the groups stock has.
- Groups in a family sit touching, and any free bins go after the family. A family that
  wouldn't fit in what's left of a rack starts on the next rack if there's room to spare.
  With more groups than free bins, neighbours share a bin and the screen says so. Once
  saved, those free bins are just free bins: nothing reserves them for the family.

**The groups and their order are trade judgement written down in `LAYOUT_FAMILIES`, not
measured.** It doesn't know how big anything is or how often it's taken, or which way
shelves or racks run in the real workshop, so it only ever says what sits together.
Cable on drums won't suit a bin, and a person should change that kind of thing by hand.

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
  (catalogue → "Photo of where it lives").
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
  Catalogue → Details → **Type**; an unsorted item says what it looks like
  ("Looks like LED strip — Use it"), and picking a type fills its fields from
  the name and details, marked "check them before saving". Type edits are
  compare-and-set with the rest of the catalogue and written to the item's
  history.
- Everywhere an item is described (rows, sheets, the office table) its
  identity line reads in its type's fields: "Clipsal · Iconic · Switch · 2 gang
  · White · 3042WE". Search covers the type and its fields ("iconic 2 gang",
  "led strip 24v").

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
| `STOCK_INTAKE_VISION_MODEL` | the camera table's label reader only (default: same as the phone's). Choose with `scripts/qa/label-reader-compare.js` |
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

`tests/workshop-stock/shelf-map.e2e.spec.ts` (Add form, bin picker, shelf map, moves,
the crew's read), `tests/workshop-stock/layout-plan.e2e.spec.ts` (recommended layout, use,
undo), `tests/workshop-stock/camera-table.e2e.spec.ts` and
`tests/workshop-stock/camera-table-flows.e2e.spec.ts` (noisy picture, a pile through one
spot, the queue, a pack check, a scanner, a reload, a table area, a camera knocked out)
run the same way. `intake-bench.test.ts` runs the real tracker against a simulated camera
(noise, exposure, white balance, shadows, arms) in the unit suite; `BENCH_ALL_SEEDS=1`
also runs the long random soak. These prove the logic against a simulation written by the
same author. They are not evidence about a real webcam. `intake-photo.test.ts` does the
same with real pixels: three clear bags on a woodgrain desk, from the owner's screenshot of
the first real run (`tests/fixtures/camera-table/`, the table under the bags partly rebuilt,
the arm drawn). It is one photo, not video. For real video, `/stock/intake?evidence=1` has
"Record clip", which saves up to a minute of what the webcam sends to that computer. Each resets the
harness, so run them one file at a time. The camera spec's webcam is a
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
