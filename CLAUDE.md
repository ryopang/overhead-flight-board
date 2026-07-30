# Overhead Flight Board: project instructions

You are building a local web app that displays up to 5 nearby commercial
flights as a split-flap airport board. Full PRD is in ../flight-board-prd.md
at the repo root. Read it before writing any code.

Hard rules:
- Plain HTML/CSS/JS. No framework, no build step, unless a later phase
  genuinely requires one — ask before adding one.
- Two free, keyless APIs only: api.adsb.lol (position) and api.adsbdb.com
  (route). Never introduce a paid API or one requiring a key.
- Follow the build phases in the PRD in order. Complete a phase's acceptance
  criteria before starting the next. Phase 0 (CORS check) gates everything
  else — do not assume direct browser fetch works without checking.
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
