# Overhead

A split-flap airport departure board, running in a browser, showing the 5 commercial flights currently overhead at a fixed address in Edgewater, NJ. Built to run full-screen on an old 10" iPad, permanently, for no ongoing cost.

![status](https://img.shields.io/badge/status-personal%20project-informational)

## What this is

Point it at any lat/lon and it polls two free public flight-tracking APIs, filters the aircraft nearby down to commercial airline traffic, and renders the 5 nearest as split-flap board rows — flight number, airline, route, distance. New flights flip in, old ones flip out, character by character, with a synthesized mechanical clack.

It's designed to be mounted on a wall or shelf and forgotten about: no login, no database, no app to maintain, no bill that shows up later.

## Why

Living near Teterboro and EWR approach paths means there's almost always something interesting passing overhead. A departure board is a nicer way to notice that than checking a flight tracker app — ambient, glanceable, physical-feeling, always on.

## Features

- **Live position + route data**, polled from two free, keyless APIs:
  - [adsb.lol](https://adsb.lol) for aircraft currently in range (position, altitude, speed, distance)
  - [adsbdb.com](https://www.adsbdb.com) for resolving a callsign to airline / origin / destination
- **Commercial-only filtering** — aircraft on the ground, blank callsigns, and anything that doesn't resolve to a real airline route (general aviation, private jets) are dropped automatically, with backfill from the next-nearest candidate so the board still shows 5 when possible.
- **True split-flap animation** — each character cell is a real two-half mechanical flip (`rotateX` on top and bottom leaves around a shared fold line, staggered left-to-right across a row), not a crossfade or slide.
- **Synthesized mechanical sound** — no audio files. Each flip's clack is built at runtime from a layered Web Audio graph: a noise transient, a metallic tick (bank of inharmonic square oscillators, the same technique used for drum-machine hi-hats), a low thump, and a quiet secondary "settle" click.
- **7-segment clock** in the corner, CSS-drawn (ghost segments visible when off, like a real LCD), deliberately styled differently from the flap-cell font so it doesn't read as part of the animated board.
- **US-carrier accent tag** — a small green mark next to US airline flights, not a background wash.
- **Configurable flip interval** — a settings panel (gear icon) lets you choose how often the board refreshes: 15s / 30s / 1m (default) / 2m / 5m. Persisted locally.
- **Mute toggle** — same settings panel.
- **Resilient to network drops** — if a poll fails, the board keeps showing the last known state and retries with exponential backoff, surfacing only a small "RECONNECTING…" badge rather than blanking out.
- **In-memory route caching** — each callsign's resolved route is cached client-side for 15 minutes, so a flight seen repeatedly doesn't re-hit the route API.
- **Kiosk-friendly** — add-to-Home-Screen manifest, full-screen display mode, a one-time "tap to start" splash that unlocks audio (required by Safari's autoplay policy) and never appears again for that session.

## Design intent

Built to match a specific reference photo, not a generic idea of "split-flap board": black chassis, individually bordered amber character cells, bold white uppercase headers, a visually distinct 7-segment clock. IBM Plex Mono for the flap characters, Archivo for headers. The flip is the signature element — everything else on the board is intentionally static. No hover states, no decorative motion, no page-load flourish beyond the same flip mechanic the board uses forever after.

## Considerations / constraints

- **Zero ongoing cost by design.** Both data APIs are free and keyless. Hosting is a static site plus two small serverless functions, well within any free hosting tier at this traffic volume (one device, one request roughly once a minute).
- **adsb.lol blocks direct browser requests** (no CORS header), so position lookups are routed through a tiny serverless proxy (`/api/adsb`). adsbdb.com allows direct browser calls but is proxied too (`/api/route`) for a consistent client-side fetch path.
- **Be a good API citizen.** adsb.lol is a community-run, free-goodwill service — the board never polls faster than the 15-second floor built into the settings, regardless of which interval is selected.
- **No accounts, no database, no analytics, no tracking of any kind.**
- **Not a general-purpose flight tracker.** No historical data, no notifications, no multi-location support, no native app. It shows what's overhead right now, at one fixed address, and nothing else.
- **Data is only as good as ADS-B coverage.** Aircraft without a transponder broadcasting a resolvable commercial callsign won't appear — this is treated as a feature (it's also the commercial-airline filter) rather than a gap to fix.

## Stack

Plain HTML / CSS / JavaScript. No framework, no build step, no bundler — deployable as static files with two serverless functions (`api/adsb.js`, `api/route.js`) for the CORS proxy. Runs locally via a dependency-free Node dev server (`dev-server.mjs`) that mirrors the same two routes.

## Running locally

```bash
node dev-server.mjs
```

Then open `http://localhost:8934`.

## Deploying

Zero-config on [Vercel](https://vercel.com): static files are served as-is, and the two files in `api/` are picked up automatically as serverless functions. No environment variables, no secrets, no build command.

---

Personal project — built for one address, one iPad, one person's curiosity about what's flying overhead.
