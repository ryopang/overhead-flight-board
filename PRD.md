# Overhead Flight Board — PRD & Build Plan

Personal project. A local web app that shows up to 5 flights currently overhead
at 706 Hudson Park, Edgewater, NJ 07020, displayed split-flap airport-board
style on an old 10" iPad running full-screen Safari. No App Store, no backend
database, no paid APIs, no ongoing cost.

Both data APIs this design depends on were tested live against these exact
coordinates before writing this plan. Confirmed working, no key required.

---

## 1. What this is

A single-page web app. It polls two free public APIs, filters to commercial
airline traffic within a radius of the address, and renders the 5 nearest as
split-flap board rows: flight number, airline, origin, destination. New
flights flip in, old ones flip out. Each flip has a mechanical clack sound.

Not in scope: historical data, notifications, multi-location support, any
account or login, any native iOS app.

---

## 2. Data sources (both verified live on 2026-07-29)

### 2.1 Position feed — adsb.lol

```
GET https://api.adsb.lol/v2/point/{lat}/{lon}/{radius_nm}
```

For this project: `lat=40.8256`, `lon=-73.9765` (Edgewater, NJ). Radius
recommendation: start at `10` (nm), tune once running — near EWR and
Teterboro this will not be sparse.

No API key, no auth header, no signup. Returns:

```json
{
  "ac": [
    {
      "hex": "a7598c",
      "flight": "UAL3933 ",
      "r": "N57299",
      "t": "B38M",
      "alt_baro": 875,
      "gs": 142.3,
      "lat": 40.653854,
      "lon": -74.189270,
      "dst": 14.136,
      "dir": 223.3
    }
  ]
}
```

Fields this app uses: `flight` (callsign, space-padded — trim it), `alt_baro`
(number, or the string `"ground"` for aircraft not airborne), `dst` (distance
from query point in nm — already computed, no need to do your own haversine),
`gs` (ground speed, optional display).

Community-run, free-goodwill API. Poll every 15–20 seconds. Do not poll
faster than that.

### 2.2 Route lookup — adsbdb.com

```
GET https://api.adsbdb.com/v0/callsign/{CALLSIGN}
```

Example (verified live): `UAL3933` returns:

```json
{
  "response": {
    "flightroute": {
      "callsign_iata": "UA3933",
      "airline": { "name": "United Airlines", "icao": "UAL", "iata": "UA", "country_iso": "US" },
      "origin": { "iata_code": "PWM", "municipality": "Portland", "name": "Portland International Jetport" },
      "destination": { "iata_code": "MCO", "municipality": "Orlando", "name": "Orlando International Airport" }
    }
  }
}
```

Also free, no key. Only call this for callsigns you haven't resolved recently
— cache the result client-side in memory (a `Map<callsign, route>`), since a
flight's route doesn't change mid-flight. A 15-minute in-memory cache per
callsign is plenty and cuts calls to near-zero on repeat sightings.

If a callsign returns no `flightroute` (private/GA aircraft, or an
unrecognized pattern), drop that aircraft from the board rather than showing
a blank row. This also functions as your "commercial airline only" filter —
general aviation tail numbers won't resolve to a route and get excluded
naturally.

### 2.3 Filtering logic, in order

1. Pull all aircraft in the radius from adsb.lol.
2. Drop anything where `alt_baro === "ground"` (taxiing aircraft aren't
   "flying above" the address).
3. Drop anything whose `flight` field is blank or doesn't look like an
   airline callsign (trim whitespace; require letters + digits).
4. Sort remaining by `dst` ascending.
5. Take the top 5.
6. For each, resolve route via adsbdb.com (cache-first).
7. Drop any that fail to resolve a route (GA leakage caught late), backfill
   from the next-nearest candidate so you still show 5 when possible.
8. Flag `airline.country_iso === "US"` for the highlight treatment.

### 2.4 CORS — verify before building the UI

Both APIs are commonly used in browser-based dashboards, so direct
`fetch()` from Safari is likely fine, but confirm this first (Phase 0 below)
rather than assuming. If either blocks direct browser calls, the fallback is
a single tiny Vercel serverless function that proxies both, still free at
this traffic volume (one device, one request per ~15s).

---

## 3. Design direction

Locked to a specific reference: a black-background departure board with
individually bordered character cells in amber, bold white column headers,
and a distinct 7-segment-style digital clock in the corner. Landscape.
Confirmed by Ryo. Build to this reference, not a generic interpretation of
"split-flap board."

**Palette**

