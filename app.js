// app.js — polling loop, filtering/sorting, route enrichment + caching, rendering, resilience.

const CONFIG = {
  LAT: 40.8256,
  LON: -73.9765,
  RADIUS_NM: 10,
  DEFAULT_FLIP_INTERVAL_MS: 60000, // how often the board refreshes/flips; user-configurable
  MIN_FLIP_INTERVAL_MS: 15000, // adsb.lol courtesy floor — never poll faster than this
  ROUTE_CACHE_TTL_MS: 15 * 60 * 1000,
  MAX_ROWS: 5,
  BACKOFF_START_MS: 5000,
  BACKOFF_MAX_MS: 60000,
};

const STORAGE_KEYS = {
  flipInterval: 'overhead:flipIntervalMs',
  muted: 'overhead:muted',
};

function loadFlipInterval() {
  const stored = Number(localStorage.getItem(STORAGE_KEYS.flipInterval));
  return stored >= CONFIG.MIN_FLIP_INTERVAL_MS ? stored : CONFIG.DEFAULT_FLIP_INTERVAL_MS;
}

function loadMuted() {
  return localStorage.getItem(STORAGE_KEYS.muted) === 'true';
}

const FIELD_WIDTHS = { flight: 7, airline: 18, route: 7, eta: 5 };

// ---------------- Airport coordinates (for arrival-time estimate) ----------------
//
// Neither adsb.lol nor adsbdb.com provides a scheduled/estimated arrival time —
// that data lives behind paid flight-schedule APIs, which are out of scope here.
// Instead: bundle a static, free (public-domain-sourced) IATA -> lat/lon table,
// and estimate ETA as great-circle distance from the aircraft's *current* position
// to its destination airport, divided by its *current* ground speed. This is a
// rough estimate (a climbing or holding aircraft won't be flying a great-circle
// path yet), shown as such — not a real scheduled arrival time.

let airportCoords = null; // IATA -> {lat, lon}, loaded once

async function loadAirportCoords() {
  try {
    const res = await fetch('/airports.json');
    if (!res.ok) throw new Error(`airports.json ${res.status}`);
    airportCoords = await res.json();
  } catch {
    airportCoords = {}; // ETA will fall back to "--:--" for every row
  }
}

const EARTH_RADIUS_NM = 3440.065;

function greatCircleNm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const ETA_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Estimated arrival time in EST/EDT ("14:32"), or "--:--" if it can't be computed. */
function estimateArrival(ac, destinationIata) {
  const dest = airportCoords && airportCoords[destinationIata];
  const gs = ac.gs;
  if (!dest || !gs || gs < 30 || ac.lat == null || ac.lon == null) return '--:--';
  const distNm = greatCircleNm(ac.lat, ac.lon, dest.lat, dest.lon);
  const etaHours = distNm / gs;
  if (!Number.isFinite(etaHours) || etaHours > 20) return '--:--'; // sanity cap
  const etaDate = new Date(Date.now() + etaHours * 3600 * 1000);
  return ETA_TIME_FORMAT.format(etaDate);
}

// ---------------- Route cache ----------------

const routeCache = new Map(); // callsign -> { data: routeInfoOrNull, ts }

async function resolveRoute(callsign) {
  const cached = routeCache.get(callsign);
  if (cached && Date.now() - cached.ts < CONFIG.ROUTE_CACHE_TTL_MS) {
    return cached.data;
  }
  try {
    const res = await fetch(`/api/route?callsign=${encodeURIComponent(callsign)}`);
    if (!res.ok) throw new Error(`route lookup ${res.status}`);
    const json = await res.json();
    const fr = json && json.response && json.response.flightroute;
    const data = fr
      ? {
          airline: (fr.airline && fr.airline.name) || 'UNKNOWN',
          countryIso: fr.airline && fr.airline.country_iso,
          origin: (fr.origin && fr.origin.iata_code) || '---',
          destination: (fr.destination && fr.destination.iata_code) || '---',
        }
      : null;
    routeCache.set(callsign, { data, ts: Date.now() });
    return data;
  } catch {
    // Don't cache network failures — only cache confirmed "no route" results.
    return null;
  }
}

