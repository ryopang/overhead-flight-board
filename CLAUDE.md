# Overhead Flight Board: project instructions

You are building a local web app that displays nearby commercial flights as a
split-flap airport board, plus a live map of the same flights. The original
PRD is in ../flight-board-prd.md at the repo root (covers the split-flap
board's design tokens and phase-by-phase build plan); the project has since
grown beyond that PRD's original scope (user-set location, configurable
radius, map view, airline logos) via direct instruction — treat this file as
the current source of truth where it and the PRD disagree.

Hard rules:
- Plain HTML/CSS/JS, plus Leaflet (CDN) for the map. No framework, no build
  step, unless a later phase genuinely requires one — ask before adding one.
- Free, keyless APIs only, each proxied through api/*.js (and mirrored in
  dev-server.mjs for local dev): api.adsb.lol (position), api.adsbdb.com
  (route), zippopotam.us (ZIP geocoding), images.kiwi.com (airline logos, with
  server-side placeholder filtering). Never introduce a paid API or one
  requiring a key. If dev-server.mjs and api/*.js drift out of sync, the app
  breaks locally without erroring loudly — check both when adding a route.
- Follow the build phases in the PRD in order for the original board itself.
  Phase 0 (CORS check) gates everything else — do not assume direct browser
  fetch works without checking; this project's history includes at least one
  external host (images.kiwi.com) that could not be fetched directly from the
  browser in this environment and required a same-origin proxy instead.
- The split-flap animation must be true two-half mechanical flip physics
  (top half rotates down via transform: rotateX, revealing the bottom half
  underneath), never a crossfade or vertical slide. This happens inside
  individually bordered flap cells, one character per cell — not borderless
  flip text. This is the signature element of the whole project.
- Sound is synthesized via Web Audio API, never a licensed/sourced audio
  file.
- Only the flip animates. No other decorative motion, no hover states. The
  corner clock uses a separate 7-segment/LCD digit style, not the flap font.
- Cache adsbdb.com route lookups client-side per callsign (in-memory,
  ~15 min) to minimize calls to a community-run free API.
- Drop aircraft with no resolvable route (general aviation) rather than
  showing a blank row; backfill from the next-nearest candidate.
- Design tokens (color, type, layout) are locked in the PRD section 3. Don't
  deviate without flagging why.
- No account system, no database, no analytics, no ongoing cost of any kind.
- The board must always fill exactly one screen (`height: 100vh`), regardless
  of row count. The map is a deliberate second full-screen section reached by
  scrolling — never shrink the board to fit the map into one viewport.
- The map is the one intentional exception to "only the flip animates" — it's
  pannable/zoomable. Keep it collapsible via the MAP setting; don't let map
  state (loaded/hidden) block or slow down the board's own polling loop.
- Global names collide with browser built-ins more easily than you'd think —
  `location` is `window.location`; declaring `const location = ...` at top
  level silently kills the whole script with no console output in some
  environments. Watch for this class of bug with other globals too (`window`,
  `document`, `history`, `navigator`, `name`, `top`, `status`, `event`).
