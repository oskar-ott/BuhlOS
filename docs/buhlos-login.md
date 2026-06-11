# BuhlOS login — desktop sign-in

Implements the Claude Design handoff `BuhlOS Login.html` as the real `/v2/login`
surface. The prototype is a desktop **split layout**: a navy brand panel (left)
and a sign-in card (right).

## Before

`/v2/login` was a single centred card — `BuhlOS · v2` eyebrow, "Sign in"
heading, `Email or username` / `Password or PIN` fields, a generic primary
button and a "use the legacy /login" link. Functional, but visually a
placeholder.

## What shipped

The split layout, recreated to the design's own token system (so the colours
are exact, not approximated from the global Tailwind tokens which differ
slightly):

- **Brand panel** (`<aside>`, navy `#0d1b34`, 46% / max 660px): white bühl
  wordmark + `BuhlOS · Operations`, the headline **"Everything bühl _runs on._"**
  (accent in bühl yellow `#f5d020`), the value-prop sub-line, three yellow-dot
  bullets, and a `bühl electrical · Sydney / v1.0` footer. Radial-glow + dot-grid
  texture as in the design.
- **Sign-in card** (max 384px): `Sign in` eyebrow → **Welcome back.** → sub-line,
  `Work email` + `Password` fields (JetBrains Mono labels), show/hide toggle,
  inline empty-field validation, the yellow **`Sign in →`** button with a busy
  spinner, an error banner, and the design's footer copy (`Field crew? You use
  Phil…` / office phone).
- **Responsive**: ≤900px the brand panel drops away and the card centres with the
  ink bühl wordmark as a topmark (the design's narrow treatment).
- **Fonts**: headings Inter Tight, body Inter (both already global), labels
  JetBrains Mono (added route-scoped via `next/font/google`).

### Wiring is real (not prototype)

The card POSTs `{ username, secret }` to the existing `/api/auth?action=login`,
which sets the `buhl_session` cookie. On success we **hard-navigate** to
`next` (if a safe same-origin path) or `landingFor(role)` — the same source of
truth `src/middleware.ts` uses — so middleware sees the new cookie. On failure
we stay on `/v2/login` and the banner maps the server error: 401
`invalid credentials` → "Email or password incorrect"; 403 → "Account disabled".

## Intentional deviations from the prototype (agreed with the user)

The prototype is a design-review artifact with mock-only affordances. Per the
"never ship half-broken UI" rule, the parts with no backend were not shipped as
working controls:

- **Forgot password — dropped.** The mock promised a self-service "email reset
  link, expires in 60 min". There is no such backend. (`/api/password-resets`
  exists, but it's a *request-and-triage* flow — name + contact, office resets
  it manually — not a self-service link, so the mock's copy would have been a
  lie.) The "Trouble signing in? Call the office" footer covers recovery for now.
- **SSO — shown disabled / "coming soon".** No SSO/SAML/OAuth backend exists;
  the prototype's button just faked a login. Kept in the layout, disabled, with
  a "SSO coming soon" note, so the design reads as intended without a dead
  control.
- **Dark / HC themes, centered-layout toggle, the Tweaks panel, and the
  success / locked preview states** were the prototype's review controls, not
  shipped surfaces. Light theme, split layout only.

## Test contract (load-bearing)

The field-readiness smoke + auth-routing specs drive login through stable hooks
that this re-skin preserves:

- `data-testid="login-username" | "login-password" | "login-submit"`
  (`tests/playwright/helpers/auth.ts`).
- A button whose accessible name contains **"Sign in"** (the submit is
  `Sign in →`; the disabled SSO button is _not_ matched).

`tests/phase-a.spec.ts` was updated to the new copy: heading **"Welcome back."**,
labels **"Work email"** / **"Password"** (`{ exact: true }` so the show/hide
button's `Show password` aria-label isn't a false match).

## Files

- `src/app/v2/login/page.tsx` — server component: auth redirect + `next`,
  route-scoped JetBrains Mono, static brand panel.
- `src/app/v2/login/login-form.tsx` — client card (form, show/hide, validation,
  banner, disabled SSO).
- `src/app/v2/login/login.module.css` — scoped styles; design tokens declared on
  `.login` (light only), ported from the handoff's `ops-base.css` + `login.css`.
- `public/brand/buhl-logo-white.png`, `public/brand/buhl-logo-ink.png` — brand
  marks copied from the handoff bundle.

Source: `buhlos-phil/project/BuhlOS Login.html` (+ `login/login.css`,
`login/login.jsx`) from the Claude Design handoff.