// ---------------- Position fetch + filtering ----------------

async function fetchPositions() {
  const res = await fetch(`/api/adsb?lat=${CONFIG.LAT}&lon=${CONFIG.LON}&radius=${CONFIG.RADIUS_NM}`);
  if (!res.ok) throw new Error(`adsb fetch ${res.status}`);
  const json = await res.json();
  return Array.isArray(json.ac) ? json.ac : [];
}

function looksLikeAirlineCallsign(raw) {
  const flight = (raw || '').trim();
  if (!flight) return false;
  return /^[A-Z]{2,4}\d{1,5}[A-Z]?$/i.test(flight);
}

function filterAndSort(aircraft) {
  return aircraft
    .filter((ac) => ac.alt_baro !== 'ground' && ac.alt_baro !== undefined && ac.alt_baro !== null)
    .filter((ac) => looksLikeAirlineCallsign(ac.flight))
    .map((ac) => ({ ...ac, flight: ac.flight.trim() }))
    .sort((a, b) => (a.dst ?? Infinity) - (b.dst ?? Infinity));
}

/** Build up to MAX_ROWS resolved rows, backfilling from next-nearest when a route fails to resolve. */
async function buildBoard(candidates) {
  const rows = [];
  let i = 0;
  while (rows.length < CONFIG.MAX_ROWS && i < candidates.length) {
    const ac = candidates[i];
    i++;
    const route = await resolveRoute(ac.flight);
    if (!route) continue; // GA / unresolved — drop and backfill from next candidate
    rows.push({
      flight: ac.flight,
      airline: route.airline,
      route: `${route.origin}→${route.destination}`,
      eta: estimateArrival(ac, route.destination),
      isUS: route.countryIso === 'US',
    });
  }
  return rows;
}

// ---------------- 7-segment clock ----------------

const SEGMENTS = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
  '5': 'afgcd', '6': 'afgecd', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
  ' ': '',
};

function buildSevenSegDigit(container) {
  const digit = document.createElement('div');
  digit.className = 'seg-digit';
  const segs = {};
  for (const s of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
    const el = document.createElement('div');
    el.className = `seg seg-${s}`;
    digit.appendChild(el);
    segs[s] = el;
  }
  container.appendChild(digit);
  return {
    set(ch) {
      const on = new Set((SEGMENTS[ch] || '').split(''));
      for (const s of Object.keys(segs)) {
        segs[s].classList.toggle('on', on.has(s));
      }
    },
  };
}

function initClock(container) {
  const h1 = buildSevenSegDigit(container);
  const h2 = buildSevenSegDigit(container);
  const colon = document.createElement('div');
  colon.className = 'seg-colon';
  colon.innerHTML = '<span class="dot"></span><span class="dot"></span>';
  container.appendChild(colon);
  const m1 = buildSevenSegDigit(container);
  const m2 = buildSevenSegDigit(container);

  function tick() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    h1.set(hh[0]);
    h2.set(hh[1]);
    m1.set(mm[0]);
    m2.set(mm[1]);
  }
  tick();
  setInterval(tick, 1000);
}

// ---------------- Board rendering ----------------

class BoardRow {
  constructor(container) {
    this.el = document.createElement('div');
    this.el.className = 'flap-row';
    this.el.innerHTML = `
      <div class="field field-flight"><span class="us-tag">US</span><span class="field-cells"></span></div>
      <div class="field field-airline"></div>
      <div class="field field-route"></div>
      <div class="field field-eta"></div>
    `;
    container.appendChild(this.el);

    this.flightField = new FlapField(this.el.querySelector('.field-flight .field-cells'), FIELD_WIDTHS.flight);
    this.airlineField = new FlapField(this.el.querySelector('.field-airline'), FIELD_WIDTHS.airline);
    this.routeField = new FlapField(this.el.querySelector('.field-route'), FIELD_WIDTHS.route);
    this.etaField = new FlapField(this.el.querySelector('.field-eta'), FIELD_WIDTHS.eta);
  }