| Token | Hex | Use |
|---|---|---|
| `--board-chassis` | `#0A0A0A` | Outer background, full bleed |
| `--cell-bg` | `#1A1A1A` | Individual flap-cell background |
| `--cell-border` | `#2E2E2E` | Hairline border around each flap cell |
| `--char-amber` | `#F7B500` | Flap-cell characters (flight #, airline, cities, distance) |
| `--header-white` | `#F5F5F0` | Column headers, eyebrow title — bold, letter-spaced |
| `--us-flag-accent` | `#3CB878` | US-carrier indicator, a small tag or left-edge mark, never a wash |
| `--status-alert` | `#E14B3E` | Reserved only for the "reconnecting" indicator, never decorative |

**Type**

- Flap-cell characters: **IBM Plex Mono**, bold. Clean geometric monospace,
  reads correctly inside individual bordered cells rather than fighting a
  novelty font. One character per cell, cells grouped into fields (flight
  number is one group of cells, airline another, etc.), matching the
  reference photo's grid exactly.
- Column headers and eyebrow title ("OVERHEAD · EDGEWATER, NJ"): a bold
  grotesk sans with wide letter-spacing and uppercase, e.g. **Archivo** at
  a heavy weight — matches the reference's "DEPARTURES" treatment.
- Clock (top-right corner, current time): styled distinctly from both of
  the above, 7-segment/LCD-style digits in amber (a face like **DSEG7** or
  a CSS-drawn seven-segment display), separate visual register from the
  flap-cell font, exactly as in the reference photo.

**Layout** (landscape, full-bleed black, column grid matching the reference)

```
┌──────────────────────────────────────────────────────────┐
│ ✈ OVERHEAD              EDGEWATER, NJ         18:03 [clock face] │
├──────────────────────────────────────────────────────────┤
│ FLIGHT      AIRLINE            ROUTE           DIST       │  <- bold white header row
├──────────────────────────────────────────────────────────┤
│ [U]A 3933   UNITED AIRLINES    PWM → MCO       14nm       │  <- each char in its own bordered cell
├──────────────────────────────────────────────────────────┤
│    L 2866   DELTA              ...   ...       ...        │
├──────────────────────────────────────────────────────────┤
│    ...five rows total, hairline divider between each...   │
└──────────────────────────────────────────────────────────┘
```

Every character of flight number, airline name, and route sits in its own
small bordered cell (visible grid, per the reference), not a borderless
run of flip text. The `[U]` mark is the US-carrier accent: a small green
tag before the flight number, not a background wash across the row.

**Signature element — the flip itself**

This is the one thing to get right, because it's the entire premise. Real
split-flap mechanics: each cell's character is split horizontally at its
vertical center. The top half rotates down (like a page turning on a
horizontal spine) revealing the new character's bottom half sitting
underneath, which is itself covered by a new top half that then also
flips down. Do not implement this as a crossfade or a vertical slide — that
reads as a generic "counter" animation, not a split-flap board. Two
half-height `div`s per cell, `transform: rotateX()` on the top half with a
`perspective` on the parent, a subtle gradient on the fold edge to fake the
crease shadow, all inside the bordered cell from the reference.

Stagger the flip across cells left to right (60–90ms offset per character)
so a row change reads as a mechanical cascade, not everything flipping at
once.

**Sound**

Synthesized per-flip, no audio file: a short filtered noise burst
(~15–25ms) plus a low-frequency tick, via the Web Audio API
(`AudioContext`, `BufferSource` + `BiquadFilter`). One flip = one clack,
staggered with the visual cascade above. No licensing question, no asset
to source or manage.

**Motion discipline**

Only the flip animates. No other decorative motion, no hover states (this
is a kiosk display, nobody's touching it after launch), no page-load
flourish beyond the first board population using the same flip mechanic
it'll use forever after. The clock digits update via their own 7-segment
face, no flip needed there — that distinction is part of what makes the
reference read as a real board rather than a uniform animated widget.

---

## 4. Non-functional requirements

- **Zero ongoing cost.** Both APIs are free with no key. Hosting is either
  Vercel's free tier (static + optional one serverless function) or a local
  static server on your Mac. No database, no paid dependency.
- **Resilient to network drops.** If a poll fails, keep showing the last
  known board rather than blanking it, and retry with backoff. Show a small
  "reconnecting" indicator in the eyebrow row only, never replace the board.
- **No interaction required after launch**, except the one unavoidable
  first tap — Safari's autoplay policy blocks audio until a user gesture,
  on every iOS version, kiosk or not. Design a single "Tap to start board"
  splash that unlocks audio and then never appears again for that session.
- **Kiosk-friendly.** Add to Home Screen (via a `manifest.json` / Apple
  touch icon meta tags) so it launches without Safari's URL bar. Disabling
  the iPad's auto-lock is a Settings-level change you make on the device,
  not something the app controls.
- **No build step, if avoidable.** Plain HTML/CSS/JS. Keeps it deployable
  as static files with no compile pipeline to maintain later.

---

## 5. Tech stack & file structure

Vanilla HTML/CSS/JS. No framework needed for this scope.

```
flight-board/
  index.html
  style.css
  app.js          # polling loop, filtering, caching, state
  flap.js         # split-flap character component + stagger logic
  audio.js         # Web Audio synthesis for the clack
  manifest.json    # add-to-home-screen metadata
  api/
    proxy.js       # ONLY if Phase 0 finds a CORS blocker
  vercel.json      # only needed if api/proxy.js exists
  PRD.md           # this document
  CLAUDE.md        # instructions block, section 7 below
```

---

## 6. Build phases

Complete each phase's acceptance criteria before starting the next.

**Phase 0 — Verify the APIs from a real browser**
- Spike a bare HTML page that calls both `api.adsb.lol` and `api.adsbdb.com`
  via `fetch()` from Safari/Chrome directly (not curl).
- Acceptance: confirm whether CORS blocks either call. If blocked, stub the
  serverless proxy now, before building UI on top of an assumption.

**Phase 1 — Static board shell, mock data**
- Build the layout, palette, type, and the flip mechanic against
  hard-coded sample rows (no live data yet).
- Acceptance: the flip looks and sounds like a real split-flap board, not a
  crossfade. This is the phase to get pixel-right before wiring data in.

**Phase 2 — Live position data**
- Wire up the adsb.lol polling loop, the ground/blank/pattern filtering,
  sort-by-distance, top-5 selection.
- Acceptance: real aircraft over Edgewater populate the board, correctly
  filtered and sorted, no route info yet (blank or "—" for airline/route).

**Phase 3 — Route enrichment**
- Wire adsbdb.com lookups with the in-memory cache, US-carrier flagging,
  and the drop-and-backfill behavior for unresolved callsigns.
- Acceptance: airline name, origin, destination populate correctly; US
  carriers show the accent bar; a GA aircraft entering the radius does not
  produce a blank or broken row.

**Phase 4 — Sound**
- Implement the Web Audio synthesis, hook to each character's flip event,
  stagger matching the visual cascade.
- Acceptance: a row change sounds like a mechanical cascade, not a single
  blip or an obviously synthetic beep.

**Phase 5 — Resilience & kiosk polish**
- Reconnect/backoff handling, the tap-to-start audio unlock splash,
  manifest.json for add-to-home-screen, error states.
- Acceptance: pull your Mac's/router's network for 30 seconds mid-session —
  board holds last state, recovers cleanly when connectivity returns.

**Phase 6 — Deploy & on-device test**
- Deploy to Vercel (or local server, per your choice — default recommendation
  is Vercel so it works independent of your Mac being on).
- Acceptance: running full-screen in Safari on the actual iPad, added to
  Home Screen, sitting for at least an hour without manual intervention.

---

## 7. Instructions block for Claude Code (paste as CLAUDE.md in the project root)

```markdown
# Overhead Flight Board: project instructions

You are building a local web app that displays up to 5 nearby commercial
flights as a split-flap airport board. Full PRD is in PRD.md at the repo
root. Read it before writing any code.

Hard rules:
- Plain HTML/CSS/JS. No framework, no build step, unless a later phase
  genuinely requires one — ask before adding one.
- Two free, keyless APIs only: api.adsb.lol (position) and api.adsbdb.com
  (route). Never introduce a paid API or one requiring a key.
- Follow the build phases in PRD.md in order. Complete a phase's acceptance
  criteria before starting the next. Phase 0 (CORS check) gates everything
  else — do not assume direct browser fetch works without checking.
- The split-flap animation must be true two-half mechanical flip physics
  (top half rotates down via transform: rotateX, revealing the bottom half
  underneath), never a crossfade or vertical slide. This happens inside
  individually bordered flap cells, one character per cell, per the
  reference photo in PRD.md — not borderless flip text. This is the
  signature element of the whole project.
- Sound is synthesized via Web Audio API, never a licensed/sourced audio
  file.
- Only the flip animates. No other decorative motion, no hover states. The
  corner clock uses a separate 7-segment/LCD digit style, not the flap font.
- Cache adsbdb.com route lookups client-side per callsign (in-memory,
  ~15 min) to minimize calls to a community-run free API.
- Drop aircraft with no resolvable route (general aviation) rather than
  showing a blank row; backfill from the next-nearest candidate.
- Design tokens (color, type, layout) are locked in PRD.md section 3. Don't
  deviate without flagging why.
- No account system, no database, no analytics, no ongoing cost of any kind.
```

---

## 8. Out of scope (v1)

Multiple locations, historical flight logs, push notifications, altitude/
speed trend graphs, aircraft photos, native iOS wrapper, App Store
distribution. Any of these could be a v2 if the v1 board earns its keep.
