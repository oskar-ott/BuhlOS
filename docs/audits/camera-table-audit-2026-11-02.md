# Camera table: is it usable, and is this the best setup? (2026-11-02)

Owner asks: "examine and audit what needs to be tweaked added edited to make this usable
and ready, focusing on usability, speed, accuracy, UI, UX", then "make sure the current
setup is the best, don't be biased one way or another".

**Verdict.** The design is the right one to test, not a proven best. It has still never
seen a real webcam or a real label. Counting logic was badly wrong and is now much better
in simulation. The biggest open question is physical, not software: whether an overhead
webcam resolves small print and barcodes well enough. A timed trial decides (below).

## How it was measured, and the limits of that

A simulated overhead camera (`src/domains/workshop-stock/intake-sim.ts`) with sensor noise,
exposure and white-balance shifts, shadows, arms and low-contrast items, driving the real
tracker. Then the real screen, real handler and a local Postgres in a real browser, with a
noisy canvas as the webcam and fixture reader answers.

**Author bias is real here.** The same person wrote the simulator and the fixes, and tuned
the thresholds against it. A randomised soak was added for that reason, and it caught a
fault every hand-picked scenario had passed. Treat all numbers below as simulation.

| Measure (simulated) | Before | After |
|---|---|---|
| Hand-picked scenarios right | 15 of 23 | 32 of 32, on 5 seeds |
| Pile worked through one spot, 15 items | 1 counted | 15 counted |
| Random soak, 1,125 placements, miscounted | not run | 0.8% (14.4% before the hand rule, first soak) |
| Same soak, excluding the white mat | not run | 2 of about 900 |
| Browser tests passing, shelf map included | 6 | 15 |
| Analysis cost per frame | not measured | about 3 ms (720p canvas; a real 4K webcam is unmeasured) |

Known limits that stay: two items placed touching count as one; an identical item swapped
with the spot never seen empty counts as one; turning a logged box over counts again (Undo
is one key); pale stock on a white mat is missed, which is 7 of the 9 soak errors.

## What was wrong

**Accuracy**
- A swap in one spot within 1.5 s was never counted: the old track claimed the new item.
- An arm's *bounding box* counted as covering things, so a diagonal arm stopped most of the
  table settling.
- Shadows were counted as objects, and so was the patch left by anything on the table at Start.
- A shadow or light change made an item "leave" and count again on return.
- A second item stacked on the first was never counted.
- White balance shifts were corrected as one number across all channels.
- Light-following could slowly learn a low-contrast object into the background.
- One frame was all a barcode got, often while the webcam was still refocusing.
- A pick only taught a barcode, so anything identified by a printed code asked every time,
  against the owner's "one tap, then automatic".
- A misread pack size went straight on the record.
- Starting before the list loaded made every known item look new.

**Speed**
- Two reads at once; no retry on a passing failure, so each one needed a tap.
- A read was paid for even when an identical barcode was already waiting on a person.
- Each logged crop stayed in memory for the session (up to about 100 MB over 200 items).
- The analysis canvas was reallocated on every frame.

**Usability**
- New cards pushed the card being typed into down the screen.
- Every new item opened a full form, including repeats of the same product.
- No link between a card and its box on the picture.
- A half-in-shot item was ignored in silence.
- A frozen webcam still said "Live".
- A reload lost the log and Undo.
- The first sign the reader was off was a failed read per item.
- Log rows were tall, and repeated "Set location" per placement.
- Keyboard covered pause and undo only, so every card needed the mouse.

All of the above are fixed and tested, apart from the limits listed. Teaching and scanner
behaviour are real server writes in the browser tests.

## The setup against the alternatives

Weak evidence is marked. Independent head-to-head data barely exists for this.

| Decision | Now | Alternative | Verdict | Evidence |
|---|---|---|---|---|
| Finding objects | Background subtraction | A trained detector in the browser | **Keep.** A fixed camera suits it; common detector models aren't trained on switch mechanisms, and report no count of unknown items | Reasoning. Search found no comparison |
| Identifying barcoded stock | Overhead camera | Handheld scanner | **Add the scanner, don't replace.** More certain per item, but ties up a hand and needs aiming. Now works on the same screen | Vendor claims only, and they favour overhead |
| Reading printed labels | Cloud Claude, one crop | Model on the Mac | **Keep for now.** A local model adds an install and, per one paper, 1.5–4 s image encoding per read. Worth revisiting if cost or privacy matters | One paper, not your Mac or labels |
| Where live work runs | Browser on the Mac | Cloud video | **Keep.** About 3 ms per frame leaves plenty of room; streaming adds lag and cost | Measured in test only |
| Reader model | `claude-opus-5`, inherited from the invoice reader | Opus 5.5, Sonnet 5.5, Haiku 5.5 | **Unknown, so unchanged.** Opus 5.5 is newer and listed cheaper. A cheaper model only earns its place if it doesn't misread codes | `scripts/qa/label-reader-compare.js` measures it on real crops |
| Camera | Whatever is plugged in | 4K, or closer | **Likely matters most.** See below | Arithmetic, not measured |

**Resolution is the biggest physical risk.** Pixels per mm on the table:

| Table width in shot | 1920 wide | 3840 wide |
|---|---|---|
| 1 m | 1.9 | 3.8 |
| 60 cm | 3.2 | 6.4 |
| 40 cm | 4.8 | 9.6 |

A standard EAN barcode's narrowest bar is about 0.33 mm, and as a rule of thumb a reader
wants about 2 pixels per bar, so roughly 6 px/mm. On that rule a 1080p webcam over a 1 m
table won't read barcodes, and small codes will be marginal. That rule of thumb is not
measured on this setup.

**Rough cost per label read** (about 3,000 tokens in and 400 out, an estimate): Opus 5 2.5c,
Opus 5.5 2c, Sonnet 5.5 1c, Haiku 5.5 under 0.1c. The daily ceiling of 2,000 reads is about
US$50 a day at worst on the current model. Barcodes cost nothing.

## The trial that decides it

Fifty mixed items, some barcoded, some not, some small. Time each method and count errors.

1. Camera table alone.
2. Camera table with the scanner in hand for whatever it can't read.
3. Scanner alone, typing the rest.

Suggested thresholds, the owner's to change: if under half the items log by themselves, or
more than 1 in 50 are miscounted, the camera table shouldn't be the default for that stock.
Open `/stock/intake?evidence=1` for the session and press "Crops" in the log to feed the
reader comparison.

Sources: [Chrome shape detection](https://developer.chrome.com/docs/capabilities/shape-detection),
[MDN compatibility data](https://chromium.googlesource.com/external/github.com/mdn/browser-compat-data/+/HEAD/api/BarcodeDetector.json),
[Native LLM and MLLM inference on Apple Silicon](https://arxiv.org/html/2601.19139v1),
[Cognex automated receiving](https://www.cognex.com/industries/logistics/inbound/automated-inbound-receiving),
[CSSI overhead scanners](https://cssi.com/2026/02/16/faster-shipping-operations-pack-benches-with-overhead-scanners/).