  setData(row, onClack) {
    this.el.classList.toggle('is-us', !!(row && row.isUS));
    this.flightField.setValue(row ? row.flight : '', onClack);
    this.airlineField.setValue(row ? row.airline : '', onClack);
    this.routeField.setValue(row ? row.route : '', onClack);
    this.etaField.setValue(row ? row.eta : '', onClack);
  }
}

// ---------------- App bootstrap ----------------

function main() {
  const rowsContainer = document.getElementById('rows');
  const emptyState = document.getElementById('empty-state');
  const reconnectBadge = document.getElementById('reconnect-badge');
  const clockEl = document.getElementById('clock');
  const splash = document.getElementById('splash');
  const tapStart = document.getElementById('tap-start');
  const settingsBtn = document.getElementById('settings-btn');
  const settingsPanel = document.getElementById('settings-panel');
  const intervalOptions = document.getElementById('interval-options');
  const muteToggle = document.getElementById('mute-toggle');

  initClock(clockEl);

  const clack = new ClackPlayer();
  const boardRows = Array.from({ length: CONFIG.MAX_ROWS }, () => new BoardRow(rowsContainer));

  let lastGoodRows = null;
  let backoffMs = CONFIG.BACKOFF_START_MS;
  let pollTimer = null;
  let inBackoff = false;
  let flipIntervalMs = loadFlipInterval();

  function render(rows) {
    emptyState.hidden = rows.length > 0;
    for (let i = 0; i < CONFIG.MAX_ROWS; i++) {
      boardRows[i].setData(rows[i] || null, () => clack.clack());
    }
  }

  async function poll() {
    try {
      const positions = await fetchPositions();
      const candidates = filterAndSort(positions);
      const rows = await buildBoard(candidates);
      lastGoodRows = rows;
      reconnectBadge.hidden = true;
      backoffMs = CONFIG.BACKOFF_START_MS;
      inBackoff = false;
      render(rows);
      pollTimer = setTimeout(poll, flipIntervalMs);
    } catch (err) {
      // Keep showing the last known board; surface only the small reconnect indicator.
      reconnectBadge.hidden = false;
      inBackoff = true;
      if (lastGoodRows) render(lastGoodRows);
      pollTimer = setTimeout(poll, backoffMs);
      backoffMs = Math.min(backoffMs * 2, CONFIG.BACKOFF_MAX_MS);
    }
  }

  // ---- Settings: flip interval + mute ----

  function paintIntervalButtons() {
    intervalOptions.querySelectorAll('button').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.interval) === flipIntervalMs);
    });
  }

  function paintMuteButton() {
    muteToggle.textContent = clack.muted ? 'OFF' : 'ON';
    muteToggle.classList.toggle('active', !clack.muted);
  }

  clack.setMuted(loadMuted());
  paintIntervalButtons();
  paintMuteButton();

  settingsBtn.addEventListener('click', () => {
    settingsPanel.hidden = !settingsPanel.hidden;
  });

  intervalOptions.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-interval]');
    if (!btn) return;
    flipIntervalMs = Number(btn.dataset.interval);
    localStorage.setItem(STORAGE_KEYS.flipInterval, String(flipIntervalMs));
    paintIntervalButtons();
    // Apply immediately, but never interrupt an active reconnect backoff cycle.
    if (!inBackoff && pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, flipIntervalMs);
    }
  });

  muteToggle.addEventListener('click', () => {
    clack.setMuted(!clack.muted);
    localStorage.setItem(STORAGE_KEYS.muted, String(clack.muted));
    paintMuteButton();
  });

  tapStart.addEventListener('click', () => {
    clack.unlock();
    splash.hidden = true;
    document.getElementById('board').removeAttribute('aria-hidden');
    poll();
  }, { once: true });

  // Load in the background — the first poll's ETA column just falls back to
  // "--:--" for the brief window before this resolves.
  loadAirportCoords();
}

document.addEventListener('DOMContentLoaded', main);
