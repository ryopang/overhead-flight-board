# Overhead

A split-flap airport departure board, running in a browser, showing the commercial flights currently overhead at a location you set by US ZIP code (defaults to Edgewater, NJ). Built to run full-screen on an old 10" iPad, permanently, for no ongoing cost.

![status](https://img.shields.io/badge/status-personal%20project-informational)


<img width="1175" height="1162" alt="Screenshot 2026-07-30 at 2 44 35 PM" src="https://github.com/user-attachments/assets/2f886bd3-a0ce-45dc-9ea4-ca2228424e52" />



## What this is

Enter any US ZIP code and it polls free public flight-tracking APIs, filters the aircraft nearby down to commercial airline traffic, and renders the nearest as split-flap board rows — flight number, airline (with logo), route, estimated arrival time. New flights flip in, old ones flip out, character by character, with a synthesized mechanical clack. Scroll down and a live map shows the same flights plotted over a wide area around your location.

It's designed to be mounted on a wall or shelf and forgotten about: no login, no database, no app to maintain, no bill that shows up later.

## Why

Living near Teterboro and EWR approach paths means there's almost always something interesting passing overhead. A departure board is a nicer way to notice that than checking a flight tracker app — ambient, glanceable, physical-feeling, always on.

## Features

- **Live position + route data**, polled from free, keyless APIs:
  - [adsb.lol](https://adsb.lol) for aircraft currently in range (position, altitude, speed, distance, heading)
  - [adsbdb.com](https://www.adsbdb.com) for resolving a callsign to airline / origin / destination
  - [zippopotam.us](https://zippopotam.us) for resolving a US ZIP code to a lat/lon
- **User-configurable tracking location** — enter any 5-digit US ZIP in the settings panel; the board and map both recenter on it. Defaults to 07020 (Edgewater, NJ).
- **Configurable search radius** — how far out "overhead" reaches, 1–50 miles (default 25), adjustable in settings. Never polls adsb.lol faster than its 15-second courtesy floor, regardless of other settings.
- **Estimated arrival time (EST/EDT)** — neither flight API provides a scheduled ETA, so it's computed client-side: great-circle distance from the aircraft's current position to its destination airport (a small bundled, static IATA → lat/lon table, sourced from public-domain airport data), divided by current ground speed. Shown as a rough estimate — it's most accurate mid-flight and least accurate right after takeoff, while the aircraft is still climbing well below cruise speed.
- **Airline logos** — fetched at runtime by IATA code from a free public logo CDN, proxied server-side (`/api/logo`) both to keep every external call routed through one consistent path and to filter out the CDN's "unknown airline" placeholder image. Left blank when no logo is found (e.g. cargo carriers).
- **Commercial-only filtering** — aircraft on the ground, blank callsigns, and anything that doesn't resolve to a real airline route (general aviation, private jets) are dropped automatically, with backfill from the next-nearest candidate.
- **True split-flap animation** — each character cell is a real two-half mechanical flip (`rotateX` on top and bottom leaves around a shared fold line, staggered left-to-right across a row), not a crossfade or slide.
- **Mechanical clack per flip** — plays a short (110ms) sample (`clack.wav`, provided directly by the project owner and confirmed clear of copyright concerns) through Web Audio API, so overlapping staggered hits across a row layer correctly, with small per-hit pitch/gain jitter so a cascade doesn't sound like the same sample looped identically. Falls back to an in-browser synthesized knock (Karplus-Strong physical modeling) if the sample fails to load. Mutable in settings.
- **7-segment clock** in the corner, CSS-drawn (ghost segments visible when off, like a real LCD), deliberately styled differently from the flap-cell font so it doesn't read as part of the animated board.
- **US-carrier accent tag** — a small green mark next to US airline flights, not a background wash.
- **Live map view** — a second full-screen section below the board (reached by scrolling down, never squeezed into the same screen), showing the same flights on a dark map centered on your tracked location with a 100-mile-radius reference circle, pan/zoom enabled. Collapsible via a MAP on/off toggle in settings, with its own on/off default per view mode (see below).
- **Two view modes, switchable in settings (VIEW: BOARD / SINGLE)** — the choice persists locally:
  - **BOARD** — the original multi-row split-flap list described above.
  - **SINGLE** — a large single-flight departure-sign display, styled after a physical LED dot-matrix sign: the nearest overhead flight's number, route, aircraft type, live altitude/ground speed (e.g. `FL350 · 462 KTS`, from the same position data already being polled), and a big "Departing to &lt;destination&gt;" line, all rendered in a true round-dot variable font (Doto) over a faint LED-panel dot-grid backdrop. The airline logo is rendered the same way — sampled onto a dot grid rather than shown as a plain bitmap — with a dot-matrix plane glyph as the fallback when no logo resolves. Fills the screen edge-to-edge, kiosk-style. The map defaults **off** in this view (vs. on for BOARD) since the sign is meant to stand alone, but each view remembers its own on/off choice independently once you touch the toggle.
- **Configurable flip interval** — 15s / 30s / 1m (default) / 2m / 5m, in settings.
- **Configurable row count** — 1 to 10 rows (default 5). All 10 row slots are pre-built and shown/hidden rather than recreated, so changing the count is instant.
- **Resilient to network drops** — if a poll fails, the board keeps showing the last known state and retries with exponential backoff, surfacing only a small "RECONNECTING…" badge rather than blanking out.
- **In-memory route caching** — each callsign's resolved route is cached client-side for 15 minutes, so a flight seen repeatedly doesn't re-hit the route API.
- **Kiosk-friendly** — add-to-Home-Screen manifest, full-screen display mode, a one-time "tap to start" splash that unlocks audio (required by Safari's autoplay policy) and never appears again for that session. The board itself always fills exactly one screen regardless of row count; the map is a deliberate second screen, not a squeeze-everything-in compromise.

All settings (view mode, location, radius, flip interval, sound, row count, map on/off) persist locally and apply immediately without a page reload.

## Design intent

Built to match a specific reference photo, not a generic idea of "split-flap board": black chassis, individually bordered amber character cells, bold white uppercase headers, a visually distinct 7-segment clock. IBM Plex Mono for the flap characters, Archivo for headers. The flip is the signature element — everything else on the board is intentionally static. No hover states, no decorative motion, no page-load flourish beyond the same flip mechanic the board uses forever after. The map is the one deliberate exception to "nothing else moves" — it's a live, pannable/zoomable geographic view, kept on its own screen precisely so it doesn't compete with the board's stillness.

The SINGLE view is matched to a second, different reference photo — a physical LED dot-matrix departure sign — and deliberately doesn't reuse the board's amber flap-cell look: white text, Doto (a round-dot variable font) instead of IBM Plex Mono, and a sampled dot-matrix rendering of the airline logo instead of a plain image, so the whole sign reads as one consistent dot-matrix material rather than sharp UI elements dropped onto a pixelated background.

## Considerations / constraints

- **Zero ongoing cost by design.** All data APIs are free and keyless. Hosting is a static site plus four small serverless functions, well within any free hosting tier at this traffic volume (one device, one request roughly once a minute).
- **adsb.lol blocks direct browser requests** (no CORS header), so position lookups are routed through a tiny serverless proxy (`/api/adsb`). adsbdb.com and zippopotam.us allow direct browser calls but are proxied too (`/api/route`, `/api/geocode`) for one consistent client-side fetch path. The airline logo CDN is proxied (`/api/logo`) for the same reason, plus server-side placeholder filtering.
- **Be a good API citizen.** adsb.lol is a community-run, free-goodwill service — the board never polls faster than the 15-second floor built into the settings, regardless of which interval or radius is selected.
- **No accounts, no database, no analytics, no tracking of any kind.**
- **Not a general-purpose flight tracker.** No historical data, no notifications, no native app. It shows what's overhead right now, at one location you choose, and nothing else.
- **Arrival times are estimates, not schedule data.** A real ETA would require a paid flight-schedule API. `airports.json` (bundled, ~280KB) only supplies destination coordinates for the great-circle/current-speed calculation described above.
- **Data is only as good as ADS-B coverage.** Aircraft without a transponder broadcasting a resolvable commercial callsign won't appear — this is treated as a feature (it's also the commercial-airline filter) rather than a gap to fix.
- **US ZIP codes only.** International locations are out of scope by design.

## Stack

Plain HTML / CSS / JavaScript, plus [Leaflet](https://leafletjs.com) (loaded via CDN) for the map. Fonts are loaded from Google Fonts: IBM Plex Mono and Archivo for the board, [Doto](https://fonts.google.com/specimen/Doto) (a round-dot variable font) for the SINGLE view. No framework, no build step, no bundler — deployable as static files with four serverless functions in `api/` for CORS proxying. Runs locally via a dependency-free Node dev server (`dev-server.mjs`) that mirrors the same routes.

## Running locally

```bash
node dev-server.mjs
```

Then open `http://localhost:8934`.

## Deploying

Zero-config on [Vercel](https://vercel.com): static files are served as-is, and the files in `api/` are picked up automatically as serverless functions. No environment variables, no secrets, no build command.

---

Personal project — built for one address, one iPad, one person's curiosity about what's flying overhead.
