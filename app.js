// app.js — polling loop, filtering/sorting, route enrichment + caching, rendering, resilience.

const CONFIG = {
  DEFAULT_ZIP: '07020',
  DEFAULT_LAT: 40.8256, // Edgewater, NJ — used until a zip resolves, and as a hard fallback
  DEFAULT_LON: -73.9765,
  DEFAULT_RADIUS_MI: 25, // "overhead" search radius for the flip board — user-configurable
  MIN_RADIUS_MI: 1,
  MAX_RADIUS_MI: 50,
  RADIUS_STEP_MI: 1,
  MAP_RADIUS_MI: 100, // the map's fixed zoom extent — unrelated to the search radius above
  DEFAULT_FLIP_INTERVAL_MS: 60000, // how often the board refreshes/flips; user-configurable
  MIN_FLIP_INTERVAL_MS: 15000, // adsb.lol courtesy floor — never poll faster than this
  ROUTE_CACHE_TTL_MS: 15 * 60 * 1000,
  MIN_ROWS: 1,
  MAX_ROWS: 10, // hard cap — the board pre-builds this many row DOM instances
  DEFAULT_ROWS: 5,
  BACKOFF_START_MS: 5000,
  BACKOFF_MAX_MS: 60000,
};

const STORAGE_KEYS = {
  flipInterval: 'overhead:flipIntervalMs',
  muted: 'overhead:muted',
  rowCount: 'overhead:rowCount',
  zip: 'overhead:zip',
  radiusMi: 'overhead:radiusMi',
  mapEnabled: 'overhead:mapEnabled',
};

function loadFlipInterval() {
  const stored = Number(localStorage.getItem(STORAGE_KEYS.flipInterval));
  return stored >= CONFIG.MIN_FLIP_INTERVAL_MS ? stored : CONFIG.DEFAULT_FLIP_INTERVAL_MS;
}

function loadMuted() {
  return localStorage.getItem(STORAGE_KEYS.muted) === 'true';
}

function loadRowCount() {
  const stored = Number(localStorage.getItem(STORAGE_KEYS.rowCount));
  return stored >= CONFIG.MIN_ROWS && stored <= CONFIG.MAX_ROWS ? stored : CONFIG.DEFAULT_ROWS;
}

function loadZip() {
  const stored = localStorage.getItem(STORAGE_KEYS.zip);
  return stored && /^\d{5}$/.test(stored) ? stored : CONFIG.DEFAULT_ZIP;
}

function loadRadiusMi() {
  const stored = Number(localStorage.getItem(STORAGE_KEYS.radiusMi));
  return stored >= CONFIG.MIN_RADIUS_MI && stored <= CONFIG.MAX_RADIUS_MI ? stored : CONFIG.DEFAULT_RADIUS_MI;
}

function loadMapEnabled() {
  const stored = localStorage.getItem(STORAGE_KEYS.mapEnabled);
  return stored === null ? true : stored === 'true'; // default on
}

const MI_PER_NM = 1.15078;

// Current tracking location — mutable, changed via the ZIP setting. Starts at the
// Edgewater default; main() overwrites it once the stored/default zip geocodes.
const trackingLocation = { lat: CONFIG.DEFAULT_LAT, lon: CONFIG.DEFAULT_LON };

// Current "overhead" search radius in miles — mutable, changed via the RADIUS setting.
let searchRadiusMi = CONFIG.DEFAULT_RADIUS_MI;

