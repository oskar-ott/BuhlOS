# The Phil Constitution

**Package (in authority order):** **Constitution** → [Governance](phil-governance.md) → [Architecture](phil-architecture.md) → [Field Validation](phil-field-validation.md) → [Roadmap](phil-implementation-roadmap.md).

**The supreme design document for Phil, the field interface.** Every future issue, PR, and design must align with these fifteen principles. Amendments require the process in P15. *(Proposed 2026-06-12; ratification analysis: `docs/phil-constitution-ratification.md`; board-amended same day after hostile review.)*

**Commencement:** P1–P3 and P5–P12 take force on ratification — they govern the artefact and the process, and their evidence is measured. The behavioural claims inside P4, P13, P14 and the stable-concepts list hold **provisional** status until the first field validation session ([#132](https://github.com/oskar-ott/BuhlOS/issues/132)) has had the chance to disprove them, per P15.

Phil is a tool that makes working on site faster, easier and more organised. It is not project management software, not ERP, not office software. It should feel like a really well organised site folder combined with an experienced leading hand: it tells the worker what matters now, remembers what they forget, prevents mistakes, and gets out of the way.

---

### P1 · Phil reflects site reality, not office structure
The shape of the app follows how work is *done* — by place, phase, instruction and moment — never how the software, the backlog, or the office is organised. When site reality and software convenience conflict, reality wins.

### P2 · Work lives somewhere
Every piece of work and every record carries its place and context — job, and where known: area, phase, task. Views may slice the data any way that helps (by room, by run, by defect, by drawing, by day); storage never loses where a thing belongs.

### P3 · The worker's instruction outranks the app
The foreman's word is authoritative. Phil carries and remembers human instructions; it may suggest and rank, but it never asserts a computed plan over what a human on site said. Assist, never assert.

### P4 · Phil answers "what now?" in three seconds
Every surface, opened cold by a tired worker, must state where they are, what this is, and the most useful next thing *it knows* — within three seconds, without reading a paragraph. The answer is offered as memory, never as command: where a human instruction is known, the instruction **is** the answer (P3); where none is known, Phil suggests and says so.

### P5 · Structure is optional; capture is not
A job with no areas, no tasks and no drawings is a first-class job: photos, hours, issues and notes always work. Phil scales from a pub rewire to a hospital tower by adapting to whatever structure exists — it never demands structure before allowing work.

### P6 · Every tap must pay for itself
Taps, typing, choices and waiting are costs the worker pays. Defaults come from context (place, time, history, role); the common case is one tap; typing is last resort. A feature that adds steps to the common path is wrong no matter how powerful. **One boundary:** compliance, safety and quality steps — witness sign-offs, hold points, required evidence — are never "friction" to be optimised away. They are the work.

### P7 · Truth over theatre
Real records or named absence — never invented numbers, fake progress, fake presence, or silent failure. If Phil doesn't know, it says so. If something didn't save, the worker knows immediately and loses nothing.

### P8 · The app survives the site
Gloves (targets a gloved thumb cannot miss), sunlight (legible at arm's length), one thumb (actions reachable), interruptions every few minutes (resume by place and next action, at most one gesture), and dead signal (degraded honestly from cache, never a blank screen). These are environmental constants, not edge cases. Specific minimums (target sizes, type floors) live in the field standards and may tighten over time — never loosen.

### P9 · Critical state is never hidden behind navigation
Whatever the navigation mechanism, anything the worker must not miss — blockers, rejections, safety holds, unsaved work — is visible on the surface they are on, not behind a tab, menu, gesture or scroll they might not perform.

### P10 · Screens have a fixed cognitive budget
Level one of any surface carries at most one decision. New capabilities enter through existing slots — the ranked next action, context on a record, or the single reference group — never as new top-level navigation or a new section. Adding requires removing. The budget is enforced by tests.

### P11 · Phil speaks site, in the voice of a good leading hand
Words a first-year apprentice uses on the tools — issues, checks, rough-in, fit-off, gear — in short, direct, calm sentences. Never bureaucratic, never judgmental, never enterprise. Explanatory prose appears only where there is nothing else to show.

### P12 · No hidden-only actions; no dangerous neighbours
Every action is discoverable by sight. Gestures may shortcut, never gate-keep. Destructive or identity-changing actions never sit beside routine ones, and state their consequence before acting.

### P13 · Records are made at the moment of work
Photos, issues, checks, notes and hours are captured where and when the work happens, inheriting context automatically — many doors into the same record, one record. Paperwork deferred is paperwork lost.

### P14 · Phil remembers so the worker doesn't
Where I was, what's left, what's blocked and why, what the foreman said, what I hold, what's due — memory load moves from the worker's head to the app. Memory works the way site memory works: completion plus exceptions.

### P15 · Philosophy is ratified in the field, not in the office
Facts about the artefact (sizes, counts, failures) may be acted on immediately. Anything claiming how workers think or work becomes permanent only after a real worker on a real site has had the chance to disprove it. Constitutional amendments require the same: evidence from the field, written rationale, and explicit ratification.

---

*Stable concepts the model is built on: Job · Worker · **Crew** · Area · Task · Phase · Drawing+Revision · Photo/Evidence · Defect · Check · Hours record · Material · **Blocker (what's stuck, and why)** · Instruction. (Circuit and Device are future-foundational, arriving with the drawings ladder.) Everything else — runs, day plans, rankings, feeds, grids — is a view, and views stay views.*