/** Resolve a 5-digit US ZIP to {lat, lon, label} via the geocode proxy (zippopotam.us). */
async function geocodeZip(zip) {
  const res = await fetch(`/api/geocode?zip=${encodeURIComponent(zip)}`);
  if (!res.ok) throw new Error(`zip not found`);
  const json = await res.json();
  const place = json.places && json.places[0];
  if (!place) throw new Error('zip not found');
  return {
    lat: Number(place.latitude),
    lon: Number(place.longitude),
    label: `${place['place name']}, ${place['state abbreviation']}`.toUpperCase(),
  };
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
          iata: fr.airline && fr.airline.iata,
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

// ---------------- Airline logos ----------------
//
// Neither locked API provides logos. images.kiwi.com is a free, keyless image CDN
// keyed by 2-letter IATA airline code, commonly used by hobby flight projects —
// proxied through /api/logo (same reasoning as the other three upstreams: one
// consistent same-origin fetch path). The proxy also filters out kiwi's "unknown
// airline" placeholder image server-side and returns a plain 404 instead, so an
// unrecognized code just leaves the logo blank.

const logoCache = new Map(); // iata -> objectURL string | null

async function resolveLogo(iata) {
  if (!iata) return null;
  if (logoCache.has(iata)) return logoCache.get(iata);
  try {
    const res = await fetch(`/api/logo?iata=${encodeURIComponent(iata)}`);
    if (!res.ok) {
      logoCache.set(iata, null);
      return null;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    logoCache.set(iata, url);
    return url;
  } catch {
    logoCache.set(iata, null);
    return null;
  }
}

// ---------------- Position fetch + filtering ----------------

async function fetchPositions() {
  const radiusNm = searchRadiusMi / MI_PER_NM;
  const res = await fetch(`/api/adsb?lat=${trackingLocation.lat}&lon=${trackingLocation.lon}&radius=${radiusNm}`);
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

/** Build up to `rowCount` resolved rows, backfilling from next-nearest when a route fails to resolve. */
async function buildBoard(candidates, rowCount) {
  const rows = [];
  let i = 0;
  while (rows.length < rowCount && i < candidates.length) {
    const ac = candidates[i];
    i++;
    const route = await resolveRoute(ac.flight);
    if (!route) continue; // GA / unresolved — drop and backfill from next candidate
    const logoUrl = await resolveLogo(route.iata);
    rows.push({
      flight: ac.flight,
      airline: route.airline,
      route: `${route.origin}→${route.destination}`,
      eta: estimateArrival(ac, route.destination),
      isUS: route.countryIso === 'US',
      logoUrl,
      lat: ac.lat,
      lon: ac.lon,
      track: ac.dir,
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
      <div class="field field-airline"><span class="airline-logo"><img class="airline-logo-img" alt="" /></span><span class="field-cells"></span></div>
      <div class="field field-route"></div>
      <div class="field field-eta"></div>
    `;
    container.appendChild(this.el);

    this.flightField = new FlapField(this.el.querySelector('.field-flight .field-cells'), FIELD_WIDTHS.flight);
    this.airlineField = new FlapField(this.el.querySelector('.field-airline .field-cells'), FIELD_WIDTHS.airline);
    this.routeField = new FlapField(this.el.querySelector('.field-route'), FIELD_WIDTHS.route);
    this.etaField = new FlapField(this.el.querySelector('.field-eta'), FIELD_WIDTHS.eta);
    this.logoImg = this.el.querySelector('.airline-logo-img');
  }

  setData(row, onClack) {
    this.el.classList.toggle('is-us', !!(row && row.isUS));
    this.flightField.setValue(row ? row.flight : '', onClack);
    this.airlineField.setValue(row ? row.airline : '', onClack);
    this.routeField.setValue(row ? row.route : '', onClack);
    this.etaField.setValue(row ? row.eta : '', onClack);
    if (row && row.logoUrl) {
      this.logoImg.src = row.logoUrl;
      this.logoImg.classList.add('is-loaded');
    } else {
      this.logoImg.classList.remove('is-loaded');
      this.logoImg.removeAttribute('src');
    }
  }
}

// ---------------- Map ----------------
//
// Shows the same flights already on the board (still just the ones currently
// overhead, within RADIUS_NM) plotted on a map zoomed out to a MAP_RADIUS_MI-wide
// view of the tracking location — geographic context, not an expanded search.
// Static/non-interactive by design, matching the board's "nothing moves except
// the flip" kiosk philosophy.

const PLANE_PATH_D =
  'M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2.5 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z';

let map = null;
let homeMarker = null;
let radiusCircle = null;
let flightMarkers = new Map(); // flight number -> L.Marker

function milesToLatDegrees(mi) {
  return mi / 69;
}
function milesToLonDegrees(mi, atLat) {
  return mi / (69 * Math.cos((atLat * Math.PI) / 180));
}

function initMap() {
  map = L.map('map', {
    zoomControl: true,
    dragging: true,
    touchZoom: true,
    scrollWheelZoom: true,
    doubleClickZoom: true,
    boxZoom: true,
    keyboard: true,
    attributionControl: true,
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);
  recenterMap();
}

function recenterMap() {
  if (!map) return;
  const dLat = milesToLatDegrees(CONFIG.MAP_RADIUS_MI);
  const dLon = milesToLonDegrees(CONFIG.MAP_RADIUS_MI, trackingLocation.lat);
  map.fitBounds([
    [trackingLocation.lat - dLat, trackingLocation.lon - dLon],
    [trackingLocation.lat + dLat, trackingLocation.lon + dLon],
  ]);

  if (homeMarker) homeMarker.remove();
  homeMarker = L.marker([trackingLocation.lat, trackingLocation.lon], {
    icon: L.divIcon({ className: '', html: '<div class="map-home-dot"></div>', iconSize: [10, 10] }),
  }).addTo(map);

  if (radiusCircle) radiusCircle.remove();
  radiusCircle = L.circle([trackingLocation.lat, trackingLocation.lon], {
    radius: CONFIG.MAP_RADIUS_MI * 1609.34, // miles -> meters
    color: '#2E2E2E',
    weight: 1,
    fill: false,
  }).addTo(map);

  // Container size can change (e.g. settings panel affecting layout); fitBounds
  // needs an accurate size to compute zoom correctly.
  setTimeout(() => map.invalidateSize(), 50);
}

function updateMapFlights(rows) {
  if (!map) return;
  const seen = new Set();
  for (const row of rows) {
    if (row.lat == null || row.lon == null) continue;
    seen.add(row.flight);
    const rotation = row.track != null ? row.track : 0;
    let marker = flightMarkers.get(row.flight);
    if (!marker) {
      const icon = L.divIcon({
        className: 'map-plane-icon',
        html: `<svg viewBox="0 0 24 24"><path d="${PLANE_PATH_D}"/></svg><span class="map-plane-label">${row.flight}</span>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });
      marker = L.marker([row.lat, row.lon], { icon }).addTo(map);
      flightMarkers.set(row.flight, marker);
    } else {
      marker.setLatLng([row.lat, row.lon]);
    }
    const el = marker.getElement();
    if (el) {
      const svg = el.querySelector('svg');
      if (svg) svg.style.transform = `rotate(${rotation}deg)`;
    }
  }
  // Drop markers for flights no longer on the board.
  for (const [flight, marker] of flightMarkers) {
    if (!seen.has(flight)) {
      marker.remove();
      flightMarkers.delete(flight);
    }
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
  const mapToggle = document.getElementById('map-toggle');
  const mapSection = document.getElementById('map-section');
  const rowsMinus = document.getElementById('rows-minus');
  const rowsPlus = document.getElementById('rows-plus');
  const rowsCountLabel = document.getElementById('rows-count');
  const radiusMinus = document.getElementById('radius-minus');
  const radiusPlus = document.getElementById('radius-plus');
  const radiusCountLabel = document.getElementById('radius-count');
  const zipInput = document.getElementById('zip-input');
  const zipSet = document.getElementById('zip-set');
  const zipStatus = document.getElementById('zip-status');
  const eyebrowLocation = document.getElementById('eyebrow-location');

  initClock(clockEl);
  initMap();

  const clack = new ClackPlayer();
  // Pre-build the max possible rows; unused ones stay hidden rather than being
  // created/destroyed each time the row count setting changes.
  const boardRows = Array.from({ length: CONFIG.MAX_ROWS }, () => new BoardRow(rowsContainer));

  let lastGoodRows = null;
  let backoffMs = CONFIG.BACKOFF_START_MS;
  let pollTimer = null;
  let inBackoff = false;
  let flipIntervalMs = loadFlipInterval();
  let rowCount = loadRowCount();
  // Settings changes (zip, radius, row count) all call poll() immediately rather
  // than waiting out the flip interval. Without this guard, clicking a stepper
  // rapidly starts overlapping in-flight poll() calls — each one eventually
  // resolves and schedules its OWN setTimeout(poll, ...), so the polling loop
  // silently multiplies and starts hammering adsb.lol well past its courtesy
  // floor. Every poll() tags itself with the current generation on entry; if a
  // newer call started (and bumped the generation) before this one's awaits
  // resolve, this one is stale and must not render or schedule a follow-up.
  let pollGeneration = 0;

  function applyRowCount() {
    boardRows.forEach((row, i) => {
      row.el.hidden = i >= rowCount;
      row.el.classList.toggle('is-last', i === rowCount - 1);
    });
    rowsCountLabel.textContent = String(rowCount);
    rowsMinus.disabled = rowCount <= CONFIG.MIN_ROWS;
    rowsPlus.disabled = rowCount >= CONFIG.MAX_ROWS;
    // The board is sized to its content, so a row-count change moves the map's
    // scroll position and can change its container's aspect ratio. invalidateSize()
    // alone only repositions tiles at the CURRENT zoom — if the container's size
    // was wrong when the zoom was last computed (e.g. right after page load,
    // before layout settles), that wrong zoom persists and tiles render at the
    // wrong scale. recenterMap() re-runs fitBounds too, so zoom is always
    // recalculated fresh for whatever size the container actually is now.
    if (map) setTimeout(() => recenterMap(), 60);
  }
  applyRowCount();

  function render(rows) {
    emptyState.hidden = rows.length > 0;
    for (let i = 0; i < rowCount; i++) {
      boardRows[i].setData(rows[i] || null, () => clack.clack());
    }
    updateMapFlights(rows);
  }

  async function poll() {
    const myGeneration = ++pollGeneration;
    try {
      const positions = await fetchPositions();
      const candidates = filterAndSort(positions);
      const rows = await buildBoard(candidates, rowCount);
      if (myGeneration !== pollGeneration) return; // superseded — don't render or reschedule
      lastGoodRows = rows;
      reconnectBadge.hidden = true;
      backoffMs = CONFIG.BACKOFF_START_MS;
      inBackoff = false;
      render(rows);
      pollTimer = setTimeout(poll, flipIntervalMs);
    } catch (err) {
      if (myGeneration !== pollGeneration) return; // superseded — don't reschedule
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

  settingsBtn.addEventListener('click', (e) => {
    settingsPanel.hidden = !settingsPanel.hidden;
    e.stopPropagation();
  });

  document.addEventListener('click', (e) => {
    if (!settingsPanel.hidden && !settingsPanel.contains(e.target)) {
      settingsPanel.hidden = true;
    }
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

  // ---- Settings: map on/off (collapsible — reached by scrolling below the
  // always-full-screen board, never squeezed into it) ----

  function paintMapToggle(enabled) {
    mapToggle.textContent = enabled ? 'ON' : 'OFF';
    mapToggle.classList.toggle('active', enabled);
  }

  function setMapEnabled(enabled) {
    localStorage.setItem(STORAGE_KEYS.mapEnabled, String(enabled));
    paintMapToggle(enabled);
    mapSection.hidden = !enabled;
    // Leaflet can't measure a display:none container — recompute (size AND zoom,
    // see the comment in applyRowCount) once it's visible again.
    if (enabled && map) setTimeout(() => recenterMap(), 60);
  }

  const mapEnabled = loadMapEnabled();
  paintMapToggle(mapEnabled);
  mapSection.hidden = !mapEnabled;
  mapToggle.addEventListener('click', () => setMapEnabled(mapSection.hidden));

  function setRowCount(next) {
    rowCount = Math.max(CONFIG.MIN_ROWS, Math.min(CONFIG.MAX_ROWS, next));
    localStorage.setItem(STORAGE_KEYS.rowCount, String(rowCount));
    applyRowCount();
    // A different row count needs a fresh candidate list resolved to match —
    // re-poll now rather than waiting out the current flip interval, unless
    // we're mid-backoff (don't fight the reconnect cycle).
    if (!inBackoff) {
      if (pollTimer) clearTimeout(pollTimer);
      poll();
    }
  }

  rowsMinus.addEventListener('click', () => setRowCount(rowCount - 1));
  rowsPlus.addEventListener('click', () => setRowCount(rowCount + 1));

  function applyRadius() {
    radiusCountLabel.textContent = String(searchRadiusMi);
    radiusMinus.disabled = searchRadiusMi <= CONFIG.MIN_RADIUS_MI;
    radiusPlus.disabled = searchRadiusMi >= CONFIG.MAX_RADIUS_MI;
  }

  function setRadius(next) {
    searchRadiusMi = Math.max(CONFIG.MIN_RADIUS_MI, Math.min(CONFIG.MAX_RADIUS_MI, next));
    localStorage.setItem(STORAGE_KEYS.radiusMi, String(searchRadiusMi));
    applyRadius();
    // A different search radius needs a fresh candidate list — re-poll now, same
    // reasoning as a row-count change.
    if (!inBackoff) {
      if (pollTimer) clearTimeout(pollTimer);
      poll();
    }
  }

  searchRadiusMi = loadRadiusMi();
  applyRadius();
  radiusMinus.addEventListener('click', () => setRadius(searchRadiusMi - CONFIG.RADIUS_STEP_MI));
  radiusPlus.addEventListener('click', () => setRadius(searchRadiusMi + CONFIG.RADIUS_STEP_MI));

  // ---- Settings: tracking location (ZIP) ----

  async function applyZip(zip, persist) {
    try {
      const geo = await geocodeZip(zip);
      trackingLocation.lat = geo.lat;
      trackingLocation.lon = geo.lon;
      eyebrowLocation.textContent = geo.label;
      if (persist) localStorage.setItem(STORAGE_KEYS.zip, zip);
      recenterMap();
      zipStatus.textContent = `LOCATED: ${geo.label}`;
      zipStatus.className = 'settings-status is-ok';
      return true;
    } catch {
      zipStatus.textContent = 'ZIP NOT FOUND';
      zipStatus.className = 'settings-status is-error';
      return false;
    }
  }

  async function handleZipSubmit() {
    const zip = zipInput.value.trim();
    if (!/^\d{5}$/.test(zip)) {
      zipStatus.textContent = 'ENTER A 5-DIGIT US ZIP';
      zipStatus.className = 'settings-status is-error';
      return;
    }
    const ok = await applyZip(zip, true);
    // A relocated board needs a fresh candidate list — re-poll now, same as a
    // row-count change, unless we're mid-backoff.
    if (ok && !inBackoff) {
      if (pollTimer) clearTimeout(pollTimer);
      poll();
    }
  }

  zipSet.addEventListener('click', handleZipSubmit);
  zipInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleZipSubmit();
  });

  const initialZip = loadZip();
  zipInput.value = initialZip;

  tapStart.addEventListener('click', () => {
    clack.unlock();
    splash.hidden = true;
    document.getElementById('board').removeAttribute('aria-hidden');
    poll();
  }, { once: true });

  // Load in the background — the first poll's ETA column just falls back to
  // "--:--" for the brief window before this resolves. Same for the initial
  // ZIP geocode: the board starts at the Edgewater default and updates once
  // (or if) it resolves, rather than blocking the splash on a network call.
  loadAirportCoords();
  applyZip(initialZip, false);
}

document.addEventListener('DOMContentLoaded', main);
